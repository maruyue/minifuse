# minifuse

最轻量的 agent trace 查看工具。only trace,单一进程,零外部依赖。

如果你对 [Langfuse](https://langfuse.com) / Litefuse 感兴趣,又觉得它们功能太庞杂——只是想要一个简单的地方**看 trace**,那 minifuse 就是为你准备的。

- **完全兼容 Langfuse 协议**:OTLP HTTP(protobuf / JSON)与 REST batch 端点,Langfuse SDK 改个地址即可接入
- **TypeScript(Bun)编写,仅依赖 SQLite**:单进程运行,没有 Postgres / Redis / ClickHouse / 对象存储
- **多项目,一项目一库**:每个项目一个独立的 SQLite 文件,删除项目就是删除这个文件,干净整齐
- **滚动分区,自动过期**:每个项目的 observations 按容量滚动成 `observations_1`、`observations_2`…(类似滚动日志的多个日志文件),超过保留数量自动删除最旧的,不会撑爆数据库
- **内嵌 Web UI**:trace 列表、调用树、session 聚合、Formatted / JSON 双视图,全部打进单一二进制

![minifuse UI](docs/screenshot.png)

## 安装

```bash
git clone https://github.com/maruyue/minifuse.git
cd minifuse
./build.sh          # 产出单一二进制 ./minifuse
```

## 启动

```bash
./minifuse                                    # 默认 0.0.0.0:3000,数据在 ./data
PORT=9000 MINIFUSE_DATA=~/minifuse-data ./minifuse
```

## 使用

1. 打开 `http://localhost:3000/ui`,在管理页新建一个项目
2. 为项目生成一对 access key(secret 仅显示一次)
3. 在你的 agent 里配置 Langfuse 指向 minifuse 即可:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:3000/api/public/otel"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic <base64(pk:sk)>"
```

Langfuse SDK 同理:把 `LANGFUSE_BASE_URL` 指向 minifuse,pk / sk 填刚生成的 key。

trace 上报后,在 UI 里按 session / trace 浏览即可。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `MINIFUSE_DATA` | ./data | 数据目录 |
| `MINIFUSE_HOST` | 0.0.0.0 | 监听地址 |
| `MINIFUSE_ADMIN_TOKEN` | 关闭 | 设置后管理操作需要 Bearer token |
