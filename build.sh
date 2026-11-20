#!/usr/bin/env bash
# 编译出单一二进制 ./minifuse(内嵌 Web UI 与 Bun runtime)
set -euo pipefail
cd "$(dirname "$0")"
bun install
bun run build
