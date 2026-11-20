// 单二进制入口:直接启动服务。配置走环境变量(MINIFUSE_PORT / MINIFUSE_DATA / MINIFUSE_HOST)。

import { startServer } from "./index";

await startServer({
  port: Number(process.env.MINIFUSE_PORT ?? 3000),
  dataDir: process.env.MINIFUSE_DATA ?? "./data",
});
