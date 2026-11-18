// 存储层:meta.db(projects + api_keys)+ 每 project 一个 SQLite 文件 data.db。
// 只有 observations 按容量滚动成 observations_N 分区表(1GB/张,编号无限递增);
// traces / sessions / scores 永远是单表。删 project = 删数据目录,零残留。

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TraceRow, ObservationRow, ScoreRow } from "./types";

export interface MetaDb {
  db: Database;
  dataDir: string;
}

// 列名对齐 Litefuse 的 Doris 权威定义:
//   traces  ← packages/shared/doris/migrations/0039_traces_scalar.sql
//   observations(spans) ← 0037_spans.sql(取所需子集,去 Doris 反范式冗余列)
// 差异:SQLite 用 INTEGER ms 存时间;Langfuse 的 input_trim/output_trim
// 在 blob,SQLite 直接存全文并沿用 input/output 命名。
const PROJECT_SCHEMA = `
CREATE TABLE IF NOT EXISTS traces(
  id TEXT PRIMARY KEY,
  start_time INTEGER NOT NULL,          -- epoch ms(= Langfuse start_time)
  end_time INTEGER,
  name TEXT,
  function_id TEXT,          -- AI SDK functionId,如 cappy-agent
  user_id TEXT,
  session_id TEXT,
  release TEXT,
  version TEXT,
  environment TEXT DEFAULT 'default',
  bookmarked INTEGER DEFAULT 0,
  public INTEGER DEFAULT 0,
  tags TEXT,                            -- JSON array
  metadata TEXT,                        -- JSON
  input TEXT,
  output TEXT,
  model TEXT,                           -- 汇总自 GENERATION observation(列表展示用)
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  total_cost REAL,
  status TEXT,                          -- success/error(由 observation level 推导)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_start ON traces(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_user ON traces(user_id);

CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  trace_count INTEGER NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scores(
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL,
  string_value TEXT,
  data_type TEXT,                       -- NUMERIC | CATEGORICAL
  comment TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_trace ON scores(trace_id);
`;

/** observations 分区表定义(编号从 1 开始,无限递增) */
function observationDDL(n: number): string {
  const t = `observations_${n}`;
  return `
CREATE TABLE IF NOT EXISTS ${t}(
  id TEXT PRIMARY KEY,                  -- span_id
  trace_id TEXT NOT NULL,
  parent_id TEXT,                       -- parent_span_id
  type TEXT NOT NULL,                   -- SPAN | GENERATION | TOOL | EVENT
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  completion_start_time INTEGER,        -- TTFT 用(Langfuse 字段)
  name TEXT NOT NULL,
  level TEXT,                           -- DEFAULT | ERROR
  status_message TEXT,
  input TEXT,
  output TEXT,
  model TEXT,                           -- provided_model_name
  model_parameters TEXT,                -- JSON
  usage TEXT,                           -- JSON: {input,output,total,...}
  cost TEXT,                            -- JSON: provided_cost_details
  total_cost REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  metadata TEXT,
  attributes TEXT                       -- OTLP 原始 span attributes(透传)
);
CREATE INDEX IF NOT EXISTS idx_obs_trace_${n} ON ${t}(trace_id);
`;
}

const OBS_COLUMNS = [
  "id", "trace_id", "parent_id", "type", "start_time", "end_time", "completion_start_time",
  "name", "level", "status_message", "input", "output", "model", "model_parameters", "usage",
  "cost", "total_cost", "input_tokens", "output_tokens", "total_tokens", "metadata", "attributes",
] as const;

const SCORE_COLUMNS = [
  "id", "trace_id", "name", "value", "string_value", "data_type", "comment", "created_at",
] as const;

const TRACE_COLUMNS = [
  "id", "start_time", "end_time", "name", "function_id", "user_id", "session_id", "release",
  "version", "environment", "bookmarked", "public", "tags", "metadata", "input", "output",
  "model", "input_tokens", "output_tokens", "total_tokens", "total_cost", "status",
  "created_at", "updated_at",
] as const;

const PARTITION_RE = /^observations_(\d+)$/;

export const PROJECT_DB_FILE = "data.db";
export const DEFAULT_MAX_PARTITIONS = 3;
export const MIN_PARTITIONS = 3; // 保留数下限:防止误设过小把近线数据清光
export const MAX_PARTITIONS = 20; // 同时保留的分区表数量上限(编号本身不封顶)
export const OBSERVATION_PARTITION_MAX_BYTES = 1024 * 1024 * 1024; // 单张 observations 表达 1 GB

