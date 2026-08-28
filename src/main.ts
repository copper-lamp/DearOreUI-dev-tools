// ORE dev tools 前端入口
// 新布局：顶部菜单 + 左侧资源列表面板 + 右侧画布预览

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { createCanvasView, type CanvasViewHandle } from "./preview/CanvasView";
import { createResourcePanel, type ResourcePanelHandle } from "./preview/ResourcePanel";
import type { PreviewTarget, MockHandlers } from "./preview/PreviewBootstraper";
import { Emitter, type BridgeLog } from "./preview/consoleBridge";

interface ImportedFile {
    rel: string;
    bytes: number;
}

interface ImportResult {
    version: string;
    root: string;
    css: ImportedFile[];
    fonts: ImportedFile[];
    atlas: ImportedFile[];
    screens: ImportedFile[];
    assets: ImportedFile[];
    screen_ids: string[];
    total_bytes: number;
    errors: string[];
    ok: boolean;
}

interface ModScanResult {
    targets: PreviewTarget[];
    files: string[];
    warnings: string[];
    path: string;
    ok: boolean;
}

const $ = <T extends HTMLElement>(sel: string): T => {
    const el = document.querySelector<T>(sel);
    if (!el) throw new Error(`找不到元素: ${sel}`);
    return el;
};

// ---------------------------------------------------------------------------
// 即时反馈：toast + 当前目录显示
// ---------------------------------------------------------------------------

const toastEl = $<HTMLDivElement>("#toast");
let toastTimer: number | undefined;

function showToast(text: string, kind: "error" | "ok" | "info" = "info"): void {
    toastEl.textContent = text;
    toastEl.className = `toast show ${kind}`;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 3200);
}

const dirWrapEl = $<HTMLDivElement>("#resource-dir");
const dirPathEl = $<HTMLSpanElement>("#resource-dir-path");

function updateDirDisplay(dir: string): void {
    if (!dir) {
        dirWrapEl.classList.add("hidden");
        return;
    }
    dirPathEl.textContent = dir;
    dirWrapEl.classList.remove("hidden");
}

/** 把 tauri invoke 的报错简化为去前缀的可读信息。 */
function friendlyErr(e: unknown): string {
    const s = String(e);
    const m = s.match(/(?:failed|Error)[:\s]+([\s\S]*)$/i);
    const detail = m ? m[1].trim() : "";
    return detail || s;
}

const escapeHtml = (s: string): string =>
    s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

function defaultMocks(target: PreviewTarget): MockHandlers {
    return {
        "preview:getState": () => ({ title: target.title, kind: target.kind, entry: target.entry }),
    };
}

