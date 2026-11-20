# minifuse

最轻量的 agent trace 查看工具 —— only trace,单进程,零外部依赖。

如果你喜欢 [Langfuse](https://langfuse.com) / Litefuse 的思路,却嫌它们太重:要跑一堆中间件、配数据库和对象存储,而你要的只是**一个能看 agent trace 的地方** —— 那就是它了。

**为什么轻**

- **完全兼容 Langfuse 协议** —— OTLP HTTP(protobuf / JSON)与 REST batch 端点,现有 Langfuse 接入改个地址就能用
- **只用 SQLite** —— TypeScript(Bun)编写,单进程运行;没有 Postgres / Redis / ClickHouse / 对象存储
- **一项目一文件** —— 每个项目一个独立的 SQLite 文件,删除项目即删除文件,不留残余
- **滚动分区,自动过期** —— observations 按容量滚动成 `observations_1`、`observations_2`…(类似滚动日志),超过保留数量自动删除最旧的,不用担心撑爆磁盘
- **内嵌 Web UI** —— trace 列表、调用树、session 聚合、Formatted / JSON 双视图,全部打进单一二进制

![minifuse UI](docs/screenshot.png)

## 安装

```bash
git clone https://github.com/maruyue/minifuse.git
cd minifuse
./build.sh        # 产出单一二进制 ./minifuse(需 Bun)
```

## 启动

```bash
./minifuse                                              # 监听 0.0.0.0:3000,数据在 ./data
MINIFUSE_PORT=9000 MINIFUSE_DATA=~/minifuse-data ./minifuse
```

## 接入

先在 Web UI(`http://localhost:3000/ui`)创建一个项目,生成一对 access key,然后按你的接入方式配置:

**OpenTelemetry(任意 OTel 应用)**

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:3000/api/public/otel"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"     # 或 http/json
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic <base64(pk:sk)>"
```

**Langfuse SDK(Python / JS)**

```python
# Python
from langfuse import Langfuse
langfuse = Langfuse(
    public_key="pk-lf-...",
    secret_key="sk-lf-...",
    host="http://localhost:3000",
)
```

```ts
// TypeScript
import { Langfuse } from "langfuse";
const langfuse = new Langfuse({
  publicKey: "pk-lf-...",
  secretKey: "sk-lf-...",
  baseUrl: "http://localhost:3000",
});
```

**Langfuse REST API**

```bash
curl -X POST http://localhost:3000/api/public/traces \
  -u "pk-lf-...:sk-lf-..." \
  -H "Content-Type: application/json" \
  -d '{"batch": [{"id": "trace-1", "name": "my-trace"}]}'
```

上报后,打开 UI 按 session / trace 浏览即可。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MINIFUSE_PORT` | 3000 | 监听端口 |
| `MINIFUSE_HOST` | 0.0.0.0 | 监听地址 |
| `MINIFUSE_DATA` | ./data | 数据目录 |

## License

[Apache License 2.0](LICENSE)
