// 第四轮:性能突发(千级 span 单批)、深嵌套 JSON 落库、字符串 usage 修复回归。

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMeta, getProjectStore, writeBatch, getTraceDetail, listTraces, dropProjectDb, rollObservationPartition } from "./db";
import { normalizeRestTrace } from "./normalize";
import { buildApp } from "./api";

function setup(name = "p1") {
  const dir = mkdtempSync(join(tmpdir(), "minifuse-w4-"));
  const meta = openMeta(dir);
  meta.db.run("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", [name, name, Date.now()]);
  const store = getProjectStore(meta, name);
  return {
    dir, meta, store,
    cleanup: () => {
      dropProjectDb(meta, name);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("字符串 usage 修复回归:total_tokens = 49 而非 427", () => {
  const { store, cleanup } = setup();
  try {
    const t = normalizeRestTrace({
      id: "st", name: "st", timestamp: 1000,
      observations: [{
        id: "sto", traceId: "st", type: "GENERATION", name: "llm",
        startTime: 1000, endTime: 2000, usage: { input: "42", output: "7" },
      }],
    });
    expect(t.observations[0].total_tokens).toBe(49);
    writeBatch(store, [t]);
    const d = getTraceDetail(store, "st")!;
    expect(d.observations[0].total_tokens).toBe(49);
    expect(d.trace.total_tokens).toBe(49);
  } finally {
    cleanup();
  }
});

test("性能:单批 1000 spans(50 traces)写入与读取", () => {
  const { store, cleanup } = setup();
  try {
    const batch = Array.from({ length: 50 }, (_, ti) => {
      const tid = `perf${ti}`;
      return {
        trace: { id: tid, name: `perf-${ti}`, timestamp: 1000 + ti, end_time: 2000 + ti, status: "success" as const },
        observations: Array.from({ length: 20 }, (_, oi) => ({
          id: `perf${ti}_${oi}`, trace_id: tid,
          parent_id: oi === 0 ? null : `perf${ti}_0`,
          type: (oi === 0 ? "GENERATION" : "SPAN") as any,
          name: `op-${oi}`, start_ts: 1000 + oi, end_ts: 1100 + oi, level: "DEFAULT",
          input: { messages: [{ role: "user", content: "x".repeat(200) }] },
        })),
      };
    });
    const t0 = performance.now();
    writeBatch(store, batch);
    const writeMs = performance.now() - t0;

    const t1 = performance.now();
    const d = getTraceDetail(store, "perf25")!;
    const detailMs = performance.now() - t1;

    const t2 = performance.now();
    const l = listTraces(store, { limit: 50 });
    const listMs = performance.now() - t2;

    expect(d.observations.length).toBe(20);
    expect(l.items.length).toBe(50);
    console.log(`perf: write ${writeMs.toFixed(0)}ms, detail ${detailMs.toFixed(0)}ms, list ${listMs.toFixed(0)}ms`);
    expect(writeMs).toBeLessThan(5000);
    expect(detailMs).toBeLessThan(500);
    expect(listMs).toBeLessThan(2000);
  } finally {
    cleanup();
  }
});

test("深嵌套 JSON(300 层)落库与读取不 crash", () => {
  const { store, cleanup } = setup();
  try {
    // 构造 300 层单键嵌套:JvNode 默认展开单键对象,渲染递归深
    let deep: any = { leaf: "bottom" };
    for (let i = 0; i < 300; i++) deep = { a: deep };
    writeBatch(store, [{
      trace: { id: "deep", name: "deep", timestamp: 1000, end_time: 1100, status: "success", input: deep },
      observations: [{
        id: "deepo", trace_id: "deep", type: "GENERATION", name: "llm",
        start_ts: 1000, end_ts: 1100, level: "DEFAULT", input: deep,
      }],
    }]);
    const d = getTraceDetail(store, "deep")!;
    // 往返 300 层完整性:逐层下钻验证
    let cur: any = d.trace.input;
    let depth = 0;
    while (cur && typeof cur === "object" && "a" in cur) { cur = cur.a; depth++; }
    expect(depth).toBe(300);
    expect(cur).toEqual({ leaf: "bottom" });
  } finally {
    cleanup();
  }
});

test("分区滚动后跨分区 trace 的 detail 延迟仍可控(500 obs 均匀分布)", () => {
  const { store, cleanup } = setup();
  try {
    for (let p = 0; p < 3; p++) {
      writeBatch(store, [{
        trace: { id: "spread", name: "spread", timestamp: 1000, end_time: 9000, status: "success" },
        observations: Array.from({ length: 170 }, (_, i) => ({
          id: `s${p}_${i}`, trace_id: "spread", parent_id: null,
          type: "SPAN" as any, name: `op-${p}-${i}`,
          start_ts: 1000 + p * 1000 + i, end_ts: 1050 + p * 1000 + i, level: "DEFAULT",
        })),
      }]);
      if (p < 2) rollObservationPartition(store);
    }
    const t0 = performance.now();
    const d = getTraceDetail(store, "spread")!;
    const ms = performance.now() - t0;
    expect(d.observations.length).toBe(510);
    console.log(`perf: cross-partition detail(510 obs, 3 partitions) ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(500);
  } finally {
    cleanup();
  }
});

test("HTTP:整链路 OTLP 大批量(200 spans)单请求", async () => {
  const { meta, cleanup } = setup("bulkmeta");
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const project = await (await app.request("/api/v1/admin/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "bulk" }),
    })).json() as { id: string };
    const key = await (await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { publicKey: string; secretKey: string };
    const auth = "Basic " + Buffer.from(`${key.publicKey}:${key.secretKey}`).toString("base64");

    const spans = Array.from({ length: 200 }, (_, i) => ({
      traceId: (String(Math.floor(i / 10)).padStart(4, "0") + "0".repeat(28)),
      spanId: String(0x1000 + i).padStart(16, "0"),
      name: `op-${i}`,
      startTimeUnixNano: String(1000000000 + i),
      endTimeUnixNano: String(1100000000 + i),
      attributes: [{ key: "gen_ai.usage.input_tokens", value: { intValue: 10 } }],
    }));
    const t0 = performance.now();
    const res = await app.request("/api/public/otel/v1/traces", {
      method: "POST", headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
    });
    const ingestMs = performance.now() - t0;
    expect(res.status).toBe(200);
    const l = await (await app.request(`/api/v1/traces?projectId=${project.id}&limit=50`)).json() as any;
    expect(l.items.length).toBe(20); // 200 spans / 10 per trace
    console.log(`perf: OTLP 200-span ingest+respond ${ingestMs.toFixed(0)}ms`);
    expect(ingestMs).toBeLessThan(5000);
  } finally {
    cleanup();
  }
});
