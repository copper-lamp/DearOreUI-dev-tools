// consoleBridge — M2 可观测性：把页面 console/onerror 接入设计工具面板
//
// 预览 iframe 与宿主同源（Vite dev 下同端口的前提成立），因此我们直接用
// iframe.contentWindow 包裹 console.* / window.onerror / unhandledrejection，
// 把日志回传到宿主的 Emitter。若跨源则回退为 postMessage（跨源回退在本期
// 只做基础通道，完整 sourcemap 行号还原留待 M3）。

export type BridgeLogKind = "log" | "warn" | "error" | "info" | "debug";

export interface BridgeLog {
    kind: BridgeLogKind;
    text: string;
    source: "page" | "host";
}

/** 极简类型安全事件发射器。 */
export class Emitter<T> {
    private listeners = new Set<(v: T) => void>();

    on(fn: (v: T) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit(v: T): void {
        for (const fn of [...this.listeners]) {
            try {
                fn(v);
            } catch {
                /* 忽略监听器内部错误 */
            }
        }
    }
}

function fmt(args: unknown[]): string {
    return args
        .map((a) => (typeof a === "string" ? a : safeStringify(a)))
        .filter((s) => s !== "")
        .join(" ");
}

function safeStringify(v: unknown): string {
    try {
        if (typeof v === "string") return v;
        if (v instanceof Error) return `${v.name}: ${v.message}`;
        const s = JSON.stringify(v);
        return s === undefined ? String(v) : s;
    } catch {
        return String(v);
    }
}

/**
 * 在预览 iframe 的 contentWindow 里安装页面级 console/错误捕获。
 * 返回移除这些补丁的函数（预览宿主销毁时调用）。
 */
export function probePageWindow(win: Window, emit: (log: BridgeLog) => void): () => void {
    const patchLog = (orig: (...a: unknown[]) => void, kind: BridgeLogKind) =>
        (function (this: unknown, ...args: unknown[]) {
            let text = "";
            try {
                text = fmt(args);
            } catch {
                text = "";
            }
            if (kind !== "debug" || text !== "") emit({ kind, text, source: "page" });
            if (typeof orig === "function") orig.apply(this, args);
        });

    const consoleObj = win.console as unknown as Record<string, unknown>;
    const originals: { name: string; fn: unknown }[] = [];
    const kindByName: Record<string, BridgeLogKind> = {
        log: "log",
        info: "info",
        warn: "warn",
        debug: "debug",
        error: "error",
    };

    for (const [name, kind] of Object.entries(kindByName)) {
        const orig = (consoleObj as Record<string, (...a: unknown[]) => void>)[name];
        if (typeof orig !== "function") continue;
        originals.push({ name, fn: orig });
        (consoleObj as Record<string, unknown>)[name] = patchLog(orig, kind);
    }

    const onError = (ev: ErrorEvent): void => {
        const line = ev.lineno != null ? `:${ev.lineno}:${ev.colno}` : "";
        emit({ kind: "error", text: `[window.onerror] ${ev.message}${line}`, source: "page" });
    };
    const onRejection = (ev: PromiseRejectionEvent): void => {
        emit({ kind: "error", text: `[unhandledrejection] ${safeStringify(ev.reason)}`, source: "page" });
    };
    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);

    return () => {
        win.removeEventListener("error", onError);
        win.removeEventListener("unhandledrejection", onRejection);
        for (const { name, fn } of originals) {
            (consoleObj as Record<string, unknown>)[name] = fn;
        }
    };
}

export { safeStringify };