export function openMeta(dataDir: string): MetaDb {
  mkdirSync(join(dataDir, "projects"), { recursive: true });
  const db = new Database(join(dataDir, "meta.db"));
  db.run("PRAGMA journal_mode=WAL");
  db.run(`CREATE TABLE IF NOT EXISTS projects(
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`);
  // 兼容旧字段名:max_shards 现在表示 observations 分区保留数量
  const pcols = new Set((db.query("PRAGMA table_info(projects)").all() as any[]).map((r) => r.name));
  if (!pcols.has("max_shards")) db.run("ALTER TABLE projects ADD COLUMN max_shards INTEGER DEFAULT 3");
  db.run(`CREATE TABLE IF NOT EXISTS api_keys(
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    public_key TEXT NOT NULL UNIQUE,
    secret_hash TEXT NOT NULL,
    name TEXT,
    created_at INTEGER NOT NULL)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_keys_project ON api_keys(project_id)`);
  // 清理历史残留:更早版本曾用 settings 表存自动生成的 admin token,现认证走环境变量
  db.run("DROP TABLE IF EXISTS settings");
  return { db, dataDir };
}

// ---------- 单库 + observations 分区 ----------

export interface ObservationPartition {
  n: number;
  name: string;
}

export interface ProjectStore {
  projectId: string;
  dir: string;
  dbPath: string;
  db: Database;
  maxPartitions: number;
  partitions: ObservationPartition[]; // 按 n 升序,最后一个是写入分区
  dbstatOk?: boolean; // undefined = 未探测
}

const storeCache = new Map<string, ProjectStore>();

export function observationTableName(n: number): string {
  return `observations_${n}`;
}

/** 当前写入的 observations 分区 */
export function activeObservationTable(store: ProjectStore): ObservationPartition {
  const p = store.partitions[store.partitions.length - 1];
  if (!p) throw new Error(`project ${store.projectId}: no observations partition`);
  return p;
}

/** observations 分区(新→旧),读取用 */
export function observationTables(store: ProjectStore): ObservationPartition[] {
  return [...store.partitions].reverse();
}

