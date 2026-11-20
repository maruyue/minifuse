// 服务入口:装配 db + app,启动 Bun.serve。
// 默认监听 0.0.0.0(局域网/虚拟机可接入);摄入走 pk/sk 认证。

import { openMeta, getProjectStore, maintainProjectStorage } from "./db";
import { buildApp } from "./api";
import { loadUiAssets } from "./embed";

const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000; // 每 15 分钟

export async function startServer(opts: { port: number; dataDir: string }) {
  const meta = openMeta(opts.dataDir);

  // 启动前把旧 shard 文件迁移到单库 data.db;迁移失败则中止启动,避免带病服务。
  const projects = meta.db.query("SELECT id, name FROM projects").all() as Array<{ id: string; name: string }>;
  for (const p of projects) {
    try {
      getProjectStore(meta, p.id);
    } catch (e) {
      console.error(`[startup] project ${p.name} (${p.id}) 打开/迁移失败:`, e);
      throw e;
    }
  }

  const app = buildApp(meta, loadUiAssets());

  const host = process.env.MINIFUSE_HOST ?? "0.0.0.0";
  Bun.serve({ port: opts.port, hostname: host, fetch: app.fetch });

  // 每 15 分钟:先无条件做保留检查(分区数超限就删最旧),再检查活动分区是否达到 1GB。
  const maintain = () => {
    try {
      const rows = meta.db.query("SELECT id, name FROM projects").all() as Array<{ id: string; name: string }>;
      for (const p of rows) {
        try {
          const store = getProjectStore(meta, p.id);
          const { dropped, rolled } = maintainProjectStorage(store);
          if (dropped.length) {
            console.log(`[storage] ${p.name}: 删除超出保留数的分区 ${dropped.join(", ")}`);
          }
          if (rolled) {
            console.log(
              `[storage] ${p.name}: 活动分区达到阈值,滚动到 ${rolled.name}` +
                (rolled.dropped.length ? `(同时删除 ${rolled.dropped.join(", ")})` : ""),
            );
          }
        } catch (e) {
          console.error(`[storage] ${p.name}: 维护失败:`, e);
        }
      }
    } catch (e) {
      console.error("[storage] 维护任务失败:", e);
    }
  };
  setTimeout(maintain, 0); // 启动后立刻检查一次
  setInterval(maintain, MAINTENANCE_INTERVAL_MS);

  console.log(`minifuse listening on http://${host}:${opts.port}  (UI: /ui)`);
  console.log(`data dir: ${opts.dataDir}`);
}
