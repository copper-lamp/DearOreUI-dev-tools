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
        fit();
    }

    // 预览屏幕尺寸改为 x / y 单独拖拽：
    // - 右边缘手柄（ew-resize）只改宽度
    // - 下边缘手柄（ns-resize）只改高度
    const handleX = document.createElement("div");
    handleX.className = "resize-handle-x";
    handleX.title = "横向拖拽调整宽度";
    frame.appendChild(handleX);

    const handleY = document.createElement("div");
    handleY.className = "resize-handle-y";
    handleY.title = "纵向拖拽调整高度";
    frame.appendChild(handleY);

    let dragging: "x" | "y" | null = null;
    let startX = 0;
    let startY = 0;
    let startW = DEFAULT_W;
    let startH = DEFAULT_H;

    const beginDrag = (axis: "x" | "y", ev: MouseEvent): void => {
        ev.preventDefault();
        ev.stopPropagation();
        dragging = axis;
        startX = ev.clientX;
        startY = ev.clientY;
        startW = w;
        startH = h;
        wrapper.classList.add("resizing");
    };

    handleX.addEventListener("mousedown", (ev) => beginDrag("x", ev));
    handleY.addEventListener("mousedown", (ev) => beginDrag("y", ev));

    window.addEventListener("mousemove", (ev) => {
        if (!dragging) return;
        // 屏幕被 scale 缩放，物理拖拽距离需除以 scale 换算为逻辑像素
        if (dragging === "x") {
            setSize(startW + (ev.clientX - startX) / scale, h);
        } else {
            setSize(w, startH + (ev.clientY - startY) / scale);
        }
    });

    window.addEventListener("mouseup", () => {
        dragging = null;
        wrapper.classList.remove("resizing");
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