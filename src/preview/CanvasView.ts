// CanvasView —— 右侧模拟器画布
//
// 中间浅色矩形即「模拟的游戏屏幕画布」，展示选中 UI 的离线预览。
//
// 尺寸适配：屏幕始终**自动适配**可视区 —— 用 transform scale 等比缩放，使整块
// 屏幕完整显示在右侧区域中央，四周留 20px 空白，**绝不出现滚动框**。
//
// 拖拽 = 改变屏幕的逻辑分辨率：拖动屏幕右下角手柄改变（宽高）像素，检查 UI 在
// 不同分辨率下的布局适配；改完后重新自动适配可视区。

import { createPreviewHost, type HostedFrame } from "./PreviewHost";
import type { PreviewTarget, MockHandlers } from "./PreviewBootstraper";
import { Emitter, type BridgeLog } from "./consoleBridge";

const DEFAULT_W = 1920;
const DEFAULT_H = 1080;
const MIN_W = 320;
const MIN_H = 180;
const MAX_W = 4096;
const MAX_H = 3072;
const PAD = 20; // 四周留白 px

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export interface CanvasViewHandle {
    mount(target: PreviewTarget, handlers: MockHandlers, ctx: number): void;
    unmount(): void;
    resetSize(): void;
}

export function createCanvasView(
    wrapper: HTMLElement,
    frame: HTMLElement,
    screenBody: HTMLElement,
    screenHeader: HTMLElement,
    statusScreen: HTMLElement,
    logEmitter: Emitter<BridgeLog>,
): CanvasViewHandle {
    let w = DEFAULT_W;
    let h = DEFAULT_H;
    let scale = 1;

    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.sandbox = "allow-scripts allow-same-origin";
    iframe.title = "DearOreUI 离线预览";

    const hostedFrame: HostedFrame = createPreviewHost(iframe, logEmitter);

    // ===== 常用分辨率快捷下拉 =====
    // 值格式 "WxH";"custom" 一项用于表示"当前分辨率不在预设列表"。
    const PRESETS: Array<[number, number]> = [
        [3840, 2160],
        [2560, 1440],
        [1920, 1080],
        [1600, 900],
        [1366, 768],
        [1280, 720],
        [1024, 768],
        [960, 540],
        [720, 1280],
        [1080, 1920],
        [480, 854],
        [360, 800],
    ];
    const select = document.createElement("select");
    select.className = "resize-preset";
    select.title = "快捷选择常用分辨率";
    for (const [pw, ph] of PRESETS) {
        const o = document.createElement("option");
        o.value = `${pw}x${ph}`;
        o.textContent = `${pw} × ${ph}`;
        select.appendChild(o);
    }
    const customOpt = document.createElement("option");
    customOpt.value = "custom";
    select.appendChild(customOpt);
    // 挂到状态栏、"屏幕 1920*1080"文本的右侧。
    statusScreen.parentElement?.insertBefore(select, statusScreen.nextSibling);

    /** 让下拉始终反映当前分辨率；当前不在预设时选中并刷新"自定义"项标签。 */
    function updateSelect(): void {
        const key = `${w}x${h}`;
        for (const o of select.options) {
            if (o.value === key) {
                select.value = key;
                return;
            }
        }
        const c = select.querySelector<HTMLOptionElement>('option[value="custom"]');
        if (c) c.textContent = `${w} × ${h}`;
        select.value = "custom";
    }

    select.addEventListener("change", () => {
        const v = select.value;
        if (v === "custom") return;
        const idx = v.indexOf("x");
        if (idx <= 0) return;
        setSize(Number(v.slice(0, idx)), Number(v.slice(idx + 1)));
    });

    /** 自动适配可视区：等比缩放使整块屏幕完整显示，四周留 PAD 空白，无滚动框。 */
    function fit(): void {
        const vw = wrapper.clientWidth;
        const vh = wrapper.clientHeight;
        const availW = Math.max(1, vw - PAD * 2);
        const availH = Math.max(1, vh - PAD * 2);
        scale = Math.min(availW / w, availH / h);
        frame.style.transform = `scale(${scale})`;
        frame.style.transformOrigin = "center center";
    }

    function setSize(nw: number, nh: number, updateStatus = true): void {
        w = clamp(Math.round(nw), MIN_W, MAX_W);
        h = clamp(Math.round(nh), MIN_H, MAX_H);
        frame.style.width = w + "px";
        frame.style.height = h + "px";
        if (updateStatus) statusScreen.textContent = `屏幕 ${w}*${h}`;
        updateSelect();
        fit();
    }

    // 预览屏幕尺寸改为 x / y 单独拖拽：
    // - 右边缘手柄（ew-resize）只改宽度
    // - 下边缘手柄（ns-resize）只改高度
    //
    // 拖拽性能策略（不跟手 / 卡顿的修复）：
    // 1. 拖拽期间固定 dragScale：换算用「拖拽开始时的 scale」，避免 scale 随尺寸实时
    //    变化造成非线性换算，保证手柄线性跟手。
    // 2. mousemove 经 requestAnimationFrame 合并，每帧最多写一次 DOM。
    // 3. 拖拽中**不反复 fit()**（不同步重算 transform / 重排），仅 mouseup 时收敛一次；
    //    这样拖拽期间只改 frame 的宽高、iframe 预览保持上一次分辨率，显著降低重排成本。
    const handleX = document.createElement("div");
    handleX.className = "resize-handle-x";
    handleX.title = "横向拖拽调整宽度";
    frame.appendChild(handleX);

    const handleY = document.createElement("div");
    handleY.className = "resize-handle-y";
    handleY.title = "纵向拖拽调整高度";
    frame.appendChild(handleY);

    let dragging: "x" | "y" | null = null;
    let startPX = 0;
    let startPY = 0;
    let startW = DEFAULT_W;
    let startH = DEFAULT_H;
    let dragScale = 1;
    let rafPending = false;
    let pendingCX = 0;
    let pendingCY = 0;
    // 锁定态：拖拽时用 Pointer Lock 钉住物理指针，靠相对位移累计驱动尺寸，
    // 指针不会跑到预览 iframe / 窗口外导致拖拽中断。
    let locked = false;
    let accX = 0;
    let accY = 0;

    const beginDrag = (axis: "x" | "y", ev: MouseEvent): void => {
        ev.preventDefault();
        ev.stopPropagation();
        dragging = axis;
        startPX = ev.clientX;
        startPY = ev.clientY;
        startW = w;
        startH = h;
        dragScale = scale; // 拖引用开始时的缩放，保证线性跟手
        accX = 0;
        accY = 0;
        // 拖拽期间禁用 iframe 指针接收，指针即使经过预览区域也不中断。
        iframe.style.pointerEvents = "none";
        wrapper.classList.add("resizing");
        // 尝试锁定指针（mousedown 为合法用户手势）。
        locked = false;
        const el = wrapper as HTMLElement & { requestPointerLock?: () => void };
        if (typeof el.requestPointerLock === "function") {
            try {
                el.requestPointerLock();
                locked = true;
            } catch {
                locked = false;
            }
        }
    };

    handleX.addEventListener("mousedown", (ev) => beginDrag("x", ev));
    handleY.addEventListener("mousedown", (ev) => beginDrag("y", ev));

    function flushDrag(): void {
        rafPending = false;
        if (!dragging) return;
        if (locked) {
            // 锁定态：相对位移累计 → 逻辑像素。
            if (dragging === "x") {
                w = clamp(Math.round(startW + accX / dragScale), MIN_W, MAX_W);
            } else {
                h = clamp(Math.round(startH + accY / dragScale), MIN_H, MAX_H);
            }
        } else {
            // 非锁定回退：绝对坐标差 → 逻辑像素。
            if (dragging === "x") {
                w = clamp(Math.round(startW + (pendingCX - startPX) / dragScale), MIN_W, MAX_W);
            } else {
                h = clamp(Math.round(startH + (pendingCY - startPY) / dragScale), MIN_H, MAX_H);
            }
        }
        frame.style.width = w + "px";
        frame.style.height = h + "px";
        statusScreen.textContent = `屏幕 ${w}*${h}`;
    }

    window.addEventListener("mousemove", (ev) => {
        if (!dragging) return;
        if (locked) {
            accX += ev.movementX;
            accY += ev.movementY;
        } else {
            pendingCX = ev.clientX;
            pendingCY = ev.clientY;
        }
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(flushDrag);
    });

    function endDrag(): void {
        if (!dragging) return;
        dragging = null;
        wrapper.classList.remove("resizing");
        iframe.style.pointerEvents = "";
        if (locked) {
            locked = false;
            if (document.exitPointerLock) document.exitPointerLock();
        }
        // 收敛：一次 fit 重排预览到新分辨率。
        fit();
        updateSelect();
        statusScreen.textContent = `屏幕 ${w}*${h}`;
    }

    window.addEventListener("mouseup", endDrag);
    // 锁定被外部打断（如按 Esc）且仍处于拖拽 → 中止并收敛。
    document.addEventListener("pointerlockchange", () => {
        if (locked && document.pointerLockElement !== wrapper && dragging) {
            locked = false;
            endDrag();
        }
    });
    document.addEventListener("pointerlockerror", () => {
        locked = false; // 锁定请求失败，回退到绝对坐标模式。
    });

    window.addEventListener("resize", fit);

    setSize(DEFAULT_W, DEFAULT_H, false);

    return {
        mount(target, handlers, ctx) {
            screenBody.innerHTML = "";
            screenBody.appendChild(iframe);
            hostedFrame.mount(target, handlers, ctx);
            screenHeader.textContent = target.title || target.entry || "ui资源";
        },
        unmount() {
            hostedFrame.unmount();
            screenBody.innerHTML =
                '<div class="screen-placeholder">请从左侧资源列表选择一个 UI 进行预览</div>';
            screenHeader.textContent = "ui资源";
        },
        resetSize() {
            setSize(DEFAULT_W, DEFAULT_H);
        },
    };
}