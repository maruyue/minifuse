// 第三轮:畸形数据防御(自引用/环 parent)、垃圾 protobuf、跨 trace 的 observation、key 空名。

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMeta, getProjectStore, dropProjectDb, writeBatch, getTraceDetail } from "./db";
import { buildApp } from "./api";

function setupCtx() {
  const dir = mkdtempSync(join(tmpdir(), "minifuse-w3-"));
  const meta = openMeta(dir);
  return {
    dir, meta,
    cleanup: () => {
      const ps = meta.db.query("SELECT id FROM projects").all() as any[];
      for (const p of ps) dropProjectDb(meta, p.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function mkProject(app: any, name: string) {
  const project = await (await app.request("/api/v1/admin/projects", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  })).json() as { id: string };
  const key = await (await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  })).json() as { publicKey: string; secretKey: string };
  const auth = "Basic " + Buffer.from(`${key.publicKey}:${key.secretKey}`).toString("base64");
  return { project, auth };
}

const otlp = (spans: any[]) => ({
  resourceSpans: [{ scopeSpans: [{ spans }]}],
});

// ---------- 1. 垃圾 protobuf:应 400 而非 500 ----------

test("OTLP:垃圾字节 → 400,不抛 500", async () => {
  const { meta, cleanup } = setupCtx();
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const { auth } = await mkProject(app, "garbage");
    const res = await app.request("/api/public/otel/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", authorization: auth },
      body: new Uint8Array([0xff, 0xff, 0xff, 0x7f, 0x00, 0x01, 0x02]),
    });
    expect(res.status).toBe(400);
    // 空 body:合法空请求,200
    const empty = await app.request("/api/public/otel/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", authorization: auth },
      body: new Uint8Array(0),
    });
    expect(empty.status).toBe(200);
  } finally {
    cleanup();
  }
});

// ---------- 2. 批内 observation 的 traceId 与 trace 不同:不能变成不可见数据 ----------

test("REST batch:observation 指向别的 traceId → 该 trace 仍可查(obs 不丢)", async () => {
  const { meta, cleanup } = setupCtx();
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const { project, auth } = await mkProject(app, "cross");
    const H = { "content-type": "application/json", authorization: auth };
    const res = await app.request("/api/public/traces", {
      method: "POST", headers: H,
      body: JSON.stringify({ batch: [{
        id: "host-trace", name: "host", timestamp: 1000,
        observations: [
          { id: "h1", traceId: "host-trace", type: "SPAN", name: "own", startTime: 1000, endTime: 1100 },
          // 指向另一个 trace(客户端 bug / 跨 trace 引用)
          { id: "h2", traceId: "other-trace", parentObservationId: "x", type: "SPAN", name: "foreign", startTime: 1050, endTime: 1150 },
        ],
      }]}),
    });
    expect(res.status).toBe(200);

    const d = await (await app.request(`/api/v1/traces/other-trace?projectId=${project.id}`)).json() as any;
    expect(d).toBeTruthy();
    expect(d.observations.length).toBe(1);
    expect(d.observations[0].id).toBe("h2");
    // 宿主 trace 不受影响
    const host = await (await app.request(`/api/v1/traces/host-trace?projectId=${project.id}`)).json() as any;
    expect(host.observations.length).toBe(1);
  } finally {
    cleanup();
  }
});

// ---------- 3. 自引用 / 环 parent:数据保留,读取不 crash ----------

test("自引用 parent_id(span 指向自己):详情可读,parent_id 原样保留", async () => {
  const { meta, cleanup } = setupCtx();
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const { project, auth } = await mkProject(app, "selfloop");
    const H = { "content-type": "application/json", authorization: auth };
    const res = await app.request("/api/public/otel/v1/traces", {
      method: "POST", headers: H,
      body: JSON.stringify(otlp([
        { traceId: "loop0000000000000000000000000000001", spanId: "00000000000000aa",
          parentSpanId: "00000000000000aa", // 自己指向自己
          name: "self-loop", startTimeUnixNano: "1000000000", endTimeUnixNano: "1100000000", attributes: [] },
        { traceId: "loop0000000000000000000000000000001", spanId: "00000000000000bb",
          parentSpanId: "00000000000000cc", // 指向 cc
          name: "cyc-b", startTimeUnixNano: "1000000000", endTimeUnixNano: "1100000000", attributes: [] },
        { traceId: "loop0000000000000000000000000000001", spanId: "00000000000000cc",
          parentSpanId: "00000000000000bb", // cc 又指向 bb → 环
          name: "cyc-c", startTimeUnixNano: "1000000000", endTimeUnixNano: "1100000000", attributes: [] },
      ])),
    });
    expect(res.status).toBe(200);

    const d = await (await app.request(`/api/v1/traces/loop0000000000000000000000000000001?projectId=${project.id}`)).json() as any;
    expect(d.observations.length).toBe(3);
    const self = d.observations.find((o: any) => o.name === "self-loop");
    expect(self.parent_id).toBe("00000000000000aa"); // 数据原样保留,读侧兜底
  } finally {
    cleanup();
  }
});

// ---------- 4. key 空名 → null 而不是 "" ----------

test("key:空字符串名称存为 null", async () => {
  const { meta, cleanup } = setupCtx();
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const { project } = await mkProject(app, "kn");
    const k = await (await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "   " }),
    })).json() as any;
    expect(k.name).toBeNull();
    const row = meta.db.query("SELECT name FROM api_keys WHERE public_key=?").get(k.publicKey) as any;
    expect(row.name).toBeNull();
  } finally {
    cleanup();
  }
});

// ---------- 5. writeBatch 直接注入:parent 环的详情聚合不 crash ----------

test("db 层:手工构造 a↔b 环 observations,getTraceDetail 正常返回", () => {
  const { meta, cleanup } = setupCtx();
  try {
    meta.db.run("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", ["p1", "p1", Date.now()]);
    const store = getProjectStore(meta, "p1");
    writeBatch(store, [{
      trace: { id: "cyc", name: "cyc", timestamp: 1000, end_time: 1100, status: "success" },
      observations: [
        { id: "a", trace_id: "cyc", parent_id: "b", type: "SPAN", name: "a", start_ts: 1000, end_ts: 1100, level: "DEFAULT" },
        { id: "b", trace_id: "cyc", parent_id: "a", type: "SPAN", name: "b", start_ts: 1000, end_ts: 1100, level: "DEFAULT" },
      ],
    }]);
    const d = getTraceDetail(store, "cyc")!;
    expect(d.observations.length).toBe(2);
    expect(d.trace.status).toBe("success");
  } finally {
    cleanup();
  }
});
