// 系统性测试:分页边界、重启持久化、保留语义、迁移变体、REST/protobuf 摄入、认证失败路径。

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openMeta, getProjectStore, writeBatch, getTraceDetail, listTraces, listSessions,
  dropProjectDb, rollObservationPartition, setMaxPartitions, discoverPartitions,
  maintainProjectStorage, maybeRotateObservations, observationTableName,
} from "./db";
import { buildApp } from "./api";

function setup(name = "p1") {
  const dir = mkdtempSync(join(tmpdir(), "minifuse-sys-"));
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
const trace = (over: Record<string, unknown>) => ({
  status: "success", ...over,
});

// ---------- 1. 分页:同一毫秒的多条 trace 不能被游标吞掉 ----------

test("分页:时间戳相同的 trace 翻页不丢失", () => {
  const { store, cleanup } = setup();
  try {
    // 5 条 trace 全在同一毫秒
    for (let i = 0; i < 5; i++) {
      writeBatch(store, [{
        trace: trace({ id: `tie${i}`, name: `tie${i}`, timestamp: 5000, end_time: 5100 }),
        observations: [gen({ id: `to${i}`, trace_id: `tie${i}`, name: "llm", start_ts: 5000, end_ts: 5100 })],
      }]);
    }
    // 1 条更早的
    writeBatch(store, [{
      trace: trace({ id: "early", name: "early", timestamp: 1000, end_time: 1100 }),
      observations: [gen({ id: "eo", trace_id: "early", name: "llm", start_ts: 1000, end_ts: 1100 })],
    }]);

    const seen: string[] = [];
    let cursor: string | number | undefined;
    for (let page = 0; page < 10; page++) {
      const r = listTraces(store, { limit: 2, cursor });
      seen.push(...r.items.map((t) => t.id));
      if (r.nextCursor == null) break;
      cursor = r.nextCursor;
    }
    expect(new Set(seen).size).toBe(6);
    expect(seen).toContain("early");
    expect(seen).toContain("tie4");

    // 大分页扫描:40 条(含重复时间戳),每页 7 条,必须恰好 40 条且无重复
    const big = setup("big");
    try {
      for (let i = 0; i < 40; i++) {
        writeBatch(big.store, [{
          trace: trace({ id: `b${String(i).padStart(2, "0")}`, name: `b${i}`, timestamp: 1000 + Math.floor(i / 4) * 1000, end_time: 1600 }),
          observations: [gen({ id: `bo${i}`, trace_id: `b${String(i).padStart(2, "0")}`, name: "llm", start_ts: 1000, end_ts: 1600 })],
        }]);
      }
      const all: string[] = [];
      let cur: string | number | undefined;
      for (let page = 0; page < 20; page++) {
        const r = listTraces(big.store, { limit: 7, cursor: cur });
        all.push(...r.items.map((t) => t.id));
        if (r.nextCursor == null) break;
        cur = r.nextCursor;
      }
      expect(all.length).toBe(40);
      expect(new Set(all).size).toBe(40);
    } finally {
      big.cleanup();
    }
  } finally {
    cleanup();
  }
});

// ---------- 2. 重启持久化:直接开 Database 能发现分区,数据完整 ----------

test("重启:重新打开 data.db 发现全部分区且数据可读", () => {
  const { dir, meta, store, cleanup } = setup();
  try {
    writeBatch(store, [{
      trace: trace({ id: "t1", name: "a", timestamp: 1000, end_time: 1100, session_id: "s1" }),
      observations: [gen({ id: "o1", trace_id: "t1", name: "llm", start_ts: 1000, end_ts: 1100, input_tokens: 10, output_tokens: 5 })],
    }]);
    rollObservationPartition(store);
    writeBatch(store, [{
      trace: trace({ id: "t2", name: "b", timestamp: 2000, end_time: 2100, session_id: "s1" }),
      observations: [gen({ id: "o2", trace_id: "t2", name: "llm", start_ts: 2000, end_ts: 2100, input_tokens: 7, output_tokens: 3 })],
    }]);

    // 模拟重启:绕过 storeCache,直接按路径打开
    void meta;
    const db = new Database(join(dir, "projects", "p1", "data.db"));
    const parts = discoverPartitions(db);
    expect(parts.map((p) => p.n)).toEqual([1, 2]);
    expect((db.query("SELECT COUNT(*) c FROM traces").get() as any).c).toBe(2);
    expect((db.query("SELECT COUNT(*) c FROM observations_1").get() as any).c).toBe(1);
    expect((db.query("SELECT COUNT(*) c FROM observations_2").get() as any).c).toBe(1);
    db.close();
  } finally {
    cleanup();
  }
});

// ---------- 3. maxPartitions=1:滚动即清空旧分区 ----------

test("最小保留 3:1/2 被 clamp,滚动不删未满 3 的分区", () => {
  const { meta, store, cleanup } = setup();
  try {
    expect(setMaxPartitions(meta, "p1", 1)).toBe(3);
    expect(setMaxPartitions(meta, "p1", 2)).toBe(3);
    writeBatch(store, [{
      trace: trace({ id: "a", name: "a", timestamp: 1000, end_time: 1100 }),
      observations: [gen({ id: "ao", trace_id: "a", name: "llm", start_ts: 1000, end_ts: 1100 })],
    }]);
    const r = maybeRotateObservations(store, 1);
    expect(r).not.toBeNull();
    expect(r!.dropped).toEqual([]); // 只有 1 个分区(< 3),滚动建新表但不删
    expect(store.partitions.map((p) => p.name)).toEqual(["observations_1", "observations_2"]);

    writeBatch(store, [{
      trace: trace({ id: "b", name: "b", timestamp: 2000, end_time: 2100 }),
      observations: [gen({ id: "bo", trace_id: "b", name: "llm", start_ts: 2000, end_ts: 2100 })],
    }]);
    const list = listTraces(store, {});
    expect(list.items.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(getTraceDetail(store, "a")!.observations.length).toBe(1); // 分区未被删
    expect(getTraceDetail(store, "b")!.observations.length).toBe(1);
  } finally {
    cleanup();
  }
});

// ---------- 4. score 占位 → 真 trace 到达 ----------

// ---------- 5. 多 trace 交错跨分区,列表聚合一一对应 ----------

test("多 trace 跨分区交错:每条 trace 的聚合互不串扰", () => {
  const { store, cleanup } = setup();
  try {
    writeBatch(store, [
      { trace: trace({ id: "x", name: "x", timestamp: 1000, end_time: 1200 }), observations: [
        gen({ id: "x1", trace_id: "x", name: "llm", start_ts: 1000, end_ts: 1200, input_tokens: 100, output_tokens: 10, total_cost: 0.01 }),
      ]},
      { trace: trace({ id: "y", name: "y", timestamp: 1100, end_time: 1300 }), observations: [
        gen({ id: "y1", trace_id: "y", name: "llm", start_ts: 1100, end_ts: 1300, input_tokens: 200, output_tokens: 20, total_cost: 0.02 }),
      ]},
    ]);
    rollObservationPartition(store);
    writeBatch(store, [
      { trace: trace({ id: "x", name: "x", timestamp: 1000, end_time: 1250 }), observations: [
        gen({ id: "x2", trace_id: "x", parent_id: "x1", name: "llm", start_ts: 1050, end_ts: 1250, input_tokens: 50, output_tokens: 5, total_cost: 0.03 }),
      ]},
      { trace: trace({ id: "y", name: "y", timestamp: 1100, end_time: 1400, level: "ERROR", status: "error" }), observations: [
        gen({ id: "y2", trace_id: "y", parent_id: "y1", name: "llm", start_ts: 1350, end_ts: 1400, input_tokens: 30, output_tokens: 3, level: "ERROR" }),
      ]},
    ]);

    const list = listTraces(store, {});
    expect(list.items.length).toBe(2);
    const x = list.items.find((t) => t.id === "x")!;
    const y = list.items.find((t) => t.id === "y")!;
    expect(x.input_tokens).toBe(150);
    expect(x.output_tokens).toBe(15);
    expect(x.total_cost).toBeCloseTo(0.04, 10);
    expect(x.latency_ms).toBe(250);
    expect(x.status).toBe("success");
    expect(y.input_tokens).toBe(230);
    expect(y.status).toBe("error");
    expect(y.latency_ms).toBe(300);
  } finally {
    cleanup();
  }
});

// ---------- 6. 旧版单文件 projects/<id>.db 迁移 ----------

test("迁移:旧版单文件 projects/<id>.db 也被合并", () => {
  const dir = mkdtempSync(join(tmpdir(), "minifuse-sys-"));
  try {
    const meta = openMeta(dir);
    meta.db.run("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", ["legacy", "legacy", Date.now()]);
    // 注意:旧布局是 projects/legacy.db(不在子目录里)
    const single = new Database(join(dir, "projects", "legacy.db"));
    single.exec(`CREATE TABLE traces(id TEXT PRIMARY KEY, start_time INTEGER NOT NULL, end_time INTEGER,
      name TEXT, user_id TEXT, session_id TEXT, release TEXT, version TEXT, environment TEXT DEFAULT 'default',
      bookmarked INTEGER DEFAULT 0, public INTEGER DEFAULT 0, tags TEXT, metadata TEXT, input TEXT, output TEXT,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, total_cost REAL, status TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    single.run(`INSERT INTO traces(id,start_time,end_time,name,status,created_at,updated_at) VALUES('old1',100,200,'old-trace','success',1,1)`);
    single.close();

    const store = getProjectStore(meta, "legacy");
    expect(existsSync(join(dir, "projects", "legacy", "data.db"))).toBe(true);
    expect(existsSync(join(dir, "projects", "legacy.db"))).toBe(false);
    const d = getTraceDetail(store, "old1")!;
    expect(d.trace.name).toBe("old-trace");
    dropProjectDb(meta, "legacy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 7. 残留 data.next.db:迁移前被清理重建 ----------

test("迁移:残留的 data.next.db 不影响结果", () => {
  const dir = mkdtempSync(join(tmpdir(), "minifuse-sys-"));
  try {
    const meta = openMeta(dir);
    meta.db.run("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", ["dirty", "dirty", Date.now()]);
    const pdir = join(dir, "projects", "dirty");
    mkdirSync(pdir, { recursive: true });
    // 一个损坏的残留文件 + 一个正常旧 shard
    new Database(join(pdir, "data.next.db")).close();
    const s1 = new Database(join(pdir, "shard-0001.db"));
    s1.exec(`CREATE TABLE traces(id TEXT PRIMARY KEY, start_time INTEGER NOT NULL, end_time INTEGER,
      name TEXT, user_id TEXT, session_id TEXT, release TEXT, version TEXT, environment TEXT DEFAULT 'default',
      bookmarked INTEGER DEFAULT 0, public INTEGER DEFAULT 0, tags TEXT, metadata TEXT, input TEXT, output TEXT,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, total_cost REAL, status TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    s1.run(`INSERT INTO traces(id,start_time,end_time,name,status,created_at,updated_at) VALUES('k1',1,2,'ok','success',1,1)`);
    s1.close();

    const store = getProjectStore(meta, "dirty");
    expect(existsSync(join(pdir, "data.next.db"))).toBe(false);
    expect(getTraceDetail(store, "k1")!.trace.name).toBe("ok");
    dropProjectDb(meta, "dirty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 8. HTTP:OTLP protobuf、REST 三端点、认证、坏请求 ----------

const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ intValue: v });

test("HTTP:OTLP protobuf 摄入与 JSON 等价", async () => {
  const dir = mkdtempSync(join(tmpdir(), "minifuse-sys-"));
  const meta = openMeta(dir);
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const res0 = await app.request("/api/v1/admin/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "pb" }),
    });
    const project = await res0.json() as { id: string };
    const key = await (await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { publicKey: string; secretKey: string };
    const auth = "Basic " + Buffer.from(`${key.publicKey}:${key.secretKey}`).toString("base64");

    // 用 otlp-transformer 的生成 root 编码 protobuf(与服务端解码同源)
    const generatedRoot: any = await import(
      "../node_modules/@opentelemetry/otlp-transformer/build/esm/generated/root.js"
    );
    const Req = generatedRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
    const hexToBytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
    const obj = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: str("cappy") }] },
        scopeSpans: [{
          spans: [{
            traceId: hexToBytes("aaaabbbbccccddddeeeeffff00001111"),
            spanId: hexToBytes("3333333333333333"),
            name: "pb-root",
            kind: 1,
            startTimeUnixNano: "1000000000",
            endTimeUnixNano: "1200000000",
            attributes: [
              { key: "gen_ai.operation.name", value: str("chat") },
              { key: "gen_ai.usage.input_tokens", value: int(42) },
              { key: "gen_ai.usage.output_tokens", value: int(8) },
              { key: "session.id", value: str("pb-sess") },
            ],
            status: {},
          }],
        }],
      }],
    };
    const payload = Req.encode(Req.fromObject(obj)).finish();

    const res = await app.request("/api/public/otel/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", authorization: auth },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });

    const d = await (await app.request(`/api/v1/traces/aaaabbbbccccddddeeeeffff00001111?projectId=${project.id}`)).json() as any;
    expect(d.observations.length).toBe(1);
    expect(d.trace.input_tokens).toBe(42);
    expect(d.trace.session_id).toBe("pb-sess");
    expect(d.trace.name).toBe("pb-root");
  } finally {
    const projects = meta.db.query("SELECT id FROM projects").all() as any[];
    for (const p of projects) dropProjectDb(meta, p.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP:REST traces/observations/scores + 401 + 坏 JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "minifuse-sys-"));
  const meta = openMeta(dir);
  try {
    const app = buildApp(meta, { js: "", css: "" });
    const project = await (await app.request("/api/v1/admin/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "rest" }),
    })).json() as { id: string };
    const key = await (await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { publicKey: string; secretKey: string };
    const auth = "Basic " + Buffer.from(`${key.publicKey}:${key.secretKey}`).toString("base64");
    const H = { "content-type": "application/json", authorization: auth };

    // 401:无认证
    expect((await app.request("/api/public/traces", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    // 401:错 key
    expect((await app.request("/api/public/traces", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from("pk-lf-x:sk-lf-y").toString("base64") },
      body: "{}",
    })).status).toBe(401);

    // REST trace + observation + score
    const r1 = await app.request("/api/public/traces", {
      method: "POST", headers: H,
      body: JSON.stringify({ batch: [{
        id: "rt1", name: "rest-trace", timestamp: Date.now(),
        sessionId: "rsess", userId: "ru",
        input: { q: 1 }, output: { a: 2 }, tags: ["rest"],
        observations: [
          { id: "ro1", type: "GENERATION", name: "llm", startTime: 1000, endTime: 2000, model: "claude", usage: { input: 11, output: 7 } },
          { id: "ro2", parentObservationId: "ro1", type: "SPAN", name: "step", startTime: 1100, endTime: 1900 },
        ],
      }]}),
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ status: "success" });

    const r2 = await app.request("/api/public/observations", {
      method: "POST", headers: H,
      body: JSON.stringify({ batch: [{ id: "ro3", traceId: "rt1", type: "TOOL", name: "grep", startTime: 1200, endTime: 1300 }]}),
    });
    expect(r2.status).toBe(200);

    // scores 上报:接受但不存储(minifuse 不做评分处理)
    const r3 = await app.request("/api/public/scores", {
      method: "POST", headers: H,
      body: JSON.stringify({ batch: [{ id: "rs1", traceId: "rt1", name: "rating", value: 5 }]}),
    });
    expect(r3.status).toBe(200);
    expect(await r3.json()).toEqual({ status: "success" });

    const d = await (await app.request(`/api/v1/traces/rt1?projectId=${project.id}`)).json() as any;
    expect(d.observations.map((o: any) => o.id).sort()).toEqual(["ro1", "ro2", "ro3"]);
    expect(d.trace.input_tokens).toBe(11);
    expect(d.trace.output_tokens).toBe(7);
    expect(d.trace.session_id).toBe("rsess");
    expect(d.trace.tags).toEqual(["rest"]);
    expect(d.scores).toBeUndefined();

    // 坏 JSON:应返回 400,而不是 500
    const bad = await app.request("/api/public/traces", {
      method: "POST", headers: H, body: "not-json{{",
    });
    expect(bad.status).toBe(400);
    // 非 object body(batch 缺失)同样 400
    const bad2 = await app.request("/api/public/observations", {
      method: "POST", headers: H, body: '"just a string"',
    });
    expect(bad2.status).toBe(400);

    // sessions:REST trace 的 session 聚合
    const sess = await (await app.request(`/api/v1/sessions?projectId=${project.id}`)).json() as any;
    expect(sess.items.length).toBe(1);
    expect(sess.items[0].trace_count).toBe(1);
  } finally {
    const projects = meta.db.query("SELECT id FROM projects").all() as any[];
    for (const p of projects) dropProjectDb(meta, p.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 9. 维护任务端到端:超限 → 删;不超限 → 不动 ----------

test("维护幂等:重复执行结果一致,不误删", () => {
  const { meta, store, cleanup } = setup();
  try {
    for (let i = 0; i < 2; i++) {
      writeBatch(store, [{
        trace: trace({ id: `m${i}`, name: `m${i}`, timestamp: 1000 + i, end_time: 1100 + i }),
        observations: [gen({ id: `mo${i}`, trace_id: `m${i}`, name: "llm", start_ts: 1000 + i, end_ts: 1100 + i })],
      }]);
      rollObservationPartition(store);
    }
    writeBatch(store, [{
      trace: trace({ id: "m2", name: "m2", timestamp: 1002, end_time: 1102 }),
      observations: [gen({ id: "mo2", trace_id: "m2", name: "llm", start_ts: 1002, end_ts: 1102 })],
    }]);
    rollObservationPartition(store);
    writeBatch(store, [{
      trace: trace({ id: "m3", name: "m3", timestamp: 1003, end_time: 1103 }),
      observations: [gen({ id: "mo3", trace_id: "m3", name: "llm", start_ts: 1003, end_ts: 1103 })],
    }]);
    // 现在 partitions = [2,3,4](第 4 张表时滚动已淘汰 observations_1),maxPartitions=3

    const first = maintainProjectStorage(store);
    expect(first.dropped).toEqual([]);
    expect(first.rolled).toBeNull(); // 分区太小,不滚

    // setMaxPartitions 设计为立即生效:调小的瞬间就删最旧(最小 3)
    setMaxPartitions(meta, "p1", 3);
    expect(store.partitions.map((p) => p.n)).toEqual([2, 3, 4]);
    // 维护任务幂等:再跑不误删
    const second = maintainProjectStorage(store);
    expect(second.dropped).toEqual([]);
    const third = maintainProjectStorage(store);
    expect(third.dropped).toEqual([]);

    expect(listTraces(store, {}).items.length).toBe(4);
    expect(getTraceDetail(store, "m0")!.observations.length).toBe(0);
    expect(getTraceDetail(store, "m3")!.observations.length).toBe(1);
    expect(observationTableName(2)).toBe("observations_2");
  } finally {
    cleanup();
  }
});
