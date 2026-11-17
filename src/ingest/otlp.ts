// OTLP 摄入:protobuf 与 JSON 双格式。
// protobuf:借 @opentelemetry/otlp-transformer 内部生成的 protobufjs root(官方包
// 未公开请求解码 API,深路径 import 其 ESM 产物);JSON:手写解析 OTLP/JSON 标准
// 结构(resourceSpans → scopeSpans → spans,camelCase,hex id,UnixNano 时间)。

import type { RawSpan } from "../normalize";

type Attrs = Record<string, unknown>;

/* ---------- 基础工具 ---------- */

const hex = (u8: Uint8Array | undefined): string =>
  u8 ? Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("") : "";

function toMs(v: unknown): number {
  // OTLP 时间:UnixNano(Long 对象 / number / string)
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") n = Number(v);
  else if (v && typeof v === "object" && "toNumber" in (v as any)) n = (v as any).toNumber();
  else if (typeof v === "bigint") n = Number(v);
  else return 0;
  return Math.round(n / 1e6); // nano → ms
}

/** OTLP AnyValue 包装 → 纯 JS 值 */
function unwrapValue(v: any): unknown {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v && v.stringValue !== null && v.stringValue !== undefined) return v.stringValue;
  if ("boolValue" in v && v.boolValue !== null && v.boolValue !== undefined) return v.boolValue;
  if ("intValue" in v && v.intValue !== null && v.intValue !== undefined) return Number(v.intValue);
  if ("doubleValue" in v && v.doubleValue !== null && v.doubleValue !== undefined) return Number(v.doubleValue);
  if ("arrayValue" in v && v.arrayValue?.values) return v.arrayValue.values.map(unwrapValue);
  if ("kvlistValue" in v && v.kvlistValue?.values) return unwrapAttrs(v.kvlistValue.values);
  if ("bytesValue" in v && v.bytesValue) return v.bytesValue;
  return undefined;
}

function unwrapAttrs(list: any[] | undefined): Attrs {
  const out: Attrs = {};
  for (const kv of list ?? []) {
    if (kv?.key) out[kv.key] = unwrapValue(kv.value);
  }
  return out;
}

function toRawSpan(s: any, resAttrs: Attrs): RawSpan {
  const start = toMs(s.startTimeUnixNano);
  const end = toMs(s.endTimeUnixNano);
  const status = s.status ? { code: Number(s.status.code ?? 0), message: s.status.message } : undefined;
  return {
    traceId: typeof s.traceId === "string" ? s.traceId : hex(s.traceId as Uint8Array),
    spanId: typeof s.spanId === "string" ? s.spanId : hex(s.spanId as Uint8Array),
    parentSpanId: s.parentSpanId
      ? typeof s.parentSpanId === "string" && s.parentSpanId.length > 0
        ? s.parentSpanId
        : hex(s.parentSpanId as Uint8Array) || undefined
      : undefined,
    name: s.name ?? "span",
    kind: Number(s.kind ?? 0),
    startTime: start,
    endTime: end,
    duration: Math.max(0, end - start),
    attributes: unwrapAttrs(s.attributes),
    status,
    events: (s.events ?? []).map((e: any) => ({ name: e.name, attributes: unwrapAttrs(e.attributes) })),
    resource: { attributes: resAttrs },
  };
}

/* ---------- protobuf 通道 ---------- */

const generatedRoot: any = await import(
  // @ts-ignore -- 深路径借用内部生成产物(官方 exports 未暴露请求解码)
  "../../node_modules/@opentelemetry/otlp-transformer/build/esm/generated/root.js"
);
const ExportTraceServiceRequest =
  generatedRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

function decodeProtobuf(bytes: Uint8Array): RawSpan[] {
  const req = ExportTraceServiceRequest.decode(bytes);
  const out: RawSpan[] = [];
  for (const rs of req.resourceSpans ?? []) {
    const resAttrs = unwrapAttrs(rs.resource?.attributes);
    const scopeList = rs.scopeSpans ?? (rs as any).instrumentationLibrarySpans ?? [];
    for (const ss of scopeList) {
      for (const s of ss.spans ?? []) out.push(toRawSpan(s, resAttrs));
    }
  }
  return out;
}

/* ---------- JSON 通道 ---------- */

function decodeJson(text: string): RawSpan[] {
  const req = JSON.parse(text);
  const out: RawSpan[] = [];
  for (const rs of req.resourceSpans ?? []) {
    const resAttrs = unwrapAttrs(rs.resource?.attributes);
    const scopeList = rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? [];
    for (const ss of scopeList) {
      for (const s of ss.spans ?? []) out.push(toRawSpan(s, resAttrs));
    }
  }
  return out;
}

/* ---------- 入口 ---------- */

export function decodeOtlp(body: ArrayBuffer | Uint8Array, contentType: string): RawSpan[] {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("json") || (!ct && bytes[0] === 0x7b)) {
    return decodeJson(new TextDecoder().decode(bytes));
  }
  return decodeProtobuf(bytes);
}
