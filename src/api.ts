// HTTP API:Hono 路由 + Langfuse 兼容认证(Basic pk:sk)。
// 默认监听 0.0.0.0:摄入端点(pk/sk)对外安全;管理端点默认无认证,
// 设置 MINIFUSE_ADMIN_TOKEN 后管理端点启用 Bearer 认证。

import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { MetaDb } from "./db";
import {
  getProjectStore, writeBatch, writeScores, listTraces, getTraceDetail, listSessions,
  dropProjectDb, setMaxPartitions, storageStats, MIN_PARTITIONS, MAX_PARTITIONS, type ProjectStore,
} from "./db";
import { decodeOtlp } from "./ingest/otlp";
import { normalizeOtlp, normalizeRestTrace, normalizeRestScore, newId } from "./normalize";

export interface AppEnv {
  Variables: { projectId: string; store: ProjectStore; meta: MetaDb };
}

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function publicKeyAuth(meta: MetaDb) {
  return async (c: any, next: () => Promise<void>) => {
    const header = c.req.header("authorization") ?? "";
    const m = /^Basic\s+(.+)$/i.exec(header);
    if (!m) return c.json({ error: "Unauthorized", message: "Missing Basic auth (pk-lf-… as user, sk-lf-… as password)" }, 401);
    let [pk, sk] = ["", ""];
    try {
      const decoded = atob(m[1]);
      const idx = decoded.indexOf(":");
      pk = decoded.slice(0, idx);
      sk = decoded.slice(idx + 1);
    } catch {
      return c.json({ error: "Unauthorized", message: "Malformed Basic auth" }, 401);
    }
    const row = meta.db
      .query("SELECT project_id, secret_hash FROM api_keys WHERE public_key = ?")
      .get(pk) as { project_id: string; secret_hash: string } | null;
    if (!row || row.secret_hash !== sha256(sk)) {
      return c.json({ error: "Unauthorized", message: "Invalid public/secret key pair" }, 401);
    }
    c.set("projectId", row.project_id);
    c.set("store", getProjectStore(meta, row.project_id));
    await next();
  };
}

/** 可选管理认证:adminToken 非空时启用 Bearer 校验 */
function optionalAdminAuth(adminToken: string | null) {
  return async (c: any, next: () => Promise<void>) => {
    if (!adminToken) return next();
    const header = c.req.header("authorization") ?? "";
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? c.req.query("admin_token");
    if (token !== adminToken) return c.json({ error: "Unauthorized", message: "Invalid admin token" }, 401);
    await next();
  };
}

