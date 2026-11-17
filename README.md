# minifuse

单二进制(~84MB,内嵌 Bun runtime)的 Langfuse 兼容 trace 服务。
零外部依赖:无 Doris / Postgres / Redis / MinIO / Docker,存储只用 SQLite。

## 特性

- **Langfuse 协议兼容**:`POST /api/public/otel/v1/traces`(OTLP HTTP,protobuf + JSON 双格式)、
  `POST /api/public/traces|observations|scores`(REST batch)。Basic auth(pk:sk),key 格式 `pk-lf-…`/`sk-lf-…`
- **属性规范化**:Langfuse 官方属性(`langfuse.*`、`user.id`/`session.id` 双命名)、OTel `gen_ai.*`
  语义约定、OpenInference 兜底,规则对齐 Litefuse `OtelIngestionProcessor`
- **每 project 一个 SQLite 文件**(`data/projects/<id>/data.db`,删除 project 即删目录,零残留)
- **observations 表级分区**:单张表达到 1GB 自动滚动到 `observations_2`、`observations_3`…(编号无限递增);
  每 15 分钟维护任务会先检查分区数是否超过保留上限(默认 3,项目区可改 3–20),超过就删最旧的分区。
  traces / sessions / scores 永远是单表;删除旧分区后空间由 SQLite freelist 复用,不需要 VACUUM
- **内嵌 Web UI**(Preact,单文件打包进二进制):Traces 列表/详情树、Sessions、Project & Key 管理;
  详情面板支持 格式化/JSON 双视图——消息按角色分段渲染(Markdown 标题/列表/表格/行内代码/
  语法高亮代码块、工具调用卡、tools 定义列表)
- 单租户、多 project;管理操作可选 admin token(`MINIFUSE_ADMIN_TOKEN`,不设则仅建议本机使用)

## 快速开始

```bash
./minifuse                      # 默认 0.0.0.0:3000,数据在 ./data
PORT=9000 MINIFUSE_DATA=~/.minifuse ./minifuse
```

打开 `http://127.0.0.1:3000/ui` → 管理页创建 project(自动发一对 key,secret 仅显示一次)。

## 接入 OTel 应用(如 cappy-agent)

只改环境变量,代码零改动:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:3000/api/public/otel"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"   # 或 http/json
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic <base64(pk:sk)>"
```

Langfuse SDK(python/js)同理:把 `LANGFUSE_BASE_URL` 指到 `http://localhost:3000`,
public key / secret key 填 minifuse 发的即可。

## Schema

列名对齐 Litefuse Doris 权威定义(`0039_traces_scalar.sql` / `0037_spans.sql`):
traces(start_time/end_time/release/version/environment/tags/metadata/…)、
observations(type/start_time/completion_start_time/usage/cost/model_parameters/…)、
sessions、scores(value/string_value/data_type)。

## 存储与保留

- `data/meta.db`:projects + api_keys。
- `data/projects/<id>/data.db`:traces / sessions / scores 各一张表,observations 按容量分区为
  `observations_1`、`observations_2`…;每张表 1GB 上限,每 15 分钟检查一次。
- 每个 project 默认保留 3 个 observations 分区,可在管理页「设置保留分区数」修改(3–20)。
- 旧版 `shard-*.db` 布局会在首次启动时自动合并进 `data.db`,校验通过后删除旧文件。

## 构建

```bash
bun install
bun run build       # 先 build:ui 再 compile 出 ./minifuse
bun test            # 39 个单测(分区/迁移/维护/分页/边界)
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `MINIFUSE_DATA` | ./data | 数据目录(meta.db + projects/&lt;id&gt;/data.db) |
| `MINIFUSE_HOST` | 0.0.0.0 | 监听地址(对外暴露请自行加固) |
| `MINIFUSE_ADMIN_TOKEN` | 关闭 | 设置后管理 API/UI 需要 Bearer token |
