// 一次性回填:按最新规范化规则,从 observations.attributes 重算可展示字段。
// 适配单库 + observations_N 分区表布局:遍历 projects/<id>/data.db,自动发现全部分区。
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { enrichFromAttrs } from "../src/normalize";
import { unpackJson, packJson } from "../src/db";

const dataDir = process.env.MINIFUSE_DATA ?? "./data";
const projectsDir = join(dataDir, "projects");
const PARTITION_RE = /^observations_(\d+)$/;

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

const unionAll = (tables: string[]) => tables.map((t) => `SELECT * FROM ${t}`).join(" UNION ALL ");

let totalObs = 0;
let dbs = 0;

for (const path of projectDbs()) {
  const db = new Database(path);
  const tables = partitions(db);
  if (!tables.length) {
    db.close();
    continue;
  }

  let updated = 0;
  const tx = db.transaction(() => {
    for (const table of tables) {
      const obs = db
        .query(`SELECT id, trace_id, attributes, type, name FROM ${table} WHERE attributes IS NOT NULL`)
        .all() as any[];
      for (const o of obs) {
        let attrs: any;
        try {
          attrs = unpackJson(o.attributes);
        } catch {
          continue;
        }
        const e = enrichFromAttrs(attrs);
        db.run(
          `UPDATE ${table} SET type=?, name=?, input=COALESCE(?,input), output=COALESCE(?,output),
            usage=COALESCE(?,usage), metadata=COALESCE(?,metadata), model=COALESCE(?,model),
            input_tokens=COALESCE(?,input_tokens), output_tokens=COALESCE(?,output_tokens),
            total_tokens=COALESCE(?,total_tokens)
           WHERE id=?`,
          [
            e.type ?? o.type,
            e.name ?? o.name,
            packJson(e.input), packJson(e.output), packJson(e.usage), packJson(e.metadata),
            e.model ?? null,
            e.input_tokens ?? null,
            e.output_tokens ?? null,
            e.total_tokens ?? null,
            o.id,
          ],
        );
        updated++;
      }
    }

    // 重算 trace 聚合(model / tokens),只处理还缺值的 trace
    const union = unionAll(tables);
    db.run(`UPDATE traces SET
      model = COALESCE(model, (SELECT o.model FROM (${union}) o WHERE o.trace_id=traces.id AND o.model IS NOT NULL LIMIT 1)),
      input_tokens = COALESCE(input_tokens, (SELECT SUM(o.input_tokens) FROM (${union}) o WHERE o.trace_id=traces.id AND o.type='GENERATION')),
      output_tokens = COALESCE(output_tokens, (SELECT SUM(o.output_tokens) FROM (${union}) o WHERE o.trace_id=traces.id AND o.type='GENERATION')),
      total_tokens = COALESCE(total_tokens, (SELECT SUM(o.total_tokens) FROM (${union}) o WHERE o.trace_id=traces.id AND o.type='GENERATION'))
      WHERE model IS NULL OR input_tokens IS NULL OR output_tokens IS NULL OR total_tokens IS NULL`);
  });
  tx();

  // 回填 function_id:从根 observation(或任一有值的)的 attributes 取 ai.telemetry.functionId
  const cols = new Set((db.query("PRAGMA table_info(traces)").all() as any[]).map((r) => r.name));
  if (!cols.has("function_id")) db.run("ALTER TABLE traces ADD COLUMN function_id TEXT");
  const traces = db.query("SELECT id FROM traces WHERE function_id IS NULL").all() as any[];
  let fixed = 0;
  const tx2 = db.transaction(() => {
    for (const t of traces) {
      for (const table of tables) {
        const rows = db
          .query(`SELECT attributes FROM ${table} WHERE trace_id=? AND attributes IS NOT NULL`)
          .all(t.id) as any[];
        let found = false;
        for (const r of rows) {
          try {
            const a: any = unpackJson(r.attributes);
            const fid = a && a["ai.telemetry.functionId"];
            if (fid) {
              db.run("UPDATE traces SET function_id=? WHERE id=?", [fid, t.id]);
              fixed++;
              found = true;
              break;
            }
          } catch {
            /* ignore */
          }
        }
        if (found) break;
      }
    }
  });
  tx2();
  db.close();

  totalObs += updated;
  dbs++;
  console.log(`${path}: obs ${updated}, function_id ${fixed}/${traces.length}`);
}

console.log(`done. observations updated: ${totalObs}, project dbs: ${dbs}`);
