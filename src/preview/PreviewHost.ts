// PreviewHost — M2 预览宿主
//
// 内嵌一个 iframe（真实的浏览器渲染引擎，即设计文档“层0：忠实浏览器渲染”），
// 负责装载 assemblePreviewDocument 生成的 srcdoc、管理生命周期，并把页面
// console/onerror 经 probePageWindow 接入 consoleBridge 面板。同时暴露 emit
// 通道供宿主下发事件数据（对齐真机 C++→JS 推送方向）。

import { assemblePreviewDocument, type PreviewTarget, type MockHandlers } from "./PreviewBootstraper";
import { Emitter, probePageWindow, type BridgeLog } from "./consoleBridge";

export interface HostedFrame {
    mount(target: PreviewTarget, handlers: MockHandlers, contextId: number): void;
    unmount(): void;
    emit(name: string, payload: unknown): boolean;
    reload(): void;
    destroy(): void;
}

/** 管理一个 iframe 预览容器。`logs` 为接收 consoleBridge 日志的 Emitter。 */
export function createPreviewHost(frameEl: HTMLIFrameElement, logs: Emitter<BridgeLog>): HostedFrame {
    let current: PreviewTarget | null = null;
    let handlers: MockHandlers = {};
    let contextId = 0;
    let detachProbe: (() => void) | null = null;

    // 每次装载/重载后，等 iframe 加载完再接线页面日志探针。
    function wireProbe(): void {
        if (detachProbe) {
            detachProbe();
            detachProbe = null;
        }
        const win = frameEl.contentWindow;
        if (!win) return;
        const tryAttach = (): void => {
            if (!frameEl.contentWindow || !frameEl.contentWindow.document?.body) return;
            const w = frameEl.contentWindow;
            // 只在 srcdoc 属于我们时接线，避免探针被导航脚本污染。
            if (w.document.readyState === "complete" || w.document.readyState === "interactive") {
                try {
                    detachProbe = probePageWindow(w, (log) => logs.emit(log));
                    w.addEventListener("load", () => {
                        // load 后 DOM 再稳定一次，重新确保探针在 body 上。
                    });
                } catch {
                    /* 同一窗口重复接线由 probePageWindow 幂等处理 */
                }
            }
        };
        if (frameEl.contentDocument?.readyState === "loading") {
            frameEl.addEventListener("load", tryAttach, { once: true });
        } else {
            tryAttach();
        }
    }

    function load(): void {
        if (!current) return;
        const doc = assemblePreviewDocument(current, handlers, contextId);
        frameEl.srcdoc = doc;
        if (!frameEl.hasAttribute("data-bootstrapped")) {
            frameEl.setAttribute("data-bootstrapped", "1");
            frameEl.addEventListener("load", wireProbe);
        }
    }

    return {
        mount(target, h, ctx) {
            current = target;
            handlers = h;
            contextId = ctx;
            load();
        },
        unmount() {
            current = null;
            if (detachProbe) {
                detachProbe();
                detachProbe = null;
            }
            frameEl.removeAttribute("data-bootstrapped");
            try {
                return frameEl.contentWindow?.location.replace("about:blank");
            } catch {
                frameEl.srcdoc = "<!doctype html><html><body></body></html>";
                return undefined;
            }
        },
        emit(name, payload) {
            const win = frameEl.contentWindow;
            if (!win) return false;
            try {
                // @ts-expect-error -- 同源预览 iframe，直接访问 __PreviewMock__。
                const mock = win.__PreviewMock__;
                if (mock && typeof mock.emit === "function") {
                    mock.emit(name, payload);
                    return true;
                }
            } catch {
                /* 未就绪 */
            }
            return false;
        },
        reload() {
            load();
        },
        destroy() {
            if (detachProbe) {
                detachProbe();
                detachProbe = null;
            }
        },
    };
}