export function buildApp(
  meta: MetaDb,
  uiAssets: { js: string; css: string },
  opts?: { adminToken?: string | null },
) {
  const app = new Hono<AppEnv>();
  const pkAuth = publicKeyAuth(meta);

  // ---------- Langfuse 兼容摄入 ----------
  app.post("/api/public/otel/v1/traces", pkAuth, async (c) => {
    const body = await c.req.arrayBuffer();
    let spans;
    try {
      spans = decodeOtlp(body, c.req.header("content-type") ?? "");
    } catch {
      return c.json({ error: "Malformed OTLP payload" }, 400);
    }
    const batch = normalizeOtlp(spans);
    writeBatch(c.get("store"), batch.traces);
    return c.json({ partialSuccess: {} }); // Langfuse OTLP 端点兼容响应
  });

  /** 摄入端点共用:解析 JSON body,坏格式返回 400 而不是抛 500 */
  async function ingestBody(c: any): Promise<any[] | null> {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      payload = null;
    }
    if (payload === null || typeof payload !== "object") return null;
    const items = Array.isArray(payload) ? payload : (payload as any).batch;
    return Array.isArray(items) ? items : null;
  }

  app.post("/api/public/traces", pkAuth, async (c) => {
    const items = await ingestBody(c);
    if (!items) return c.json({ error: "Invalid JSON body" }, 400);
    const batch = items.map(normalizeRestTrace);
    writeBatch(c.get("store"), batch);
    return c.json({ status: "success" });
  });

  app.post("/api/public/observations", pkAuth, async (c) => {
    const items = await ingestBody(c);
    if (!items) return c.json({ error: "Invalid JSON body" }, 400);
    const batch = items.map((o) => {
      const t = normalizeRestTrace({ id: o.traceId, name: o.name ?? o.type ?? "observation", observations: [o] });
      return t;
    });
    writeBatch(c.get("store"), batch);
    return c.json({ status: "success" });
  });

  app.post("/api/public/scores", pkAuth, async (c) => {
    const items = await ingestBody(c);
    if (!items) return c.json({ error: "Invalid JSON body" }, 400);
    const scores = items.map(normalizeRestScore).filter(Boolean);
    if (scores.length) writeScores(c.get("store"), scores);
    return c.json({ status: "success" });
  });

  // ---------- 管理 API(默认无认证;MINIFUSE_ADMIN_TOKEN 可选启用) ----------
  const admin = new Hono();
  admin.use("*", optionalAdminAuth(opts?.adminToken ?? null));

  admin.get("/projects", (c) => {
    const rows = meta.db
      .query(`SELECT p.*, (SELECT COUNT(*) FROM api_keys k WHERE k.project_id = p.id) AS key_count
              FROM projects p ORDER BY p.created_at DESC`)
      .all() as any[];
    const withStats = rows.map((p) => {
      const st = storageStats(getProjectStore(meta, p.id));
      return {
        ...p,
        max_partitions: p.max_shards ?? st.maxPartitions,
        max_shards: p.max_shards ?? st.maxPartitions, // 兼容旧 UI
        storage: st,
      };
    });
    return c.json({ projects: withStats });
  });

  // 设置保留的 observations 分区数(3-100)
  admin.patch("/projects/:id", async (c) => {
    const pid = resolveProjectId(meta, c.req.param("id"));
    if (!pid) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const raw = (body as any).maxPartitions ?? (body as any).maxShards;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < MIN_PARTITIONS || n > MAX_PARTITIONS) {
      return c.json({ error: `maxPartitions must be between ${MIN_PARTITIONS} and ${MAX_PARTITIONS}` }, 400);
    }
    const applied = setMaxPartitions(meta, pid, n);
    getProjectStore(meta, pid); // 确保已加载后立即生效
    return c.json({ maxPartitions: applied, storage: storageStats(getProjectStore(meta, pid)) });
  });

  admin.post("/projects", async (c) => {
    const { name } = await c.req.json();
    if (!name) return c.json({ error: "name required" }, 400);
    const id = newId();
    try {
      meta.db.run("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", [id, name, Date.now()]);
    } catch {
      return c.json({ error: "project name already exists" }, 409);
    }
    return c.json({ id, name }, 201);
  });

  admin.delete("/projects/:id", (c) => {
    const id = c.req.param("id");
    const row = meta.db.query("SELECT id FROM projects WHERE id = ? OR name = ?").get(id, id);
    if (!row) return c.json({ error: "not found" }, 404);
    meta.db.run("DELETE FROM api_keys WHERE project_id = ?", [row.id]);
    meta.db.run("DELETE FROM projects WHERE id = ?", [row.id]);
    dropProjectDb(meta, row.id); // 每 project 独立 db 文件,删除即清理
    return c.json({ status: "deleted" });
  });

  admin.get("/projects/:id/keys", (c) => {
    const pid = resolveProjectId(meta, c.req.param("id"));
    if (!pid) return c.json({ error: "not found" }, 404);
    const rows = meta.db
      .query("SELECT id, public_key, name, created_at FROM api_keys WHERE project_id = ? ORDER BY created_at DESC")
      .all(pid);
    return c.json({ keys: rows });
  });

  admin.post("/projects/:id/keys", async (c) => {
    const pid = resolveProjectId(meta, c.req.param("id"));
    if (!pid) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({ name: null }));
    const name = typeof (body as any).name === "string" && (body as any).name.trim() ? (body as any).name.trim() : null;
    const pk = `pk-lf-${newId()}${newId().slice(0, 8)}`;
    const sk = `sk-lf-${newId()}${newId()}`;
    meta.db.run(
      "INSERT INTO api_keys(id,project_id,public_key,secret_hash,name,created_at) VALUES(?,?,?,?,?,?)",
      [newId(), pid, pk, sha256(sk), name ?? null, Date.now()],
    );
    return c.json({ publicKey: pk, secretKey: sk, name: name ?? null }, 201); // secret 仅此一次返回
  });

  admin.delete("/projects/:id/keys/:keyId", (c) => {
    meta.db.run("DELETE FROM api_keys WHERE id = ? OR public_key = ?", [c.req.param("keyId"), c.req.param("keyId")]);
    return c.json({ status: "deleted" });
  });

  // ---------- 查询 API(供 UI;默认仅本地监听) ----------
  app.get("/api/v1/projects", (c) => {
    const rows = meta.db.query("SELECT id, name, created_at FROM projects ORDER BY created_at DESC").all();
    return c.json({ projects: rows });
  });

  const query = new Hono();
  query.use("*", async (c, next) => {
    const pid = resolveProjectId(meta, c.req.query("projectId") ?? "");
    if (!pid) return c.json({ error: "project not found" }, 404);
    c.set("store", getProjectStore(meta, pid));
    await next();
  });

  query.get("/traces", (c) => {
    const r = listTraces(c.get("store"), {
      sessionId: c.req.query("sessionId") || undefined,
      userId: c.req.query("userId") || undefined,
      limit: Number(c.req.query("limit") ?? 50),
      cursor: c.req.query("cursor") || undefined,
    });
    return c.json(r);
  });

  query.get("/traces/:id", (c) => {
    const d = getTraceDetail(c.get("store"), c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    return c.json(d);
  });

  query.get("/sessions", (c) => c.json({ items: listSessions(c.get("store")) }));
  query.get("/sessions/:id", (c) => {
    const r = listTraces(c.get("store"), { sessionId: c.req.param("id"), limit: 200 });
    return c.json({ sessionId: c.req.param("id"), traces: r.items });
  });

  app.route("/api/v1/admin", admin);
  app.route("/api/v1", query);

  // ---------- UI ----------
  const indexHtml = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>minifuse</title><style>${uiAssets.css}</style></head>
<body><div id="root"></div><script>${uiAssets.js}</script></body></html>`;
  app.get("/ui", (c) => c.html(indexHtml, 200, { "cache-control": "no-store" }));
  app.get("/", (c) => c.redirect("/ui"));
  app.get("/health", (c) => c.json({ status: "ok", service: "minifuse" }));

  return app;
}

function resolveProjectId(meta: MetaDb, idOrName: string): string | null {
  const row = meta.db.query("SELECT id FROM projects WHERE id = ? OR name = ?").get(idOrName, idOrName) as { id: string } | null;
  return row?.id ?? null;
}