/** 建一张 observations 分区表(含 trace_id 索引)。n 由内部生成,表名安全。 */
export function createObservationPartition(db: Database, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid observation partition number: ${n}`);
  db.exec(observationDDL(n));
}

/** 从 sqlite_schema 发现所有 observations_N 分区,按编号升序 */
export function discoverPartitions(db: Database): ObservationPartition[] {
  const nums = (db.query("SELECT name FROM sqlite_schema WHERE type='table'").all() as any[])
    .map((r) => PARTITION_RE.exec(String(r.name))?.[1])
    .filter((x): x is string => !!x)
    .map(Number)
    .sort((a, b) => a - b);
  return [...new Set(nums)].map((n) => ({ n, name: observationTableName(n) }));
}

/** 读取 project 的分区保留数量(沿用 max_shards 列) */
function readMaxPartitions(meta: MetaDb, projectId: string): number {
  try {
    const row = meta.db.query("SELECT max_shards FROM projects WHERE id=?").get(projectId) as
      | { max_shards: number | null }
      | null;
    return clampPartitions(row?.max_shards ?? DEFAULT_MAX_PARTITIONS);
  } catch {
    return DEFAULT_MAX_PARTITIONS;
  }
}

function clampPartitions(n: unknown): number {
  const raw = Math.floor(Number(n));
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_PARTITIONS;
  return Math.max(MIN_PARTITIONS, Math.min(MAX_PARTITIONS, raw));
}

/** 设置保留分区数;立即删除超出上限的最旧分区。返回生效值 */
export function setMaxPartitions(meta: MetaDb, projectId: string, n: number): number {
  const v = clampPartitions(n);
  meta.db.run("UPDATE projects SET max_shards=? WHERE id=?", [v, projectId]);
  const store = storeCache.get(projectId);
  if (store) {
    store.maxPartitions = v;
    enforcePartitions(store);
  }
  return v;
}

function tableExists(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
}

function ensureTracesColumns(db: Database): void {
  if (!tableExists(db, "traces")) return;
  const cols = new Set((db.query("PRAGMA table_info(traces)").all() as any[]).map((r) => r.name));
  if (!cols.has("function_id")) db.run("ALTER TABLE traces ADD COLUMN function_id TEXT");
}

function openProjectDb(path: string): { db: Database; partitions: ObservationPartition[] } {
  const db = new Database(path);
  db.run("PRAGMA journal_mode=WAL");
  db.exec(PROJECT_SCHEMA);
  ensureTracesColumns(db);
  let partitions = discoverPartitions(db);
  if (!partitions.length) {
    createObservationPartition(db, 1);
    partitions = [{ n: 1, name: observationTableName(1) }];
  }
  return { db, partitions };
}

export function getProjectStore(meta: MetaDb, projectId: string): ProjectStore {
  let store = storeCache.get(projectId);
  if (store) return store;

  const dir = join(meta.dataDir, "projects", projectId);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, PROJECT_DB_FILE);

  if (!existsSync(dbPath)) {
    migrateLegacyProject(meta, projectId, dir, dbPath);
  }
  if (existsSync(dbPath)) cleanupLegacyFiles(meta.dataDir, projectId, dir);

  const { db, partitions } = openProjectDb(dbPath);
  store = {
    projectId,
    dir,
    dbPath,
    db,
    maxPartitions: readMaxPartitions(meta, projectId),
    partitions,
  };
  storeCache.set(projectId, store);
  return store;
}

/** 存储统计(管理页用;只 stat 文件,不跑 dbstat) */
export function storageStats(store: ProjectStore): {
  partitionCount: number;
  totalBytes: number;
  maxPartitions: number;
} {
  return {
    partitionCount: store.partitions.length,
    totalBytes: fileBytes(store.dbPath),
    maxPartitions: store.maxPartitions,
  };
}

/** 文件大小(含 WAL,粗略即可) */
function fileBytes(path: string): number {
  let total = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      total += statSync(path + suffix).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

export function dropProjectDb(meta: MetaDb, projectId: string): void {
  const store = storeCache.get(projectId);
  if (store) {
    try {
      store.db.close();
    } catch {
      /* ignore */
    }
    storeCache.delete(projectId);
  }
  const dir = join(meta.dataDir, "projects", projectId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  // 兼容旧版单文件
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(join(meta.dataDir, "projects", `${projectId}.db${suffix}`));
    } catch {
      /* ignore */
    }
  }
}

// ---------- 分区维护 ----------

function toDropList(store: ProjectStore, limit: number): ObservationPartition[] {
  const drop: ObservationPartition[] = [];
  if (store.partitions.length <= limit) return drop;
  for (let i = 0; i < store.partitions.length - limit; i++) drop.push(store.partitions[i]);
  return drop;
}

/** 无条件把分区数压到 maxPartitions 以内(最旧的先删)。返回被删除的表名 */
export function enforcePartitions(store: ProjectStore): string[] {
  const drop = toDropList(store, store.maxPartitions);
  if (!drop.length) return [];
  const tx = store.db.transaction(() => {
    for (const p of drop) store.db.run(`DROP TABLE IF EXISTS ${p.name}`);
  });
  tx();
  store.partitions = store.partitions.filter((p) => !drop.includes(p));
  return drop.map((p) => p.name);
}

/** observations 分区表 + 其索引的占用字节;dbstat 不可用时返回 null */
function observationPartitionBytes(store: ProjectStore, p: ObservationPartition): number | null {
  if (store.dbstatOk === false) return null;
  try {
    const index = `idx_obs_trace_${p.n}`;
    const row = store.db
      .query("SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name = ? OR name = ?")
      .get(p.name, index) as any;
    store.dbstatOk = true;
    return Number(row?.bytes ?? 0) || 0;
  } catch {
    if (store.dbstatOk === undefined) {
      console.warn(`[storage] project ${store.projectId}: dbstat 不可用,跳过容量检查`);
    }
    store.dbstatOk = false;
    return null;
  }
}

/**
 * 建下一张分区表。若当前表数已达 maxPartitions,在同一个事务里先删最旧分区,
 * 保证表数不会超过上限(DDL 可回滚,建表失败不会丢失旧分区)。
 */
export function rollObservationPartition(store: ProjectStore): {
  n: number;
  name: string;
  dropped: string[];
} {
  const active = activeObservationTable(store);
  const nextN = active.n + 1;
  const drop: ObservationPartition[] = [];
  let kept = [...store.partitions];
  while (kept.length >= store.maxPartitions) {
    drop.push(kept.shift()!);
  }
  const tx = store.db.transaction(() => {
    for (const p of drop) store.db.run(`DROP TABLE IF EXISTS ${p.name}`);
    createObservationPartition(store.db, nextN);
  });
  tx();
  store.partitions = [...kept, { n: nextN, name: observationTableName(nextN) }];
  return { n: nextN, name: observationTableName(nextN), dropped: drop.map((p) => p.name) };
}

/** 容量检查:活动分区(含索引)超过 maxBytes 时滚到下一张表。返回滚动结果或 null */
export function maybeRotateObservations(
  store: ProjectStore,
  maxBytes = OBSERVATION_PARTITION_MAX_BYTES,
): { n: number; name: string; dropped: string[] } | null {
  const active = activeObservationTable(store);
  const bytes = observationPartitionBytes(store, active);
  if (bytes == null || bytes < maxBytes) return null;
  return rollObservationPartition(store);
}

/**
 * 15 分钟维护任务:
 * 1) 无条件做保留检查(表数超过 maxPartitions 就删最旧);
 * 2) 容量检查(活动分区 >= 1GB 就滚新表);
 * 3) 再兜底一次保留检查。
 */
export function maintainProjectStorage(store: ProjectStore): {
  dropped: string[];
  rolled: { n: number; name: string; dropped: string[] } | null;
} {
  const dropped = [...enforcePartitions(store)];
  const rolled = maybeRotateObservations(store);
  dropped.push(...enforcePartitions(store));
  return { dropped, rolled };
}

// ---------- 旧 shard 文件迁移 ----------

function collectLegacySources(dataDir: string, projectId: string, dir: string): string[] {
  const out: string[] = [];
  const shards = readdirSync(dir)
    .map((f) => /^shard-(\d+)\.db$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ n: Number(m[1]), path: join(dir, m[0]) }))
    .sort((a, b) => b.n - a.n); // 新→旧
  out.push(...shards.map((s) => s.path));
  // 更早的单文件格式排在最后(最旧)
  const legacy = join(dataDir, "projects", `${projectId}.db`);
  if (existsSync(legacy)) out.push(legacy);
  return out;
}

function cleanupLegacyFiles(dataDir: string, projectId: string, dir: string): void {
  for (const f of readdirSync(dir)) {
    if (/^shard-\d+\.db(-wal|-shm)?$/.test(f) || /^data\.next\.db(-wal|-shm)?$/.test(f)) {
      try {
        rmSync(join(dir, f), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  const legacy = join(dataDir, "projects", `${projectId}.db`);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(legacy + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function decodeRow(row: any): any {
  const JSON_COLS = ["input", "output", "usage", "cost", "metadata", "model_parameters", "tags", "attributes"];
  const out: any = { ...row };
  for (const c of JSON_COLS) if (c in out) out[c] = unpackJson(out[c]);
  return out;
}

function insertObsRow(db: Database, table: string, row: any): void {
  const cols = OBS_COLUMNS.join(",");
  const ph = OBS_COLUMNS.map(() => "?").join(",");
  db.run(
    `INSERT OR IGNORE INTO ${table}(${cols}) VALUES(${ph})`,
    OBS_COLUMNS.map((c) => row[c] ?? null),
  );
}

function insertScoreRow(db: Database, row: any): void {
  const cols = SCORE_COLUMNS.join(",");
  const ph = SCORE_COLUMNS.map(() => "?").join(",");
  db.run(
    `INSERT OR IGNORE INTO scores(${cols}) VALUES(${ph})`,
    SCORE_COLUMNS.map((c) => row[c] ?? null),
  );
}

function insertTraceRow(db: Database, t: any): void {
  db.run(
    `INSERT OR REPLACE INTO traces(${TRACE_COLUMNS.join(",")}) VALUES(${TRACE_COLUMNS.map(() => "?").join(",")})`,
    [
      t.id, t.start_time, t.end_time ?? null, t.name ?? null, t.function_id ?? null,
      t.user_id ?? null, t.session_id ?? null, t.release ?? null, t.version ?? null,
      t.environment ?? "default", t.bookmarked ?? 0, t.public ?? 0,
      packJson(t.tags), packJson(t.metadata), packJson(t.input), packJson(t.output),
      t.model ?? null, t.input_tokens ?? null, t.output_tokens ?? null, t.total_tokens ?? null,
      t.total_cost ?? null, t.status ?? "success", t.created_at ?? Date.now(), t.updated_at ?? Date.now(),
    ],
  );
}

/**
 * 旧布局(projects/<id>/shard-*.db 或 projects/<id>.db)→ 单库 data.db。
 * 源文件按「新→旧」处理:traces 按 id 合并,observations/scores 同 id 新源优先。
 * 校验数量通过后才 rename + 删除源文件;任何异常都保留源文件。
 */
function migrateLegacyProject(meta: MetaDb, projectId: string, dir: string, dbPath: string): void {
  const sources = collectLegacySources(meta.dataDir, projectId, dir);
  if (!sources.length) return; // 全新 project,openProjectDb 会建空库

  const tmp = join(dir, "data.next.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(tmp + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }

  const dst = new Database(tmp);
  dst.run("PRAGMA journal_mode=WAL");
  dst.exec(PROJECT_SCHEMA);
  ensureTracesColumns(dst);
  createObservationPartition(dst, 1);
  const obsTable = observationTableName(1);

  const srcDbs: Database[] = [];
  const mergedTraces = new Map<string, any>();
  const obsIds = new Set<string>();
  const scoreIds = new Set<string>();
  let traceSourceRows = 0;
  let obsSourceRows = 0;
  let scoreSourceRows = 0;

  try {
    for (const srcPath of sources) {
      const src = new Database(srcPath);
      srcDbs.push(src);
      ensureTracesColumns(src);
      const tx = dst.transaction(() => {
        if (tableExists(src, "traces")) {
          for (const raw of src.query("SELECT * FROM traces").all() as any[]) {
            const id = String(raw.id);
            traceSourceRows++;
            const row = decodeRow(raw);
            const prev = mergedTraces.get(id);
            mergedTraces.set(id, prev ? mergeTraceRows([prev, row]) : row);
          }
        }
        if (tableExists(src, "observations")) {
          for (const raw of src.query("SELECT * FROM observations").all() as any[]) {
            obsSourceRows++;
            const id = String(raw.id);
            if (obsIds.has(id)) continue;
            obsIds.add(id);
            insertObsRow(dst, obsTable, raw);
          }
        }
        if (tableExists(src, "scores")) {
          for (const raw of src.query("SELECT * FROM scores").all() as any[]) {
            scoreSourceRows++;
            const id = String(raw.id);
            if (scoreIds.has(id)) continue;
            scoreIds.add(id);
            insertScoreRow(dst, raw);
          }
        }
      });
      tx();
    }

    const tx = dst.transaction(() => {
      for (const t of mergedTraces.values()) insertTraceRow(dst, t);
      // sessions 从合并后的 traces 重新生成,避免多批/多 shard 重复计数
      dst.run(
        `INSERT OR REPLACE INTO sessions(id,user_id,first_ts,last_ts,trace_count,total_cost,updated_at)
         SELECT session_id, MAX(user_id), MIN(start_time), MAX(start_time), COUNT(*),
                COALESCE(SUM(total_cost),0), COALESCE(MAX(updated_at),?)
         FROM traces WHERE session_id IS NOT NULL GROUP BY session_id`,
        [Date.now()],
      );
    });
    tx();

    const dstTraceCount = Number((dst.query("SELECT COUNT(*) AS c FROM traces").get() as any).c);
    const dstObsCount = Number((dst.query(`SELECT COUNT(*) AS c FROM ${obsTable}`).get() as any).c);
    const dstScoreCount = Number((dst.query("SELECT COUNT(*) AS c FROM scores").get() as any).c);
    if (
      dstTraceCount !== mergedTraces.size ||
      dstObsCount !== obsIds.size ||
      dstScoreCount !== scoreIds.size
    ) {
      throw new Error(
        `migration count mismatch: traces ${dstTraceCount}/${mergedTraces.size}, ` +
          `observations ${dstObsCount}/${obsIds.size}, scores ${dstScoreCount}/${scoreIds.size}`,
      );
    }

    dst.run("PRAGMA wal_checkpoint(TRUNCATE)");
    dst.close();
    for (const s of srcDbs) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    try {
      dst.close();
    } catch {
      /* ignore */
    }
    for (const s of srcDbs) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(tmp + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
    throw e;
  }

  renameSync(tmp, dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      rmSync(tmp + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
  for (const srcPath of sources) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(srcPath + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  console.log(
    `[migrate] project ${projectId}: ${traceSourceRows} rows / ${mergedTraces.size} traces, ` +
      `${obsSourceRows} rows / ${obsIds.size} observations, ${scoreSourceRows} rows / ${scoreIds.size} scores ` +
      `(from ${sources.length} legacy file${sources.length > 1 ? "s" : ""})`,
  );
}

// ---------- 写入 ----------

/** 所有 JSON 列用 zstd 压缩存储,读出时自动解压(兼容旧未压缩文本) */
export function packJson(v: unknown): Buffer | null {
  if (v === undefined || v === null) return null;
  const text = typeof v === "string" ? v : JSON.stringify(v);
  try {
    return Bun.zstdCompressSync(text);
  } catch {
    return Buffer.from(text);
  }
}

export function unpackJson(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  let text: string;
  if (v instanceof Uint8Array) {
    try {
      text = new TextDecoder().decode(Bun.zstdDecompressSync(v));
    } catch {
      // 不是 zstd(可能是旧的未压缩 BLOB),按文本处理
      text = new TextDecoder().decode(v);
    }
  } else {
    text = String(v);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function writeBatch(
  store: ProjectStore,
  batch: Array<{ trace: TraceRow; observations: ObservationRow[]; scores?: ScoreRow[] }>,
): void {
  const db = store.db;
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const { trace, observations, scores } of batch) {
      db.run(
        `INSERT INTO traces(id,start_time,end_time,name,function_id,user_id,session_id,release,version,
          environment,bookmarked,public,tags,metadata,input,output,model,
          input_tokens,output_tokens,total_tokens,total_cost,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
          start_time=MIN(traces.start_time, excluded.start_time),
          end_time=CASE
            WHEN traces.end_time IS NULL THEN excluded.end_time
            WHEN excluded.end_time IS NULL THEN traces.end_time
            ELSE MAX(traces.end_time, excluded.end_time)
          END,
          name=excluded.name,
          function_id=COALESCE(excluded.function_id,traces.function_id),
          user_id=COALESCE(excluded.user_id,traces.user_id),
          session_id=COALESCE(excluded.session_id,traces.session_id),
          release=COALESCE(excluded.release,traces.release),
          version=COALESCE(excluded.version,traces.version),
          environment=CASE
            WHEN excluded.environment IS NULL OR excluded.environment='default'
              THEN COALESCE(traces.environment,'default')
            ELSE excluded.environment
          END,
          input=COALESCE(excluded.input,traces.input), output=COALESCE(excluded.output,traces.output),
          model=COALESCE(excluded.model,traces.model), input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
          total_tokens=excluded.total_tokens, total_cost=excluded.total_cost,
          status=COALESCE(excluded.status, traces.status), updated_at=excluded.updated_at`,
        [
          trace.id,
          trace.timestamp,
          trace.end_time ?? (trace.latency_ms != null ? trace.timestamp + trace.latency_ms : null),
          trace.name,
          trace.function_id ?? null,
          trace.user_id ?? null,
          trace.session_id ?? null,
          trace.release ?? null,
          trace.version ?? null,
          trace.environment ?? "default",
          packJson(trace.tags),
          packJson(trace.metadata),
          packJson(trace.input),
          packJson(trace.output),
          trace.model ?? null,
          trace.input_tokens ?? null,
          trace.output_tokens ?? null,
          trace.total_tokens ?? null,
          trace.total_cost ?? null,
          trace.status ?? "success",
          now,
          now,
        ],
      );
      if (observations.length) {
        // 客户端可能把 observation 指向别的 traceId(跨 trace 引用/客户端 bug):
        // 为这些 trace 补占位行,否则 observation 会因 trace 行不存在而不可见
        for (const o of observations) {
          if (o.trace_id !== trace.id) {
            db.run(
              `INSERT OR IGNORE INTO traces(id,start_time,name,status,created_at,updated_at)
               VALUES(?,?,?,?,?,?)`,
              [o.trace_id, o.start_ts, "unnamed-trace", "success", now, now],
            );
          }
        }
        const table = activeObservationTable(store).name;
        for (const o of observations) {
          db.run(
            `INSERT OR REPLACE INTO ${table}(${OBS_COLUMNS.join(",")})
             VALUES(${OBS_COLUMNS.map(() => "?").join(",")})`,
            [
              o.id, o.trace_id, o.parent_id ?? null, o.type, o.start_ts, o.end_ts ?? null,
              o.completion_start_time ?? null, o.name, o.level ?? "DEFAULT",
              o.status_message ?? null, packJson(o.input), packJson(o.output), o.model ?? null,
              packJson(o.model_parameters), packJson(o.usage), packJson(o.cost), o.total_cost ?? null,
              o.input_tokens ?? null, o.output_tokens ?? null, o.total_tokens ?? null,
              packJson(o.metadata), packJson(o.attributes),
            ],
          );
        }
      }
      for (const s of scores ?? []) {
        db.run(
          `INSERT OR REPLACE INTO scores(id,trace_id,name,value,string_value,data_type,comment,created_at)
           VALUES(?,?,?,?,?,?,?,?)`,
          [s.id, s.trace_id, s.name, s.value ?? null, s.string_value ?? null,
            s.data_type ?? (s.value != null ? "NUMERIC" : "CATEGORICAL"),
            s.comment ?? null, s.created_at ?? now],
        );
      }
      if (trace.session_id) upsertSession(db, trace);
    }
  });
  tx();
}

/** score-only 写入:trace 不存在则补占位行(INSERT OR IGNORE,不覆盖已有状态) */
export function writeScores(store: ProjectStore, scores: ScoreRow[]): void {
  const db = store.db;
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const s of scores) {
      db.run(
        `INSERT OR IGNORE INTO traces(id,start_time,name,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?)`,
        [s.trace_id, s.created_at ?? now, "scored-trace", "success", now, now],
      );
      db.run(
        `INSERT OR REPLACE INTO scores(id,trace_id,name,value,string_value,data_type,comment,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        [s.id, s.trace_id, s.name, s.value ?? null, s.string_value ?? null,
          s.data_type ?? (s.value != null ? "NUMERIC" : "CATEGORICAL"),
          s.comment ?? null, s.created_at ?? now],
      );
    }
  });
  tx();
}

