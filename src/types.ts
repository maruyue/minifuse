// minifuse 内部数据模型:所有摄入通道(OTLP protobuf/JSON、Langfuse REST)
// 统一规范化为这几个结构再入库。

export type ObservationType = "SPAN" | "GENERATION" | "TOOL" | "EVENT";

export interface TraceRow {
  id: string;
  session_id?: string | null;
  user_id?: string | null;
  name: string;
  function_id?: string | null; // AI SDK ai.telemetry.functionId(业务身份)
  timestamp: number; // epoch ms = start_time
  end_time?: number | null;
  latency_ms?: number | null;
  status?: string | null; // "success" | "error"
  input?: unknown;
  output?: unknown;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  total_cost?: number | null;
  tags?: string[] | null;
  metadata?: unknown;
  release?: string | null;
  version?: string | null;
  environment?: string | null;
}

export interface ObservationRow {
  id: string;
  trace_id: string;
  parent_id?: string | null;
  type: ObservationType;
  name: string;
  start_ts: number; // epoch ms
  end_ts?: number | null;
  completion_start_time?: number | null; // TTFT(Langfuse 字段)
  level?: string | null; // DEFAULT | ERROR
  status_message?: string | null;
  input?: unknown;
  output?: unknown;
  model?: string | null;
  model_parameters?: unknown;
  usage?: unknown;
  cost?: unknown;
  total_cost?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  metadata?: unknown;
  attributes?: unknown; // OTLP 原始 span attributes(透传)
}

export interface ScoreRow {
  id: string;
  trace_id: string;
  name: string;
  value?: number | null;
  string_value?: string | null;
  data_type?: string | null; // NUMERIC | CATEGORICAL
  comment?: string | null;
  created_at?: number;
}

export interface NormalizedBatch {
  traces: Array<{ trace: TraceRow; observations: ObservationRow[]; scores?: ScoreRow[] }>;
}
