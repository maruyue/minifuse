// 单二进制入口:直接启动服务。配置走环境变量(PORT / MINIFUSE_DATA / MINIFUSE_HOST / MINIFUSE_ADMIN_TOKEN)。

import { startServer } from "./index";

await startServer({
  port: Number(process.env.PORT ?? 3000),
  dataDir: process.env.MINIFUSE_DATA ?? "./data",
});
