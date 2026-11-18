// 边界测试:OTel 语义(exception 事件)、缺失字段、协议变体、参数校验、大 trace、过滤+游标组合。

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectStore, writeBatch, getTraceDetail, listTraces, dropProjectDb, listSessions, openMeta, rollObservationPartition } from "./db";
import { buildApp } from "./api";

function setup(name = "p1") {
  const dir = mkdtempSync(join(tmpdir(), "minifuse-edge-"));
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

const gen = (over: Record<string, unknown>) => ({
  type: "GENERATION" as const, level: "DEFAULT", ...over,
});
const trace = (over: Record<string, unknown>) => ({ status: "success", ...over });

// ---------- 1. OTel 语义:exception 事件应把 span/trace 标为 error ----------

test("OTLP:span 带 exception 事件 → level ERROR、trace status error", async () => {
  const { dir, meta, cleanup } = setup();
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const project = await (await app.request("/api/v1/admin/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "exc" }),
    })).json() as { id: string };
    const key = await (await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { publicKey: string; secretKey: string };
    const auth = "Basic " + Buffer.from(`${key.publicKey}:${key.secretKey}`).toString("base64");

    // status.code=1 (OK) 但带 exception 事件(OTel recordException 的标准做法)
    const body = {
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: "12340000000000000000000000000001",
        spanId: "0000000000000001",
        name: "tool-run",
        startTimeUnixNano: "1000000000",
        endTimeUnixNano: "2000000000",
        status: { code: 1 },
        events: [{ name: "exception", attributes: [
          { key: "exception.type", value: { stringValue: "Error" } },
          { key: "exception.message", value: { stringValue: "connection reset" } },
        ]}],
        attributes: [{ key: "ai.toolCall.name", value: { stringValue: "grep" } }],
      }]}]}],
    };
    const res = await app.request("/api/public/otel/v1/traces", {
      method: "POST", headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);

    const d = await (await app.request(`/api/v1/traces/12340000000000000000000000000001?projectId=${project.id}`)).json() as any;
    expect(d.trace.status).toBe("error");
    expect(d.observations[0].level).toBe("ERROR");
  } finally {
    cleanup();
  }
});

// ---------- 2. 缺 traceId 的 span:不 crash,自成一树 ----------

test("OTLP:缺 traceId 的 span 回退 spanId,不 crash", async () => {
  const { meta, cleanup } = setup();
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const project = await (await app.request("/api/v1/admin/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "notid" }),
    })).json() as { id: string };
    const key = await (await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { publicKey: string; secretKey: string };
    const auth = "Basic " + Buffer.from(`${key.publicKey}:${key.secretKey}`).toString("base64");

    const body = {
      resourceSpans: [{ scopeSpans: [{ spans: [{
        // traceId 缺失
        spanId: "000000000000abcd",
        name: "orphan",
        startTimeUnixNano: "1000000000",
        endTimeUnixNano: "1100000000",
        attributes: [],
      }]}]}],
    };
    const res = await app.request("/api/public/otel/v1/traces", {
      method: "POST", headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);

    const list = await (await app.request(`/api/v1/traces?projectId=${project.id}`)).json() as any;
    expect(list.items.length).toBe(1);
    expect(list.items[0].id).toBe("000000000000abcd"); // traceId = spanId 回退
    const d = await (await app.request(`/api/v1/traces/000000000000abcd?projectId=${project.id}`)).json() as any;
    expect(d.observations.length).toBe(1);
  } finally {
    cleanup();
  }
});

// ---------- 3. REST:ISO 时间戳、顶层数组 batch、字符串数字 usage ----------

test("REST:ISO 时间戳 + 顶层数组 batch + 字符串 usage 数字", async () => {
  const { meta, cleanup } = setup();
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const project = await (await app.request("/api/v1/admin/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "restv" }),
    })).json() as { id: string };
    const key = await (await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { publicKey: string; secretKey: string };
    const auth = "Basic " + Buffer.from(`${key.publicKey}:${key.secretKey}`).toString("base64");
    const H = { "content-type": "application/json", authorization: auth };

    // 顶层数组 + ISO 时间戳 + usage 值为字符串数字
    const res = await app.request("/api/public/traces", {
      method: "POST", headers: H,
      body: JSON.stringify([{
        id: "iso1", name: "iso-trace",
        timestamp: "2026-11-17T10:00:00.000Z",
        observations: [{
          id: "iso1o", traceId: "iso1", type: "GENERATION", name: "llm",
          startTime: "2026-11-17T10:00:01.000Z", endTime: "2026-11-17T10:00:02.500Z",
          model: "claude", usage: { input: "42", output: "7" }, // 字符串数字
        }],
      }]),
    });
    expect(res.status).toBe(200);

    const d = await (await app.request(`/api/v1/traces/iso1?projectId=${project.id}`)).json() as any;
    expect(d.trace.start_time).toBe(Date.parse("2026-11-17T10:00:00.000Z"));
    expect(d.trace.input_tokens).toBe(42); // 字符串数字被解析
    expect(d.trace.output_tokens).toBe(7);
    expect(d.trace.latency_ms ?? (d.trace.end_time - d.trace.start_time)).toBe(2500);
  } finally {
    cleanup();
  }
});