function upsertSession(db: Database, t: TraceRow): void {
  db.run(
    `INSERT INTO sessions(id,user_id,first_ts,last_ts,trace_count,total_cost,updated_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
      first_ts=MIN(sessions.first_ts,excluded.first_ts),
      last_ts=MAX(sessions.last_ts,excluded.last_ts),
      trace_count=sessions.trace_count+1,
      total_cost=sessions.total_cost+COALESCE(excluded.total_cost,0),
      updated_at=excluded.updated_at`,
    [t.session_id, t.user_id ?? null, t.timestamp, t.timestamp, 1, t.total_cost ?? 0, Date.now()],
  );
}

// ---------- 读取(UI 查询用) ----------

export interface TraceListItem {
  id: string;
  session_id: string | null;
  user_id: string | null;
  name: string;
  function_id: string | null;
  ts: number;
  latency_ms: number | null;
  status: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_cost: number | null;
}

/** score-only 写入/REST 缺省名留下的占位名;有真名时优先展示真名(迁移合并用) */
const PLACEHOLDER_TRACE_NAMES = new Set(["scored-trace", "unnamed-trace"]);

function preferName(a: string | null | undefined, b: string | null | undefined): string | null {
  if (a && !PLACEHOLDER_TRACE_NAMES.has(a)) return a;
  if (b && !PLACEHOLDER_TRACE_NAMES.has(b)) return b;
  return a ?? b ?? null;
}

