// 迁移:把已有 JSON 文本列用 zstd 压缩成 BLOB,并 VACUUM 回收空间。
// 适配单库 + observations_N 分区表布局;离线脚本,允许 VACUUM(会短暂独占文件)。
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { packJson } from "../src/db";

const projectsDir = join(process.env.MINIFUSE_DATA ?? "./data", "projects");
const PARTITION_RE = /^observations_(\d+)$/;
const OBS_COLS = ["input", "output", "usage", "cost", "metadata", "model_parameters", "attributes"];
const TRACE_COLS = ["tags", "metadata", "input", "output"];

function projectDbs(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(projectsDir)) {
    const dbPath = join(projectsDir, f, "data.db");
    if (existsSync(dbPath)) out.push(dbPath);
  }
  return out;
}

function partitions(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_schema WHERE type='table'").all() as any[])
    .map((r) => String(r.name))
    .filter((n) => PARTITION_RE.test(n))
    .sort(
      (a, b) =>
        Number(a.slice("observations_".length)) - Number(b.slice("observations_".length)),
    );
}

let before = 0;
let after = 0;

for (const path of projectDbs()) {
  const sizeBefore = statSync(path).size;
  const db = new Database(path);
  const targets: { table: string; cols: string[] }[] = [
    ...partitions(db).map((t) => ({ table: t, cols: OBS_COLS })),
    { table: "traces", cols: TRACE_COLS },
  ];

  let total = 0;
  for (const { table, cols } of targets) {
    const selectCols = cols.map((c) => `"${c}"`).join(",");
    const rows = db.query(`SELECT rowid AS rid, ${selectCols} FROM ${table}`).all() as any[];
    const tx = db.transaction(() => {
      for (const r of rows) {
        const sets: string[] = [];
        const vals: any[] = [];
        for (const c of cols) {
          const v = r[c];
          if (typeof v !== "string" || v.length === 0) continue; // 已是 BLOB 或空
          sets.push(`"${c}"=?`);
          vals.push(packJson(v));
          total++;
        }
        if (sets.length) db.run(`UPDATE ${table} SET ${sets.join(",")} WHERE rowid=?`, [...vals, r.rid]);
      }
    });
    tx();
  }

  db.run("VACUUM");
  db.close();
  const sizeAfter = statSync(path).size;
  before += sizeBefore;
  after += sizeAfter;
  console.log(
    `${path}: 压缩 ${total} 个字段, ${(sizeBefore / 1048576).toFixed(2)}MB → ${(sizeAfter / 1048576).toFixed(2)}MB`,
  );
}

console.log(
  `总计: ${(before / 1048576).toFixed(2)}MB → ${(after / 1048576).toFixed(2)}MB` +
    (before ? ` (省 ${(100 - (after / before) * 100).toFixed(0)}%)` : ""),
);
