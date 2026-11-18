// 属性规范化层:Langfuse / OTel gen_ai / OpenInference 多命名识别,
// 规则参照 Litefuse packages/shared/src/server/otel/attributes.ts 与
// OtelIngestionProcessor.ts 的兼容矩阵。

import type { TraceRow, ObservationRow, ObservationType, NormalizedBatch } from "./types";

type Attrs = Record<string, unknown>;

// OTLP 通道的扁平 span(otlp-transformer deserializeResponse 输出形状)
export interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  kind: number;
  startTime: number; // epoch ms
  endTime: number; // epoch ms
  duration: number; // ms
  attributes?: Attrs;
  status?: { code?: number; message?: string } | number;
  events?: Array<{ name: string; time?: number; attributes?: Attrs }>;
  resource?: { attributes?: Attrs };
}

function attr(attrs: Attrs | undefined, ...keys: string[]): unknown {
  if (!attrs) return undefined;
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** 各通道通用的 session/user 提取(Litefuse 兼容多命名,含 lf 旧前缀与 metadata 内嵌) */
export function extractSessionUser(a: Attrs | undefined): { sessionId?: string; userId?: string } {
  const sessionId = attr(a, "session.id", "langfuse.session.id", "openinference.session.id",
    "trace.session.id", "ai.telemetry.metadata.sessionId") as string | undefined;
  const userId = attr(a, "user.id", "langfuse.user.id", "openinference.user.id",
    "enduser.id", "trace.user.id", "ai.telemetry.metadata.userId") as string | undefined;
  return { sessionId, userId };
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

/** RFC3339 或 ms → ms(用于 completion_start_time 等字符串时间属性) */
function timeAttrToMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** resource/trace 级环境字段(Langfuse release/version/environment) */
function extractEnv(a: Attrs | undefined): { release?: string; version?: string; environment?: string } {
  return {
    release: attr(a, "langfuse.release", "service.version") as string | undefined,
    version: attr(a, "langfuse.version") as string | undefined,
    environment: (attr(a, "langfuse.environment", "deployment.environment.name") as string | undefined) ?? "default",
  };
}

/** span → observation 的类型推断(优先显式属性,其次 gen_ai 操作,最后名字启发) */
function inferType(a: Attrs | undefined, name: string, hasGenAiUsage: boolean): ObservationType {
  const explicit = attr(a, "langfuse.span.type", "langfuse.observation.type") as string | undefined;
  if (explicit) {
    const up = explicit.toUpperCase();
    if (up === "GENERATION" || up === "TOOL" || up === "EVENT" || up === "SPAN") return up;
  }
  const op = attr(a, "gen_ai.operation.name") as string | undefined;
  if (op || hasGenAiUsage) return "GENERATION";
  // Vercel AI SDK:有 model 或 response 产物即为一次模型调用
  if (attr(a, "ai.model.id", "ai.response.text", "ai.response.object", "ai.response.toolCalls", "ai.prompt.messages")) {
    return "GENERATION";
  }
  if (attr(a, "ai.toolCall.name")) return "TOOL";
  const n = name.toLowerCase();
  if (n.includes("tool") || n.startsWith("execute_") || n === "read" || n === "list" || n === "write" || n === "grep" || n === "search") return "TOOL";
  return "SPAN";
}

/** 收集指定前缀的全部属性;残余 key 中的 "." 展开为嵌套对象(ai.usage.inputTokenDetails.x → 嵌套) */
function collectPrefixed(a: Attrs | undefined, prefix: string): Record<string, unknown> | undefined {
  if (!a) return undefined;
  const out: Record<string, any> = {};
  let found = false;
  for (const [k, v] of Object.entries(a)) {
    if (!k.startsWith(prefix)) continue;
    const key = k.slice(prefix.length);
    if (!key) continue;
    found = true;
    const parts = key.split(".");
    let cur: any = out;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] && typeof cur[parts[i]] === "object" ? cur[parts[i]] : {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return found ? out : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
}

function extractGenAi(a: Attrs | undefined): { model?: string; inputTokens?: number; outputTokens?: number } {
  const model = attr(a, "gen_ai.request.model", "gen_ai.response.model", "gen_ai.model",
    "ai.model.id", "ai.response.model", "llm.model_name") as string | undefined;
  const num = (v: unknown) => {
    const n = typeof v === "string" ? Number(v) : (v as number);
    return Number.isFinite(n) ? n : undefined;
  };
  const inputTokens = num(attr(a, "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens",
    "ai.usage.inputTokens", "llm.token_count.prompt", "gen_ai.usage.input_token_count"));
  const outputTokens = num(attr(a, "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens",
    "ai.usage.outputTokens", "llm.token_count.completion", "gen_ai.usage.output_token_count"));
  return { model, inputTokens, outputTokens };
}

function statusOf(span: RawSpan): { level: string; message?: string; errored: boolean } {
  const st = span.status;
  // otlp-transformer: status 为 number(旧)或 {code, message}(新)
  const code = typeof st === "number" ? st : (st?.code ?? 0);
  const message = typeof st === "object" ? st?.message : undefined;
  // OTel 语义:recordException 产生的 exception 事件即使 status.code 未置 ERROR 也视为出错
  const exc = span.events?.find((e) => e.name === "exception");
  if (code === 2 /* ERROR */ || exc) {
    const excMsg = exc?.attributes
      ? [attr(exc.attributes, "exception.type"), attr(exc.attributes, "exception.message")]
          .filter((v) => v !== undefined && v !== null && v !== "").join(": ")
      : "";
    return { level: "ERROR", message: message ?? (excMsg || undefined), errored: true };
  }
  return { level: "DEFAULT", errored: false };
}

/** OTLP 扁平 spans → 内部模型(按 traceId 分组) */
export function normalizeOtlp(spans: RawSpan[]): NormalizedBatch {
  const groups = new Map<string, RawSpan[]>();
  for (const s of spans) {
    const tid = s.traceId || s.spanId;
    const g = groups.get(tid);
    if (g) g.push(s);
    else groups.set(tid, [s]);
  }

  const out: NormalizedBatch["traces"] = [];
  for (const [tid, group] of groups) {
    const spanIds = new Set(group.map((s) => s.spanId));
    const roots = group.filter(
      (s) => !s.parentSpanId || s.parentSpanId === "0" || !spanIds.has(s.parentSpanId),
    );
    const root = roots[0] ?? group[0];
    const rootAttrs = { ...(root.resource?.attributes ?? {}), ...(root.attributes ?? {}) };

    // trace 级字段:任意 span 上的 langfuse trace 属性都算(root 优先)
    let name = attr(rootAttrs, "langfuse.trace.name") as string | undefined;
    let sessionId: string | undefined;
    let userId: string | undefined;
    let tags = attr(rootAttrs, "langfuse.trace.tags");
    let traceMeta = attr(rootAttrs, "langfuse.trace.metadata");
    let traceInput = parseMaybeJson(attr(rootAttrs, "langfuse.trace.input"));
    let traceOutput = parseMaybeJson(attr(rootAttrs, "langfuse.trace.output"));
    let model: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalCost = 0;
    let sawCost = false;
    let errored = false;

    if (!name || !sessionId) {
      for (const s of group) {
        const a = s.attributes ?? {};
        const su = extractSessionUser({ ...(s.resource?.attributes ?? {}), ...a });
        sessionId ||= su.sessionId;
        userId ||= su.userId;
        name ||= attr(a, "langfuse.trace.name") as string | undefined;
        tags = tags ?? attr(a, "langfuse.trace.tags");
        traceMeta = traceMeta ?? attr(a, "langfuse.trace.metadata");
      }
    }
    name = name || root.name;

    const observations: ObservationRow[] = group.map((s) => {
      const a = s.attributes ?? {};
      const st = statusOf(s);
      errored = errored || st.errored;
      const gen = extractGenAi(a);
      const obsType = inferType(a, s.name, !!(gen.inputTokens || gen.outputTokens || gen.model));
      model = model ?? gen.model ?? (attr(a, "langfuse.observation.model.name") as string | undefined);
      const it = gen.inputTokens ?? (attr(a, "gen_ai.usage.input_tokens") as number | undefined) ?? 0;
      const ot = gen.outputTokens ?? (attr(a, "gen_ai.usage.output_tokens") as number | undefined) ?? 0;
      if (obsType === "GENERATION") {
        inputTokens += it;
        outputTokens += ot;
        const cost0 = attr(a, "gen_ai.cost", "langfuse.observation.cost_details");
        const cost = parseMaybeJson(cost0);
        if (typeof cost === "number") {
          totalCost += cost;
          sawCost = true;
        } else if (cost && typeof cost === "object" && typeof (cost as any).total === "number") {
          totalCost += (cost as any).total;
          sawCost = true;
        }
      }
      const input = parseMaybeJson(
        attr(a, "langfuse.observation.input", "gen_ai.prompt", "input.value",
          "ai.prompt.messages", "ai.prompt", "ai.toolCall.args", "llm.input_messages"),
      );
      const output = parseMaybeJson(
        attr(a, "langfuse.observation.output", "gen_ai.completion", "output.value",
          "ai.response.text", "ai.response.object", "ai.response.toolCalls", "ai.response.reasoning",
          "ai.toolCall.result", "ai.completion", "llm.output_messages"),
      );
      // usage:优先 AI SDK 的 ai.usage.* 明细,其次通用
      const aiUsage = collectPrefixed(a, "ai.usage.");
      const usageRaw = aiUsage
        ? Object.fromEntries(Object.entries(aiUsage).map(([k, v]) => [k, numOrUndef(v) ?? v]))
        : attr(a, "gen_ai.usage", "langfuse.observation.usage_details", "llm.token_count");
      // metadata:AI SDK 的 ai.telemetry.metadata.* + 显式 langfuse metadata
      const aiMeta = collectPrefixed(a, "ai.telemetry.metadata.");
      const langfuseMeta = parseMaybeJson(attr(a, "langfuse.observation.metadata"));
      const metadata = aiMeta || langfuseMeta
        ? { ...(typeof langfuseMeta === "object" && langfuseMeta ? langfuseMeta : {}), ...(aiMeta ?? {}) }
        : undefined;
      const costRaw0 = attr(a, "gen_ai.cost", "langfuse.observation.cost_details");
      const costRaw = parseMaybeJson(costRaw0); // OTLP AnyValue 可能 JSON 字符串化
      const costTotal = typeof costRaw === "number" ? costRaw
        : (costRaw && typeof costRaw === "object" && typeof (costRaw as any).total === "number")
          ? (costRaw as any).total : null;
      const toolName = attr(a, "ai.toolCall.name") as string | undefined;
      return {
        id: s.spanId,
        trace_id: tid,
        parent_id: s.parentSpanId && s.parentSpanId !== "0" ? s.parentSpanId : null,
        type: obsType,
        name: toolName && obsType === "TOOL" ? toolName : s.name,
        start_ts: s.startTime,
        end_ts: s.endTime,
        completion_start_time: timeAttrToMs(
          attr(a, "langfuse.observation.completion_start_time", "gen_ai.first_token_time")),
        level: st.level,
        status_message: st.message ?? undefined,
        input,
        output,
        model: gen.model ?? ((attr(a, "langfuse.observation.model.name") as string | undefined) ?? null),
        model_parameters: parseMaybeJson(attr(a, "langfuse.observation.model.parameters")),
        usage: usageRaw,
        cost: costRaw,
        total_cost: costTotal,
        input_tokens: it || null,
        output_tokens: ot || null,
        total_tokens: it + ot || null,
        metadata,
        attributes: a,
      };
    });

    const env = extractEnv(rootAttrs);
    const trace: TraceRow = {
      id: tid,
      session_id: sessionId ?? null,
      user_id: userId ?? null,
      name,
      function_id: (attr(rootAttrs, "ai.telemetry.functionId") as string | undefined) ?? null,
      timestamp: root.startTime,
      end_time: root.endTime,
      latency_ms: root.duration ?? Math.max(0, root.endTime - root.startTime),
      status: errored ? "error" : "success",
      input: traceInput,
      output: traceOutput,
      model: model ?? null,
      input_tokens: inputTokens || null,
      output_tokens: outputTokens || null,
      total_tokens: inputTokens + outputTokens || null,
      total_cost: sawCost ? totalCost : null,
      tags: Array.isArray(tags) ? (tags as string[]) : tags ? [String(tags)] : null,
      metadata: parseMaybeJson(traceMeta),
      release: env.release ?? null,
      version: env.version ?? null,
      environment: env.environment ?? null,
    };
    out.push({ trace, observations });
  }
  return { traces: out };
}

// ---------- Langfuse REST ingestion 通道 ----------

export interface RestTrace {
  id?: string;
  name?: string;
  timestamp?: string | number;
  sessionId?: string;
  session_id?: string;
  userId?: string;
  user_id?: string;
  input?: unknown;
  output?: unknown;
  tags?: string[];
  metadata?: unknown;
  observations?: RestObservation[];
}

export interface RestObservation {
  id?: string;
  traceId?: string;
  parentObservationId?: string;
  type?: string;
  name?: string;
  startTime?: string | number;
  endTime?: string | number;
  completionStartTime?: string | number;
  level?: string;
  statusMessage?: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  modelParameters?: unknown;
  usage?: { input?: number; output?: number; total?: number; inputTokens?: number; outputTokens?: number; [k: string]: unknown };
  metadata?: unknown;
}

function ts(v: string | number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? fallback : t;
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function normalizeRestTrace(item: RestTrace): NormalizedBatch["traces"][number] {
  const now = Date.now();
  const traceId = item.id || newId();
  const trace: TraceRow = {
    id: traceId,
    session_id: item.sessionId ?? item.session_id ?? null,
    user_id: item.userId ?? item.user_id ?? null,
    name: item.name ?? "unnamed-trace",
    timestamp: ts(item.timestamp, now),
    status: "success",
    input: item.input,
    output: item.output,
    model: null,
    tags: item.tags ?? null,
    metadata: item.metadata,
    release: (item as any).release ?? null,
    version: (item as any).version ?? null,
    environment: (item as any).environment ?? "default",
  };
  const observations: ObservationRow[] = [];
  let inTok = 0;
  let outTok = 0;
  for (const o of item.observations ?? []) {
    const start = ts(o.startTime, trace.timestamp);
    const end = ts(o.endTime, start);
    const usage = o.usage ?? {};
    // 部分 SDK/代理会把 usage 数字序列化成字符串,统一强转防 "42"+"7" 拼接
    const toNum = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const it = toNum(usage.input ?? usage.inputTokens ?? 0);
    const ot = toNum(usage.output ?? usage.outputTokens ?? 0);
    if (o.type === "GENERATION") {
      inTok += it;
      outTok += ot;
      trace.model = trace.model ?? o.model ?? null;
    }
    if (o.level === "ERROR") trace.status = "error";
    observations.push({
      id: o.id || newId(),
      trace_id: o.traceId ?? traceId,
      parent_id: o.parentObservationId ?? null,
      type: ((o.type ?? "SPAN").toUpperCase() as ObservationType) ?? "SPAN",
      name: o.name ?? "unnamed-observation",
      start_ts: start,
      end_ts: end,
      completion_start_time: o.completionStartTime ? ts(o.completionStartTime, start) : null,
      level: o.level ?? "DEFAULT",
      status_message: o.statusMessage ?? null,
      input: o.input,
      output: o.output,
      model: o.model ?? null,
      model_parameters: o.modelParameters ?? null,
      usage: o.usage ?? null,
      cost: null,
      total_cost: null,
      input_tokens: it || null,
      output_tokens: ot || null,
      total_tokens: it + ot || null,
      metadata: o.metadata ?? null,
      attributes: null,
    });
  }
  observations.sort((a, b) => a.start_ts - b.start_ts);
  const first = observations[0];
  const last = observations[observations.length - 1];
  if (first && last && observations.length > 0) {
    // trace 自带的时间戳可能早于首条 observation(如采样上报),取较早者;缺省时退化为 obs 起点
    trace.timestamp = Math.min(trace.timestamp, first.start_ts);
    trace.latency_ms = Math.max(0, (last.end_ts ?? last.start_ts) - trace.timestamp);
  }
  trace.input_tokens = inTok || null;
  trace.output_tokens = outTok || null;
  return { trace, observations };
}

/** 回填用:从已有 span attributes 重新推导 observation 的可展示字段 */
export function enrichFromAttrs(attrs: Attrs | undefined): {
  type?: ObservationType;
  name?: string;
  input?: unknown;
  output?: unknown;
  usage?: unknown;
  metadata?: unknown;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
} {
  const a = attrs ?? {};
  const gen = extractGenAi(a);
  const aiUsage = collectPrefixed(a, "ai.usage.");
  const usageRaw = aiUsage
    ? Object.fromEntries(Object.entries(aiUsage).map(([k, v]) => [k, numOrUndef(v) ?? v]))
    : attr(a, "gen_ai.usage", "langfuse.observation.usage_details", "llm.token_count");
  const aiMeta = collectPrefixed(a, "ai.telemetry.metadata.");
  const langfuseMeta = parseMaybeJson(attr(a, "langfuse.observation.metadata"));
  const metadata = aiMeta || langfuseMeta
    ? { ...(typeof langfuseMeta === "object" && langfuseMeta ? langfuseMeta : {}), ...(aiMeta ?? {}) }
    : undefined;
  const toolName = attr(a, "ai.toolCall.name") as string | undefined;
  const type = inferType(a, String(attr(a, "operation.name", "resource.name") ?? ""),
    !!(gen.inputTokens || gen.outputTokens || gen.model));
  const it = gen.inputTokens ?? 0;
  const ot = gen.outputTokens ?? 0;
  return {
    type,
    name: toolName && type === "TOOL" ? toolName : undefined,
    input: parseMaybeJson(attr(a, "langfuse.observation.input", "gen_ai.prompt", "input.value",
      "ai.prompt.messages", "ai.prompt", "ai.toolCall.args", "llm.input_messages")),
    output: parseMaybeJson(attr(a, "langfuse.observation.output", "gen_ai.completion", "output.value",
      "ai.response.text", "ai.response.object", "ai.response.toolCalls", "ai.response.reasoning",
      "ai.toolCall.result", "ai.completion", "llm.output_messages")),
    usage: usageRaw,
    metadata,
    model: gen.model ?? ((attr(a, "langfuse.observation.model.name") as string | undefined) ?? null),
    input_tokens: it || null,
    output_tokens: ot || null,
    total_tokens: it + ot || null,
  };
}