function maxNum(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}

function mergeTags(a: unknown, b: unknown): string[] | null {
  const norm = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
  const out = norm(a);
  for (const t of norm(b)) if (!out.includes(t)) out.push(t);
  return out.length ? out : null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** 迁移用:trace 行合并(rows 新→旧),空字段回填、聚合取大、时间取并集 */
function mergeTraceRows(rows: any[]): any {
  const out = { ...rows[0] };
  for (const older of rows.slice(1)) {
    out.start_time = Math.min(out.start_time, older.start_time);
    if (out.end_time == null) out.end_time = older.end_time ?? null;
    else if (older.end_time != null) out.end_time = Math.max(out.end_time, older.end_time);
    for (const k of ["function_id", "user_id", "session_id", "release", "version", "model", "input", "output"]) {
      if (out[k] == null) out[k] = older[k] ?? null;
    }
    out.environment =
      out.environment && out.environment !== "default"
        ? out.environment
        : (older.environment && older.environment !== "default" ? older.environment : out.environment ?? older.environment ?? "default");
    out.status = out.status === "error" || older.status === "error" ? "error" : (out.status ?? older.status);
    out.bookmarked = out.bookmarked || older.bookmarked ? 1 : 0;
    out.public = out.public || older.public ? 1 : 0;
    out.tags = mergeTags(out.tags, older.tags);
    out.metadata = isPlainObject(out.metadata) && isPlainObject(older.metadata)
      ? { ...older.metadata, ...out.metadata }
      : (out.metadata ?? older.metadata ?? null);
    out.input_tokens = maxNum(out.input_tokens, older.input_tokens);
    out.output_tokens = maxNum(out.output_tokens, older.output_tokens);
    out.total_tokens = maxNum(out.total_tokens, older.total_tokens);
    out.total_cost = maxNum(out.total_cost, older.total_cost);
    out.created_at = Math.min(out.created_at, older.created_at);
    out.updated_at = Math.max(out.updated_at, older.updated_at);
    out.name = preferName(out.name, older.name) ?? out.name;
  }
  return out;
}

interface TraceListRow {
  id: string;
  session_id: string | null;
  user_id: string | null;
  name: string;
  function_id: string | null;
  ts: number;
  end_ts: number | null;
  status: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_cost: number | null;
}

/** 列表聚合校正:用当前页 trace 的 observations 重算,保证与详情页数字一致 */
function recomputeListAggregates(store: ProjectStore, rows: TraceListRow[]): void {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  const seen = new Set<string>();
  const agg = new Map<string, { it: number; ot: number; hasUsage: boolean; cost: number; hasCost: boolean; error: boolean; model: string | null }>();
  for (const p of observationTables(store)) {
    // 分批查询,避免超出 SQLite 变量上限
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const ph = chunk.map(() => "?").join(",");
      const obs = store.db
        .query(`SELECT id,trace_id,type,level,input_tokens,output_tokens,total_cost,model
                FROM ${p.name} WHERE trace_id IN (${ph})`)
        .all(...chunk) as any[];
      for (const o of obs) {
        if (seen.has(o.id)) continue; // 同 id 以新分区的行优先
        seen.add(o.id);
        let a = agg.get(o.trace_id);
        if (!a) {
          a = { it: 0, ot: 0, hasUsage: false, cost: 0, hasCost: false, error: false, model: null };
          agg.set(o.trace_id, a);
        }
        if (o.type === "GENERATION" && (o.input_tokens != null || o.output_tokens != null)) {
          a.hasUsage = true;
          a.it += o.input_tokens ?? 0;
          a.ot += o.output_tokens ?? 0;
        }
        if (o.total_cost != null) { a.hasCost = true; a.cost += o.total_cost; }
        if (o.level === "ERROR") a.error = true;
        if (!a.model && o.model) a.model = o.model;
      }
    }
  }
  for (const r of rows) {
    const a = agg.get(r.id);
    if (!a) continue;
    if (a.hasUsage) { r.input_tokens = a.it || null; r.output_tokens = a.ot || null; }
    if (a.hasCost) r.total_cost = a.cost;
    if (a.error) r.status = "error";
    if (!r.model && a.model) r.model = a.model;
  }
}