// ---------- 4. score 变体 + 非法 score 被丢弃但不炸 ----------

test("scores:字符串值 CATEGORICAL、非法项被丢弃、占位 trace 可查", async () => {
  const { meta, cleanup } = setup();
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const project = await (await app.request("/api/v1/admin/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "sc" }),
    })).json() as { id: string };
    const key = await (await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { publicKey: string; secretKey: string };
    const auth = "Basic " + Buffer.from(`${key.publicKey}:${key.secretKey}`).toString("base64");
    const H = { "content-type": "application/json", authorization: auth };

    const res = await app.request("/api/public/scores", {
      method: "POST", headers: H,
      body: JSON.stringify({ batch: [
        { id: "s1", traceId: "st1", name: "category", stringValue: "good" }, // 无 value → CATEGORICAL
        { id: "s2", traceId: "st1", name: "stars", value: 4.5 },
        { traceId: "st1" }, // 缺 name → 应被丢弃,不影响其他
        null, // 完全非法
      ]}),
    });
    expect(res.status).toBe(200);

    const d = await (await app.request(`/api/v1/traces/st1?projectId=${project.id}`)).json() as any;
    expect(d.scores.length).toBe(2);
    const cat = d.scores.find((s: any) => s.id === "s1");
    expect(cat.string_value).toBe("good");
    expect(cat.data_type).toBe("CATEGORICAL");
  } finally {
    cleanup();
  }
});

// ---------- 5. PATCH 参数校验与 clamp ----------

test("PATCH maxPartitions:0/负数/非数字 400,超上限 clamp 到 999", async () => {
  const { meta, cleanup } = setup();
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const project = await (await app.request("/api/v1/admin/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "pv" }),
    })).json() as { id: string };

    // 范围外一律 400:非数字 / 0 / 负数 / 低于下限 3 / 高于上限 100
    for (const bad of [0, -5, 1, 2, 21, 100, 5000, "abc", null]) {
      const r = await app.request(`/api/v1/admin/projects/${project.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxPartitions: bad }),
      });
      expect(r.status).toBe(400);
    }
    // 兼容旧字段名 maxShards(3-100 内有效)
    const r1 = await app.request(`/api/v1/admin/projects/${project.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxShards: 5 }),
    });
    expect((await r1.json() as any).maxPartitions).toBe(5);
    // 边界值 3 和 20 均可设置
    const r3 = await app.request(`/api/v1/admin/projects/${project.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxPartitions: 3 }),
    });
    expect((await r3.json() as any).maxPartitions).toBe(3);
    const r100 = await app.request(`/api/v1/admin/projects/${project.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxPartitions: 20 }),
    });
    expect((await r100.json() as any).maxPartitions).toBe(20);
  } finally {
    cleanup();
  }
});

// ---------- 6. sessionId 过滤 × 复合游标 组合分页 ----------

test("sessionId 过滤 + 复合游标:同 session 的 tie 时间戳翻页不丢", () => {
  const { store, cleanup } = setup();
  try {
    for (let i = 0; i < 6; i++) {
      writeBatch(store, [{
        trace: trace({
          id: `f${i}`, name: `f${i}`, timestamp: 7000, end_time: 7100,
          session_id: i < 5 ? "sessA" : "sessB",
        }),
        observations: [gen({ id: `fo${i}`, trace_id: `f${i}`, name: "llm", start_ts: 7000, end_ts: 7100 })],
      }]);
    }
    // sessA 5 条全部同毫秒
    const seen: string[] = [];
    let cursor: string | number | undefined;
    for (let page = 0; page < 10; page++) {
      const r = listTraces(store, { sessionId: "sessA", limit: 2, cursor });
      seen.push(...r.items.map((t) => t.id));
      if (r.nextCursor == null) break;
      cursor = r.nextCursor;
    }
    expect(seen.length).toBe(5);
    expect(seen.every((id) => id.startsWith("f") && id !== "f5")).toBe(true);
  } finally {
    cleanup();
  }
});

// ---------- 7. 大 trace:500 个 observation 完整且可读 ----------

test("大 trace:500 个 observation 全部返回,父子树完整", () => {
  const { store, cleanup } = setup();
  try {
    const obs = Array.from({ length: 500 }, (_, i) => gen({
      id: `big${i}`, trace_id: "big", parent_id: i === 0 ? null : "big0",
      name: `op-${i}`, start_ts: 1000 + i, end_ts: 1500 + i,
      input_tokens: i % 100 === 0 ? 10 : 0, output_tokens: i % 100 === 0 ? 2 : 0,
    }));
    writeBatch(store, [{
      trace: trace({ id: "big", name: "big", timestamp: 1000, end_time: 2000 }),
      observations: obs,
    }]);
    const d = getTraceDetail(store, "big")!;
    expect(d.observations.length).toBe(500);
    expect(d.observations[0].id).toBe("big0");
    expect(d.trace.input_tokens).toBe(50); // 5 个 GENERATION × 10
    const list = listTraces(store, {});
    expect(list.items[0].input_tokens).toBe(50);
  } finally {
    cleanup();
  }
});

