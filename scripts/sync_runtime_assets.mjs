// 从 monorepo 核心侧 DearOreUI/assets 同步运行时资产到本仓库内置副本。
// 用途：独立仓库 CI 构建（无 ../DearOreUI）时依赖 src/runtime-assets 内置副本。
// 用法：node scripts/sync_runtime_assets.mjs
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, "..");
const SRC = join(APP_ROOT, "..", "DearOreUI", "assets"); // 核心侧，本仓库外
const DST = join(APP_ROOT, "src", "runtime-assets");

const FILES = ["stage5-runtime.js", "stage7-ui-bootstrap.js"];

if (!existsSync(SRC)) {
    console.warn(`[sync] 未找到核心侧资产目录：${SRC}`);
    console.warn("[sync] 跳过，保留现有内置副本。");
    process.exit(0);
}

mkdirSync(DST, { recursive: true });
for (const f of FILES) {
    const from = join(SRC, f);
    const to = join(DST, f);
    if (!existsSync(from)) {
        console.warn(`[sync] 缺失源文件：${from}（保留现有副本 ${to}）`);
        continue;
    }
    copyFileSync(from, to);
    console.log(`[sync] ${from}  ->  ${to}`);
}