function bytesToMB(n: number): string {
    return (n / (1024 * 1024)).toFixed(2) + " MB";
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

const logContent = $<HTMLDivElement>("#log-content");
const logEmitter = new Emitter<BridgeLog>();

function appendLog(log: BridgeLog): void {
    const line = document.createElement("div");
    line.className = `log-line ${log.kind === "error" ? "error" : log.kind === "warn" ? "warn" : ""}`;
    const tag = document.createElement("span");
    tag.className = "log-tag";
    tag.textContent = `[${log.kind}]`;
    line.appendChild(tag);
    line.appendChild(document.createTextNode(log.text));
    logContent.appendChild(line);
    logContent.scrollTop = logContent.scrollHeight;
}

logEmitter.on((l) => appendLog(l));

function plotLog(kind: BridgeLog["kind"], text: string): void {
    logEmitter.emit({ kind, text, source: "host" });
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

const resourcePanel: ResourcePanelHandle = createResourcePanel(
    $<HTMLElement>("#resource-panel"),
    {
        onSelect(target) {
            canvasView.mount(target, defaultMocks(target), 1);
            plotLog("info", `选中资源：${target.title || target.entry} (${target.kind})`);
        },
    },
);

const canvasView: CanvasViewHandle = createCanvasView(
    $<HTMLElement>("#canvas-wrapper"),
    $<HTMLElement>("#screen-frame"),
    $<HTMLElement>("#screen-body"),
    $<HTMLElement>("#screen-header"),
    $<HTMLElement>("#status-screen"),
    logEmitter,
);

// ---------------------------------------------------------------------------
// 资产加载
// ---------------------------------------------------------------------------

let currentTargets: PreviewTarget[] = [];
let previewDir = localStorage.getItem("dearoreui.previewDir") || "";

/** 记录当前选择并让 Rust 监听该目录的源码改动（*.h/*.cpp 等）。 */
async function relayWatch(dir: string): Promise<void> {
    try {
        await invoke("stop_watch");
        await invoke("start_watch", { dir });
    } catch (e) {
        plotLog("warn", `文件监听启动失败（仍可手动刷新）：${friendlyErr(e)}`);
    }
}

/**
 * 统一加载入口：选择目录 / 刷新按钮 / 文件改动自动刷新 都走这里。
 * 打开目录即自动识别模组 UI（源码静态扫描，模组零改动）。
 */
async function loadProject(dir: string): Promise<void> {
    if (!dir) {
        showToast("请先选择模组目录（项目 > 打开模组目录…）", "error");
        plotLog("error", "请先设置预览目录（项目 > 打开模组目录）");
        return;
    }
    previewDir = dir;
    localStorage.setItem("dearoreui.previewDir", dir);
    settingsInput.value = dir;
    updateDirDisplay(dir);

    // 保留当前选中，便于自动刷新后仍聚焦原预览。
    const prevSelected = resourcePanel.getSelected()?.entry ?? null;

    try {
        const r = await invoke<ModScanResult>("scan_mod_ui", { dir });
        currentTargets = r.targets;
        resourcePanel.setTargets(currentTargets);
        await relayWatch(dir);

        if (currentTargets.length > 0) {
            if (prevSelected && currentTargets.some((t) => t.entry === prevSelected)) {
                resourcePanel.select(prevSelected);
            } else {
                resourcePanel.select(currentTargets[0].entry);
            }
            showToast(`已识别 ${currentTargets.length} 个 UI（${dir}）`, "ok");
        } else {
            showToast("未识别到 UI：请确认为 DearOreUI 模组源码目录（含 registerComponent 注册）。", "error");
        }
        if (r.warnings.length > 0) {
            plotLog("warn", `扫描告警：${r.warnings.join("；")}`);
        }
        plotLog("info", `扫描 ${r.files.length} 个源文件，识别 ${r.targets.length} 个 UI（${dir}）`);
    } catch (e) {
        const msg = friendlyErr(e);
        plotLog("error", `载入/扫描失败：${msg}`);
        showToast(`载入/扫描失败：${msg}`, "error");
    }
}

// ---------------------------------------------------------------------------
// 标题栏菜单
// ---------------------------------------------------------------------------

function closeAllMenus(): void {
    document.querySelectorAll(".titlebar-menu.open").forEach((el) => el.classList.remove("open"));
}

document.querySelectorAll(".titlebar-menu").forEach((menu) => {
    menu.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const wasOpen = menu.classList.contains("open");
        closeAllMenus();
        if (!wasOpen) menu.classList.add("open");
    });
});

window.addEventListener("click", closeAllMenus);

// 项目 > 打开模组目录（系统文件夹选择器）→ 自动识别并监听
$<HTMLDivElement>("#menu-open-project").addEventListener("click", async () => {
    try {
        const sel = await open({
            directory: true,
            multiple: false,
            title: "请选择模组目录（将自动识别其中的 UI）",
        });
        if (typeof sel !== "string" || !sel) return; // 用户取消
        plotLog("info", `已选择模组目录：${sel}`);
        void loadProject(sel);
    } catch (e) {
        plotLog("error", `选择目录失败：${String(e)}`);
    }
});

// 项目 > 导入原版资源
const importDialog = $<HTMLDialogElement>("#import-dialog");
$<HTMLDivElement>("#menu-import-vanilla").addEventListener("click", () => {
    importDialog.showModal();
});
$<HTMLButtonElement>("#import-cancel").addEventListener("click", () => {
    importDialog.close();
});
$<HTMLButtonElement>("#import-confirm").addEventListener("click", async () => {
    const source = $<HTMLInputElement>("#import-source").value.trim();
    const version = $<HTMLInputElement>("#import-version").value.trim();
    const resultEl = $<HTMLDivElement>("#import-result");
    if (!source) {
        resultEl.innerHTML = '<span style="color:var(--err);">请填写游戏数据目录。</span>';
        return;
    }
    resultEl.textContent = "导入中…";
    try {
        const r = await invoke<ImportResult>("import_vanilla", { source, dest: "./vanilla", version });
        const parts: string[] = [];
        parts.push(`导入完成（版本 ${escapeHtml(r.version)}）`);
        parts.push(`落地目录：${escapeHtml(r.root)}`);
        parts.push(
            `数量：CSS ${r.css.length} · 字体 ${r.fonts.length} · atlas ${r.atlas.length} · 屏幕 ${r.screens.length} · 其它 ${r.assets.length} · 合计 ${bytesToMB(r.total_bytes)}`,
        );
        if (r.errors.length) {
            parts.push(`错误：${r.errors.slice(0, 8).map(escapeHtml).join("; ")}`);
        }
        resultEl.innerHTML = parts.map((p) => escapeHtml(p)).join("<br/>");
        plotLog("info", `原版资源导入完成：${r.screens.length} 个屏幕`);
    } catch (e) {
        resultEl.innerHTML = `<span style="color:var(--err);">导入失败：${escapeHtml(String(e))}</span>`;
    }
});

