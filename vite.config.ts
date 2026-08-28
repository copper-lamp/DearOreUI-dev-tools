import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        // 允许从 monorepo 根目录导入共享资产（DearOreUI/assets/*.js?raw）与
        // 本地 VFS（vanilla 导入产物），保证“真机与预览同源”。
        fs: { allow: [".."] },
        hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
        watch: { ignored: ["**/src-tauri/**"] },
    },
});