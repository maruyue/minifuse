// 单库 + observations 分区表的回归测试:跨分区合并、分区滚动/保留、旧 shard 迁移。

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openMeta, getProjectStore, writeBatch, getTraceDetail, listTraces, listSessions,
  dropProjectDb, rollObservationPartition, maybeRotateObservations, maintainProjectStorage,
  setMaxPartitions, storageStats, createObservationPartition, observationTableName,
  discoverPartitions, packJson,
} from "./db";

function setupMeta() {
  const dir = mkdtempSync(join(tmpdir(), "minifuse-part-"));
  const meta = openMeta(dir);
  meta.db.run("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", ["p1", "test", Date.now()]);
  return {
    dir,
    meta,
    cleanup: () => {
      dropProjectDb(meta, "p1");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function setup() {
  const ctx = setupMeta();
  const store = getProjectStore(ctx.meta, "p1");
  return { ...ctx, store };
}

const gen = (over: Record<string, unknown>) => ({
  type: "GENERATION" as const,
  level: "DEFAULT",
  ...over,
});

function partitionTables(store: any): string[] {
  return (store.db.query("SELECT name FROM sqlite_schema WHERE type='table'").all() as any[])
    .map((r) => String(r.name))
    .filter((n) => /^observations_\d+$/.test(n));
}

test("跨分区详情:父 span 在旧分区、子 span 在新分区,聚合按 observations 校正", () => {
  const { store, cleanup } = setup();
  try {
    writeBatch(store, [{
      trace: {
        id: "t1", name: "agent-run", timestamp: 1000, end_time: 1100, status: "success",
        model: "claude", input_tokens: 100, output_tokens: 20, total_tokens: 120, total_cost: 0.01,
        session_id: "s1", user_id: "u1", input: "hello",
      },
      observations: [gen({
        id: "a", trace_id: "t1", name: "llm", start_ts: 1000, end_ts: 1100,
        model: "claude", input_tokens: 100, output_tokens: 20, total_tokens: 120, total_cost: 0.01,
      })],
    }]);

    const rolled = rollObservationPartition(store);
    expect(rolled.name).toBe("observations_2");
    expect(store.partitions.map((p) => p.n)).toEqual([1, 2]);

    writeBatch(store, [{
      trace: {
        id: "t1", name: "agent-run", timestamp: 1010, end_time: 1090, status: "success",
        input_tokens: 50, output_tokens: 10, total_tokens: 60, total_cost: 0.02,
        session_id: "s1", user_id: "u1",
      },
      observations: [gen({
        id: "b", trace_id: "t1", parent_id: "a", name: "llm-2", start_ts: 1010, end_ts: 1090,
        model: "claude", input_tokens: 50, output_tokens: 10, total_tokens: 60, total_cost: 0.02,
      })],
    }]);

    const d = getTraceDetail(store, "t1")!;
    expect(d.observations.map((o) => o.id).sort()).toEqual(["a", "b"]);
    expect(d.observations.find((o) => o.id === "b")!.parent_id).toBe("a");
    expect(d.trace.start_time).toBe(1000);
    expect(d.trace.end_time).toBe(1100);
    expect(d.trace.input_tokens).toBe(150);   // 100 + 50
    expect(d.trace.output_tokens).toBe(30);
    expect(d.trace.total_cost).toBeCloseTo(0.03, 10);
    expect(d.trace.input).toBe("hello");

    const list = listTraces(store, {});
    expect(list.items.length).toBe(1);
    expect(list.items[0].input_tokens).toBe(150);
    expect(list.items[0].latency_ms).toBe(100);

    const sessions = listSessions(store).items;
    expect(sessions.length).toBe(1);
    expect(sessions[0].trace_count).toBe(1); // 单 trace 行,不因分区/批次多算
  } finally {
    cleanup();
  }
});

test("三个分区 + 重复 observation:去重取新、token 不重复累加", () => {
  const { store, cleanup } = setup();
  try {
    writeBatch(store, [{
      trace: {
        id: "t3", name: "root-run", timestamp: 1000, end_time: 1200, status: "success",
        environment: "production", tags: ["alpha"], metadata: { envOnly: 1 },
        model: "claude", input_tokens: 100, output_tokens: 20, total_tokens: 120, total_cost: 0.01,
        session_id: "s3", input: { q: "hi" },
      },
      observations: [gen({
        id: "a", trace_id: "t3", name: "llm", start_ts: 1000, end_ts: 1100,
        model: "claude", input_tokens: 100, output_tokens: 20, total_cost: 0.01,
      })],
    }]);
    rollObservationPartition(store);
    writeBatch(store, [{
      trace: {
        id: "t3", name: "root-run", timestamp: 1050, end_time: 1300, status: "success",
        input_tokens: 50, output_tokens: 10, total_tokens: 60, total_cost: 0.02,
      },
      observations: [gen({
        id: "b", trace_id: "t3", parent_id: "a", name: "llm-2", start_ts: 1050, end_ts: 1300,
        model: "claude", input_tokens: 50, output_tokens: 10, total_cost: 0.02, level: "ERROR",
      })],
    }]);
    rollObservationPartition(store);
    writeBatch(store, [{
      trace: {
        id: "t3", name: "root-run", timestamp: 900, end_time: 950, status: "success",
      },
      observations: [
        // 同一 span 在滚动后重发:新分区版本覆盖旧版本,不重复累加
        gen({
          id: "a", trace_id: "t3", name: "llm", start_ts: 1000, end_ts: 1150,
          model: "claude", input_tokens: 120, output_tokens: 24, total_cost: 0.012,
        }),
        { id: "c", trace_id: "t3", parent_id: "b", type: "TOOL", name: "search",
          start_ts: 900, end_ts: 950, level: "DEFAULT" },
      ],
    }]);

    const d = getTraceDetail(store, "t3")!;
    expect(d.observations.map((o) => o.id)).toEqual(["c", "a", "b"]);
    expect(d.observations.find((o) => o.id === "a")!.input_tokens).toBe(120);
    expect(d.trace.input_tokens).toBe(170); // 120 + 50
    expect(d.trace.output_tokens).toBe(34);
    expect(d.trace.total_cost).toBeCloseTo(0.032, 10);
    expect(d.trace.start_time).toBe(900);
    expect(d.trace.end_time).toBe(1300);
    expect(d.trace.status).toBe("error");
    expect(d.trace.model).toBe("claude");
    expect(d.trace.tags).toEqual(["alpha"]);   // 后续批次不覆盖首次写入的 tags
    expect(d.trace.input).toEqual({ q: "hi" });

    const list = listTraces(store, {});
    expect(list.items.length).toBe(1);
    expect(list.items[0].input_tokens).toBe(170);
    expect(list.items[0].status).toBe("error");
    expect(list.items[0].latency_ms).toBe(400);
  } finally {
    cleanup();
  }
});

test("维护任务:分区数超过保留上限时无条件删最旧", () => {
  const { meta, store, cleanup } = setup();
  try {
    // 先把上限调大,造出 5 个分区的"超限现场"
    setMaxPartitions(meta, "p1", 5);
    for (let i = 0; i < 5; i++) {
      writeBatch(store, [{
        trace: {
          id: `m${i}`, name: `m${i}`, timestamp: 1000 + i, end_time: 1100 + i, status: "success",
        },
        observations: [gen({
          id: `mo${i}`, trace_id: `m${i}`, name: "llm", start_ts: 1000 + i, end_ts: 1100 + i,
          input_tokens: 1, output_tokens: 1,
        })],
      }]);
      if (i < 4) rollObservationPartition(store);
    }
    expect(store.partitions.map((p) => p.n)).toEqual([1, 2, 3, 4, 5]);

    // 模拟配置被调小但尚未执行(例如外部改库):维护任务应主动删除
    store.maxPartitions = 3;
    const { dropped, rolled } = maintainProjectStorage(store);
    expect(rolled).toBeNull();
    expect(dropped).toEqual(["observations_1", "observations_2"]);
    expect(store.partitions.map((p) => p.n)).toEqual([3, 4, 5]);
    expect(partitionTables(store).sort()).toEqual(["observations_3", "observations_4", "observations_5"]);

    // 被删分区里的 trace 详情仍可读到 trace 行,但 observations 已不存在
    expect(getTraceDetail(store, "m0")!.observations.length).toBe(0);
    expect(getTraceDetail(store, "m1")!.observations.length).toBe(0);
    expect(getTraceDetail(store, "m4")!.observations.length).toBe(1);

    // clamp:低于 3 抬到 3,高于 20 压到 20;当前 3 个分区均不触发删除
    expect(setMaxPartitions(meta, "p1", 2)).toBe(3);
    expect(store.maxPartitions).toBe(3);
    expect(store.partitions.map((p) => p.n)).toEqual([3, 4, 5]);
    expect(setMaxPartitions(meta, "p1", 500)).toBe(20);
    expect(store.maxPartitions).toBe(20);
    expect(setMaxPartitions(meta, "p1", 3)).toBe(3);
    expect(store.partitions.map((p) => p.n)).toEqual([3, 4, 5]);
  } finally {
    cleanup();
  }
});

test("容量触发滚动:超过阈值建新表,写入落到新分区", () => {
  const { store, cleanup } = setup();
  try {
    writeBatch(store, [{
      trace: { id: "r1", name: "r1", timestamp: 1000, end_time: 1100, status: "success" },
      observations: [gen({
        id: "ro1", trace_id: "r1", name: "llm", start_ts: 1000, end_ts: 1100,
        input_tokens: 1, output_tokens: 1,
      })],
    }]);
    const rolled = maybeRotateObservations(store, 1); // 1 字节阈值,强制触发
    expect(rolled).not.toBeNull();
    expect(rolled!.name).toBe("observations_2");
    expect(store.partitions.map((p) => p.n)).toEqual([1, 2]);

    writeBatch(store, [{
      trace: { id: "r2", name: "r2", timestamp: 2000, end_time: 2100, status: "success" },
      observations: [gen({
        id: "ro2", trace_id: "r2", name: "llm", start_ts: 2000, end_ts: 2100,
        input_tokens: 1, output_tokens: 1,
      })],
    }]);
    const inP1 = (store.db.query("SELECT COUNT(*) c FROM observations_1").get() as any).c;
    const inP2 = (store.db.query("SELECT COUNT(*) c FROM observations_2").get() as any).c;
    expect(inP1).toBe(1);
    expect(inP2).toBe(1);
  } finally {
    cleanup();
  }
});

test("编号跨 999:observations_999 之后继续滚动到 observations_1000", () => {
  const { store, cleanup } = setup();
  try {
    // 模拟已经滚到 999:删掉 1,建 999 并把它设为活动分区
    store.db.run("DROP TABLE observations_1");
    createObservationPartition(store.db, 999);
    store.partitions = [{ n: 999, name: observationTableName(999) }];

    const rolled = maybeRotateObservations(store, 1);
    expect(rolled).not.toBeNull();
    expect(rolled!.name).toBe("observations_1000");
    expect(store.partitions.map((p) => p.n)).toEqual([999, 1000]);

    writeBatch(store, [{
      trace: { id: "n1", name: "n1", timestamp: 1000, end_time: 1100, status: "success" },
      observations: [gen({
        id: "no1", trace_id: "n1", name: "llm", start_ts: 1000, end_ts: 1100,
        input_tokens: 5, output_tokens: 2,
      })],
    }]);
    const inNew = (store.db.query("SELECT COUNT(*) c FROM observations_1000").get() as any).c;
    expect(inNew).toBe(1);
    const found = discoverPartitions(store.db).map((p) => p.n);
    expect(found).toEqual([999, 1000]); // 按数字而不是字符串排序
  } finally {
    cleanup();
  }
});

// ---------- 旧 shard 布局迁移 ----------

const LEGACY_SCHEMA = `
CREATE TABLE traces(
  id TEXT PRIMARY KEY, start_time INTEGER NOT NULL, end_time INTEGER, name TEXT,
  user_id TEXT, session_id TEXT, release TEXT, version TEXT, environment TEXT DEFAULT 'default',
  bookmarked INTEGER DEFAULT 0, public INTEGER DEFAULT 0, tags TEXT, metadata TEXT, input TEXT,
  output TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
  total_cost REAL, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE observations(
  id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT, type TEXT NOT NULL,
  start_time INTEGER NOT NULL, end_time INTEGER, completion_start_time INTEGER, name TEXT NOT NULL,
  level TEXT, status_message TEXT, input TEXT, output TEXT, model TEXT, model_parameters TEXT,
  usage TEXT, cost TEXT, total_cost REAL, input_tokens INTEGER, output_tokens INTEGER,
  total_tokens INTEGER, metadata TEXT, attributes TEXT
);
CREATE TABLE sessions(
  id TEXT PRIMARY KEY, user_id TEXT, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
  trace_count INTEGER NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE scores(
  id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, name TEXT NOT NULL, value REAL, string_value TEXT,
  data_type TEXT, comment TEXT, created_at INTEGER NOT NULL
);
`;

function insertLegacyTrace(db: Database, t: any): void {
  db.run(
    `INSERT INTO traces(id,start_time,end_time,name,user_id,session_id,environment,tags,metadata,
      input,output,model,input_tokens,output_tokens,total_tokens,total_cost,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [t.id, t.start_time, t.end_time, t.name, t.user_id ?? null, t.session_id ?? null,
      t.environment ?? "default", packJson(t.tags), packJson(t.metadata), packJson(t.input),
      packJson(t.output), t.model ?? null, t.input_tokens ?? null, t.output_tokens ?? null,
      t.total_tokens ?? null, t.total_cost ?? null, t.status ?? "success", 1, 1],
  );
}

function insertLegacyObs(db: Database, o: any): void {
  db.run(
    `INSERT INTO observations(id,trace_id,parent_id,type,start_time,end_time,name,level,
      model,input_tokens,output_tokens,total_tokens,total_cost,metadata,attributes)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [o.id, o.trace_id, o.parent_id ?? null, o.type, o.start_time, o.end_time, o.name,
      o.level ?? "DEFAULT", o.model ?? null, o.input_tokens ?? null, o.output_tokens ?? null,
      o.total_tokens ?? null, o.total_cost ?? null, packJson(o.metadata), packJson(o.attributes)],
  );
}

test("迁移:两个旧 shard 文件合并进 data.db,校验后删除旧文件", () => {
  const { meta, dir, cleanup } = setupMeta();
  try {
    const pdir = join(dir, "projects", "p1");
    mkdirSync(pdir, { recursive: true });
    const s1 = new Database(join(pdir, "shard-0001.db"));
    s1.exec(LEGACY_SCHEMA);
    insertLegacyTrace(s1, {
      id: "t1", start_time: 1000, end_time: 1100, name: "agent-run", session_id: "s1",
      user_id: "u1", model: "claude", input_tokens: 100, output_tokens: 20,
      total_tokens: 120, total_cost: 0.01, input: "hello", tags: ["alpha"],
    });
    insertLegacyObs(s1, {
      id: "a", trace_id: "t1", type: "GENERATION", start_time: 1000, end_time: 1100,
      name: "llm", model: "claude", input_tokens: 100, output_tokens: 20,
      total_tokens: 120, total_cost: 0.01,
    });
    s1.close();

    const s2 = new Database(join(pdir, "shard-0002.db"));
    s2.exec(LEGACY_SCHEMA);
    insertLegacyTrace(s2, {
      id: "t1", start_time: 1010, end_time: 1300, name: "agent-run", session_id: "s1",
      user_id: "u1", model: "claude", input_tokens: 50, output_tokens: 10,
      total_tokens: 60, total_cost: 0.02,
    });
    insertLegacyObs(s2, {
      id: "b", trace_id: "t1", parent_id: "a", type: "GENERATION", start_time: 1010,
      end_time: 1300, name: "llm-2", model: "claude", input_tokens: 50, output_tokens: 10,
      total_tokens: 60, total_cost: 0.02, level: "ERROR",
    });
    s2.close();

    const store = getProjectStore(meta, "p1");
    expect(store.partitions.map((p) => p.name)).toEqual(["observations_1"]);
    expect(existsSync(join(pdir, "data.db"))).toBe(true);
    expect(existsSync(join(pdir, "shard-0001.db"))).toBe(false);
    expect(existsSync(join(pdir, "shard-0002.db"))).toBe(false);

    const d = getTraceDetail(store, "t1")!;
    expect(d.observations.map((o) => o.id).sort()).toEqual(["a", "b"]);
    expect(d.trace.input_tokens).toBe(150);
    expect(d.trace.output_tokens).toBe(30);
    expect(d.trace.total_cost).toBeCloseTo(0.03, 10);
    expect(d.trace.status).toBe("error");
    expect(d.trace.input).toBe("hello");
    expect(d.trace.start_time).toBe(1000);
    expect(d.trace.end_time).toBe(1300);

    const list = listTraces(store, {});
    expect(list.items.length).toBe(1);
    expect(list.items[0].input_tokens).toBe(150);

    const sessions = listSessions(store).items;
    expect(sessions.length).toBe(1);
    expect(sessions[0].trace_count).toBe(1);
  } finally {
    cleanup();
  }
});

test("storageStats 与不存在的 trace", () => {
  const { meta, store, cleanup } = setup();
  try {
    const st = storageStats(store);
    expect(st.partitionCount).toBe(1);
    expect(st.maxPartitions).toBe(3);
    expect(st.totalBytes).toBeGreaterThan(0);

    expect(getTraceDetail(store, "nope")).toBeNull();


    setMaxPartitions(meta, "p1", 7);
    expect(storageStats(store).maxPartitions).toBe(7);
  } finally {
    cleanup();
  }
});