// 项目 > 原版改造（占位：后续里程碑补齐完整基底装载）
$<HTMLDivElement>("#menu-vanilla-overlay").addEventListener("click", () => {
    plotLog("info", "原版改造功能将在后续里程碑实现完整 vanilla 屏幕基底装载。");
});

// 项目 > 重新载入资产（刷新按钮）
$<HTMLDivElement>("#menu-reload-assets").addEventListener("click", () => {
    if (!previewDir) {
        showToast("请先打开模组目录", "error");
        return;
    }
    plotLog("info", "手动刷新…");
    void loadProject(previewDir);
});

// 设置 > 设置预览目录
const settingsDialog = $<HTMLDialogElement>("#settings-dialog");
const settingsInput = $<HTMLInputElement>("#settings-preview-dir");
$<HTMLDivElement>("#menu-set-preview-dir").addEventListener("click", () => {
    settingsInput.value = previewDir;
    settingsDialog.showModal();
});
$<HTMLButtonElement>("#settings-cancel").addEventListener("click", () => {
    settingsDialog.close();
});
$<HTMLButtonElement>("#settings-confirm").addEventListener("click", () => {
    const dir = settingsInput.value.trim();
    settingsDialog.close();
    if (!dir) return;
    void loadProject(dir);
});

// 帮助 > 页面日志
const logDrawer = $<HTMLDivElement>("#log-drawer");
$<HTMLDivElement>("#menu-toggle-logs").addEventListener("click", () => {
    logDrawer.classList.toggle("open");
});
$<HTMLSpanElement>("#log-drawer-close").addEventListener("click", () => {
    logDrawer.classList.remove("open");
});

// ---------------------------------------------------------------------------
// 左侧资源列表面板折叠
// ---------------------------------------------------------------------------

const resourcePanelEl = $<HTMLElement>("#resource-panel");
const resourceToggle = $<HTMLButtonElement>("#resource-toggle");
let resourceCollapsed = false;

resourceToggle.addEventListener("click", () => {
    resourceCollapsed = !resourceCollapsed;
    resourcePanelEl.classList.toggle("collapsed", resourceCollapsed);
    const icon = $<SVGElement>("#resource-toggle-icon");
    icon.style.transform = resourceCollapsed ? "rotate(180deg)" : "";
    resourceToggle.title = resourceCollapsed ? "展开" : "折叠";
});

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

plotLog("info", "ORE dev tools 已就绪");

// ---------------------------------------------------------------------------
// 自定义标题栏：最小化 / 最大化还原 / 关闭 + 空白区拖拽移动窗口
// ---------------------------------------------------------------------------
const appWindow = getCurrentWindow();

function runWinAction(action: () => Promise<void>): void {
    action().catch((e) => {
        console.error("[titlebar] window action failed:", e);
    });
}

$<HTMLButtonElement>("#win-min").addEventListener("click", () => {
    runWinAction(() => appWindow.minimize());
});
$<HTMLButtonElement>("#win-max").addEventListener("click", () => {
    runWinAction(() => appWindow.toggleMaximize());
});
$<HTMLButtonElement>("#win-close").addEventListener("click", () => {
    runWinAction(() => appWindow.close());
});

// 标题栏空白区域（品牌/空白处，非按钮、非菜单）按住左键即可拖动窗口。
document.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    // 交互元素不触发窗口拖动
    if (target.closest("button, .titlebar-menu, .dropdown, input, .resource-panel, iframe")) return;
    // 仅标题栏区域可拖动
    if (!target.closest(".titlebar")) return;
    ev.preventDefault();
    runWinAction(() => appWindow.startDragging());
});

// ---------------------------------------------------------------------------
// 文件改动自动刷新（近似 Web 开发 HMR）
// ---------------------------------------------------------------------------
let reloadTimer: number | undefined;
void listen("mod-source-changed", () => {
    if (!previewDir) return;
    if (reloadTimer) window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
        plotLog("info", "检测到源码改动，自动刷新…");
        void loadProject(previewDir);
    }, 400);
});

if (previewDir) {
    settingsInput.value = previewDir;
    void loadProject(previewDir);
}
