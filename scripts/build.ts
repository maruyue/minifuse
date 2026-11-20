// 构建入口:编译 UI 与单一二进制,并在构建前后清理想上次构建残留的临时文件。
// bun build --compile 会把中间产物写成项目根目录下的 .<hash>-00000000.bun-build
// (只读的完整二进制副本,约 87MB / 个)。构建被中断时它们不会被自动删除,反复构建会堆积
// 上 GB 空间,所以这里构建前后各清一次。
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const TMP_RE = /^\..+\.bun-build$/;

/** 删除根目录下 bun build --compile 的临时文件,返回删除数量 */
function cleanTemps(): number {
  let n = 0;
  for (const name of readdirSync(root)) {
    if (!TMP_RE.test(name)) continue;
    const path = join(root, name);
    try {
      chmodSync(path, 0o644); // Bun 生成的临时文件是只读的,先加写位才能删
      rmSync(path, { force: true });
      n++;
    } catch {
      // 删不掉(例如被其他构建占用)不应阻断构建
    }
  }
  return n;
}

function run(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${r.exitCode})`);
}

const stale = cleanTemps();
if (stale) console.log(`cleaned ${stale} stale .bun-build file(s)`);

// MINIFUSE_OUTFILE 仅用于测试构建,正常构建固定输出 ./minifuse
const outfile = process.env.MINIFUSE_OUTFILE || "minifuse";

try {
  run(["bun", "run", "build:ui"]);
  run(["bun", "build", "--compile", "--minify", "src/main.ts", "--outfile", outfile]);
  console.log(`✓ built ${outfile}`);
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  const leftover = cleanTemps();
  if (leftover) console.log(`cleaned ${leftover} leftover .bun-build file(s)`);
}
