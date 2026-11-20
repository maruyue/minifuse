# minifuse

The lightest LLM / agent trace viewer. An essential tool for developing and debugging agents. Single process, SQLite as the only dependency, no external services.

If you like the observability approach of [Langfuse](https://langfuse.com) / [Litefuse](https://litefuse.ai/), but only need a simple place to view traces — and dislike the large set of other features — minifuse is a lighter alternative.

## Features

- **Langfuse-compatible** — OTLP HTTP (protobuf / JSON) and REST batch endpoints. Existing Langfuse integrations work by changing the URL and keys
- **SQLite only** — Built with Bun and TypeScript, runs as a single process; no Postgres, Redis, ClickHouse or object storage
- **Multi-project isolation** — Each project gets its own SQLite file; deleting a project deletes the file
- **Rolling trace tables with auto-expiry** — Trace data rolls into new tables as it grows (like rotating log files); the oldest partitions are deleted automatically once the retention limit is reached
- **Embedded Web UI** — Trace list, call tree, session aggregation and Formatted / JSON views, all bundled into a single binary

![minifuse UI](docs/screenshot.png)

## Install

```bash
git clone https://github.com/maruyue/minifuse.git
cd minifuse
./build.sh        # builds the single binary ./minifuse (requires Bun)
```

## Run

```bash
MINIFUSE_PORT=3000 MINIFUSE_HOST=0.0.0.0 MINIFUSE_DATA=./data ./minifuse
```

## Integrate

Create a project in the Web UI and generate an access key, then configure your agent:

**OpenTelemetry**

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:3000/api/public/otel"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"     # or http/json
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic <base64(pk:sk)>"
```

**Langfuse SDK (Python)**

```python
from langfuse import Langfuse

langfuse = Langfuse(
    public_key="pk-lf-...",
    secret_key="sk-lf-...",
    host="http://localhost:3000",
)
```

**Langfuse SDK (TypeScript)**

```ts
import { Langfuse } from "langfuse";

const langfuse = new Langfuse({
  publicKey: "pk-lf-...",
  secretKey: "sk-lf-...",
  baseUrl: "http://localhost:3000",
});
```

**REST API**

```bash
curl -X POST http://localhost:3000/api/public/traces \
  -u "pk-lf-...:sk-lf-..." \
  -H "Content-Type: application/json" \
  -d '{"batch": [{"id": "trace-1", "name": "my-trace"}]}'
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MINIFUSE_PORT` | 3000 | Listen port |
| `MINIFUSE_HOST` | 0.0.0.0 | Listen address |
| `MINIFUSE_DATA` | ./data | Data directory |

## License

[Apache License 2.0](LICENSE)
