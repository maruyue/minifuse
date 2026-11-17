// HTTP 端到端:OTLP 摄入 → 跨 shard → 查询 API,验证归一化、落库、合并、序列化整条链路。

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMeta, getProjectStore, rollObservationPartition, dropProjectDb, storageStats } from "./db";
import { buildApp } from "./api";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const ROOT_ID = "1111111111111111";
const CHILD_ID = "2222222222222222";

const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ intValue: v });

function otlp(resource: Record<string, unknown>[], spans: Record<string, unknown>[]) {
  return {
    resourceSpans: [{
      resource: {
        attributes: Object.entries(resource).map(([key, value]) => ({
          key, value: typeof value === "number" ? int(value) : str(String(value)),
        })),
      },
      scopeSpans: [{ spans }],
    }],
  };
}

const span = (over: Record<string, unknown>) => ({
  traceId: TRACE_ID,
  spanId: ROOT_ID,
  parentSpanId: "",
  name: "root",
  kind: 1,
  startTimeUnixNano: "1000000000",
  endTimeUnixNano: "1100000000",
  attributes: [],
  status: {},
  ...over,
});

test("OTLP 摄入跨分区后,详情/列表 API 返回合并结果", async () => {
  const dir = mkdtempSync(join(tmpdir(), "minifuse-api-"));
  const meta = openMeta(dir);
  try {
    const app = buildApp(meta, { js: "", css: "" });

    // 建 project + key
    let res = await app.request("/api/v1/admin/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "e2e" }),
    });
    expect(res.status).toBe(201);
    const project = await res.json() as { id: string };

    res = await app.request(`/api/v1/admin/projects/${project.id}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(201);
    const key = await res.json() as { publicKey: string; secretKey: string };
    const auth = "Basic " + Buffer.from(`${key.publicKey}:${key.secretKey}`).toString("base64");

    const ingest = (body: unknown) => app.request("/api/public/otel/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    });

    // 无认证应被拒
    const noAuth = await app.request("/api/public/otel/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(noAuth.status).toBe(401);

    // 第一批:根 span(含 trace 级 input/tags/session/user)
    res = await ingest(otlp({ "service.name": "cappy", "langfuse.environment": "production" }, [
      span({
        name: "root",
        attributes: [
          { key: "langfuse.trace.name", value: str("agent-run") },
          { key: "langfuse.trace.input", value: str('{"q":"hi"}') },
          { key: "langfuse.trace.tags", value: { arrayValue: { values: [str("alpha")] } } },
          { key: "session.id", value: str("s1") },
          { key: "user.id", value: str("u1") },
          { key: "gen_ai.operation.name", value: str("chat") },
          { key: "gen_ai.request.model", value: str("claude") },
          { key: "gen_ai.usage.input_tokens", value: int(100) },
          { key: "gen_ai.usage.output_tokens", value: int(20) },
          { key: "langfuse.observation.cost_details", value: str('{"total":0.01}') },
        ],
      }),
    ]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });

    // 滚动后第二批:子 span(父在旧分区),带 ERROR
    rollObservationPartition(getProjectStore(meta, project.id));
    res = await ingest(otlp({ "service.name": "cappy", "langfuse.environment": "production" }, [
      span({
        spanId: CHILD_ID,
        parentSpanId: ROOT_ID,
        name: "child",
        startTimeUnixNano: "1010000000",
        endTimeUnixNano: "1090000000",
        status: { code: 2, message: "boom" },
        attributes: [
          { key: "langfuse.trace.name", value: str("agent-run") },
          { key: "gen_ai.operation.name", value: str("chat") },
          { key: "gen_ai.request.model", value: str("claude") },
          { key: "gen_ai.usage.input_tokens", value: int(50) },
          { key: "gen_ai.usage.output_tokens", value: int(10) },
          { key: "langfuse.observation.cost_details", value: str('{"total":0.02}') },
        ],
      }),
    ]));
    expect(res.status).toBe(200);

    // 详情:跨分区合并
    res = await app.request(`/api/v1/traces/${TRACE_ID}?projectId=${project.id}`);
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.observations.map((o: any) => o.id).sort()).toEqual([ROOT_ID, CHILD_ID]);
    expect(d.observations.find((o: any) => o.id === CHILD_ID).parent_id).toBe(ROOT_ID);
    expect(d.trace.start_time).toBe(1000);
    expect(d.trace.end_time).toBe(1100);
    expect(d.trace.input_tokens).toBe(150);
    expect(d.trace.output_tokens).toBe(30);
    expect(d.trace.total_tokens).toBe(180);
    expect(d.trace.total_cost).toBeCloseTo(0.03, 10);
    expect(d.trace.status).toBe("error");
    expect(d.trace.name).toBe("agent-run");
    expect(d.trace.input).toEqual({ q: "hi" });
    expect(d.trace.session_id).toBe("s1");
    expect(d.trace.user_id).toBe("u1");
    expect(d.trace.environment).toBe("production");
    expect(d.trace.tags).toEqual(["alpha"]);

    // 列表:单 trace 行,聚合与详情一致
    res = await app.request(`/api/v1/traces?projectId=${project.id}`);
    expect(res.status).toBe(200);
    const list = await res.json() as any;
    expect(list.items.length).toBe(1);
    expect(list.items[0].id).toBe(TRACE_ID);
    expect(list.items[0].latency_ms).toBe(100);
    expect(list.items[0].input_tokens).toBe(150);
    expect(list.items[0].total_cost).toBeCloseTo(0.03, 10);
    expect(list.items[0].status).toBe("error");

    // 管理端:分区统计 + 修改保留数
    res = await app.request("/api/v1/admin/projects");
    expect(res.status).toBe(200);
    const admin = await res.json() as any;
    const proj = admin.projects.find((p: any) => p.id === project.id);
    expect(proj.storage.partitionCount).toBe(2);
    expect(proj.max_partitions).toBe(3);

    res = await app.request(`/api/v1/admin/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxPartitions: 5 }),
    });
    expect(res.status).toBe(200);
    const patch = await res.json() as any;
    expect(patch.maxPartitions).toBe(5);
    expect(patch.storage.maxPartitions).toBe(5);
    const store = getProjectStore(meta, project.id);
    expect(storageStats(store).maxPartitions).toBe(5);
  } finally {
    const projects = meta.db.query("SELECT id FROM projects").all() as any[];
    for (const p of projects) dropProjectDb(meta, p.id);
    rmSync(dir, { recursive: true, force: true });
  }
});