/** 解析分页游标:兼容旧纯数字(ts)与新复合格式 "ts:id" */
function parseCursor(c?: string | number): { ts?: number; id?: string } {
  if (c == null) return {};
  if (typeof c === "number") return Number.isFinite(c) ? { ts: c } : {};
  const s = String(c).trim();
  if (!s) return {};
  const i = s.lastIndexOf(":");
  if (i > 0) {
    const ts = Number(s.slice(0, i));
    const id = s.slice(i + 1);
    if (Number.isFinite(ts) && id) return { ts, id };
  }
  const n = Number(s);
  return Number.isFinite(n) ? { ts: n } : {};
}

export function listTraces(
  store: ProjectStore,
  opts: { sessionId?: string; userId?: string; limit?: number; cursor?: string | number },
): { items: TraceListItem[]; nextCursor: string | null } {
  const limit = Math.min(opts.limit ?? 50, 200);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.sessionId) { conds.push("session_id = ?"); params.push(opts.sessionId); }
  if (opts.userId) { conds.push("user_id = ?"); params.push(opts.userId); }
  // 复合游标避免同一毫秒的多条 trace 被跳过;旧纯数字游标仍按 start_time < ts 处理
  const cur = parseCursor(opts.cursor);
  if (cur.id != null && cur.ts != null) {
    conds.push("(start_time < ? OR (start_time = ? AND id < ?))");
    params.push(cur.ts, cur.ts, cur.id);
  } else if (cur.ts != null) {
    conds.push("start_time < ?");
    params.push(cur.ts);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = store.db
    .query(
      `SELECT id,session_id,user_id,name,function_id,start_time AS ts,end_time AS end_ts,
              status,model,input_tokens,output_tokens,total_cost
       FROM traces ${where} ORDER BY start_time DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as TraceListRow[];

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    rows.length = limit;
    const last = rows[rows.length - 1];
    nextCursor = `${last.ts}:${last.id}`;
  }
  // 只对当前页重算(≤200 条),让列表数字与详情一致;无 observations 时保留行上的值
  recomputeListAggregates(store, rows);
  const items: TraceListItem[] = rows.map(({ end_ts, ...r }) => ({
    ...r,
    latency_ms: end_ts != null ? Math.max(0, end_ts - r.ts) : null,
  }));
  return { items, nextCursor };
}

/** 用合并后的 observation 集合校正 trace 级聚合(行上的值可能只覆盖某一批) */
function reconcileTraceWithObservations(trace: any, observations: any[]): void {
  if (!observations.length) return;
  let start = trace.start_time;
  let end = trace.end_time ?? null;
  for (const o of observations) {
    if (o.start_time != null && o.start_time < start) start = o.start_time;
    if (o.end_time != null && (end == null || o.end_time > end)) end = o.end_time;
  }
  trace.start_time = start;
  if (end != null) trace.end_time = end;

  const gens = observations.filter((o) => o.type === "GENERATION");
  if (gens.some((o) => o.input_tokens != null || o.output_tokens != null)) {
    const it = gens.reduce((s, o) => s + (o.input_tokens ?? 0), 0);
    const ot = gens.reduce((s, o) => s + (o.output_tokens ?? 0), 0);
    trace.input_tokens = it || null;
    trace.output_tokens = ot || null;
    trace.total_tokens = it + ot || null;
  }
  const costs = observations.map((o) => o.total_cost).filter((v): v is number => v != null);
  if (costs.length) trace.total_cost = costs.reduce((s, v) => s + v, 0);
  if (observations.some((o) => o.level === "ERROR")) trace.status = "error";
  if (!trace.model) trace.model = gens.map((o) => o.model).find(Boolean) ?? null;
}

export function getTraceDetail(store: ProjectStore, traceId: string) {
  const traceRow = store.db.query("SELECT * FROM traces WHERE id = ?").get(traceId) as any;
  if (!traceRow) return null;
  const trace = decodeRow(traceRow);

  const obsById = new Map<string, any>();
  for (const p of observationTables(store)) {
    const rows = store.db.query(`SELECT * FROM ${p.name} WHERE trace_id = ?`).all(traceId) as any[];
    for (const raw of rows) {
      const row = decodeRow(raw);
      if (!obsById.has(row.id)) obsById.set(row.id, row); // 新分区优先
    }
  }
  const observations = [...obsById.values()].sort((a, b) => a.start_time - b.start_time);
  const scores = (store.db.query("SELECT * FROM scores WHERE trace_id = ?").all(traceId) as any[])
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  reconcileTraceWithObservations(trace, observations);
  return { trace, observations, scores };
}

export function listSessions(
  store: ProjectStore,
  opts: { limit?: number; cursor?: number; q?: string } = {},
): { items: Array<ReturnType<typeof mapSessionRow>>; nextCursor: number | null } {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50) || 50, 1), 500);
  const q = (opts.q ?? "").trim();
  const conds: string[] = ["session_id IS NOT NULL"];
  const params: unknown[] = [];
  if (q) { conds.push("session_id LIKE ?"); params.push(`%${q}%`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  // cursor 作用于 last_ts(= MAX(start_time)),走 HAVING
  const having = opts.cursor != null ? "HAVING MAX(start_time) < ?" : "";
  const havingParams = opts.cursor != null ? [opts.cursor] : [];
  const rows = store.db
    .query(
      `SELECT session_id AS id, MIN(start_time) AS first_ts, MAX(start_time) AS last_ts,
              COUNT(*) AS cnt, COALESCE(SUM(total_cost),0) AS cost, MAX(user_id) AS user_id
       FROM traces ${where}
       GROUP BY session_id
       ${having}
       ORDER BY last_ts DESC
       LIMIT ?`,
    )
    .all(...params, ...havingParams, limit + 1) as any[];
  let nextCursor: number | null = null;
  if (rows.length > limit) {
    rows.length = limit;
    nextCursor = rows[rows.length - 1].last_ts;
  }
  return { items: rows.map(mapSessionRow), nextCursor };
}

function mapSessionRow(r: any) {
  return {
    id: r.id,
    user_id: r.user_id,
    first_ts: r.first_ts,
    last_ts: r.last_ts,
    trace_count: r.cnt,
    trace_count_now: r.cnt,
    total_cost: r.cost,
    updated_at: r.last_ts,
  };
}