// ---------- 8. Unicode/emoji 往返 ----------

test("中文与 emoji 名称/属性完整往返", async () => {
  const { meta, cleanup } = setup();
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const project = await (await app.request("/api/v1/admin/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "uni" }),
    })).json() as { id: string };
    const key = await (await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { publicKey: string; secretKey: string };
    const auth = "Basic " + Buffer.from(`${key.publicKey}:${key.secretKey}`).toString("base64");

    const name = "对话轮次-🎉-测试";
    const body = {
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: "uuuu0000000000000000000000000001",
        spanId: "00000000000000uu",
        name,
        startTimeUnixNano: "1000000000",
        endTimeUnixNano: "1100000000",
        attributes: [
          { key: "langfuse.trace.name", value: { stringValue: name } },
          { key: "custom.中文键", value: { stringValue: "值🚀" } },
        ],
      }]}]}],
    };
    const res = await app.request("/api/public/otel/v1/traces", {
      method: "POST", headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const d = await (await app.request(`/api/v1/traces/uuuu0000000000000000000000000001?projectId=${project.id}`)).json() as any;
    expect(d.trace.name).toBe(name);
    expect(d.observations[0].name).toBe(name);
    expect((d.observations[0].attributes as any)["custom.中文键"]).toBe("值🚀");
  } finally {
    cleanup();
  }
});

// ---------- 9. 重复 spanId:last-wins,不产生重复行 ----------

test("同一批内重复 spanId:last-wins 单行保留", () => {
  const { store, cleanup } = setup();
  try {
    writeBatch(store, [{
      trace: trace({ id: "dup", name: "dup", timestamp: 1000, end_time: 1100 }),
      observations: [
        gen({ id: "same", trace_id: "dup", name: "first", start_ts: 1000, end_ts: 1100, input_tokens: 10, output_tokens: 1 }),
        gen({ id: "same", trace_id: "dup", name: "second", start_ts: 1000, end_ts: 1200, input_tokens: 20, output_tokens: 2 }),
      ],
    }]);
    const d = getTraceDetail(store, "dup")!;
    expect(d.observations.length).toBe(1);
    expect(d.observations[0].name).toBe("second");
    expect(d.trace.input_tokens).toBe(20);
  } finally {
    cleanup();
  }
});

// ---------- 10. sessions/:id 端点 + 空 session trace ----------

test("sessions/:id 返回该 session 的 traces", async () => {
  const { meta, store, cleanup } = setup();
  try {
    void store;
    const app = buildApp(meta, { js: "", css: "" });
    const project = await (await app.request("/api/v1/admin/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "sess" }),
    })).json() as { id: string };
    const st = getProjectStore(meta, project.id);
    for (let i = 0; i < 3; i++) {
      writeBatch(st, [{
        trace: trace({ id: `sv${i}`, name: `sv${i}`, timestamp: 1000 + i, end_time: 1100 + i, session_id: "only-sess" }),
        observations: [gen({ id: `svo${i}`, trace_id: `sv${i}`, name: "llm", start_ts: 1000 + i, end_ts: 1100 + i })],
      }]);
    }
    const r = await (await app.request(`/api/v1/sessions/only-sess?projectId=${project.id}`)).json() as any;
    expect(r.sessionId).toBe("only-sess");
    expect(r.traces.length).toBe(3);
    const l = listSessions(getProjectStore(meta, project.id)).items;
    expect(l[0].trace_count).toBe(3);
  } finally {
    cleanup();
  }
});

// ---------- 11. 分区滚动后写入的 trace 在旧分区有同名 span(跨分区 last-wins 已测,此处测列表过滤) ----------

test("分区滚动后 userId 过滤仍正确", () => {
  const { store, cleanup } = setup();
  try {
    writeBatch(store, [{
      trace: trace({ id: "u1t", name: "u1t", timestamp: 1000, end_time: 1100, user_id: "userX" }),
      observations: [gen({ id: "u1o", trace_id: "u1t", name: "llm", start_ts: 1000, end_ts: 1100 })],
    }]);
    rollObservationPartition(store);
    writeBatch(store, [{
      trace: trace({ id: "u2t", name: "u2t", timestamp: 2000, end_time: 2100, user_id: "userY" }),
      observations: [gen({ id: "u2o", trace_id: "u2t", name: "llm", start_ts: 2000, end_ts: 2100 })],
    }]);
    expect(listTraces(store, { userId: "userX" }).items.map((t) => t.id)).toEqual(["u1t"]);
    expect(listTraces(store, { userId: "userY" }).items.map((t) => t.id)).toEqual(["u2t"]);
    expect(listTraces(store, { userId: "nobody" }).items).toEqual([]);
  } finally {
    cleanup();
  }
});
