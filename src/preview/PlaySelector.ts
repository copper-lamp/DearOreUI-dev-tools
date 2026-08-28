// PlaySelector — M2 侧边标签页选择器
//
// 设计文档 §1.7 / §2.1c：列出可预览的模组 UI（来自 uiAssets.json；该清单由
// DearOreUI 核心在 registerComponent 成功后台自动导出，故只含模组**改动过**
// 的页面，未改动的页面不存在于清单，天然隐藏、无覆盖面歧义）。支持两类：
//   A. 独立 UI（standalone）——直接预览该条目。
//   B. 原版改造（overrideOn）——选中原版屏幕 + 已存在 overlay 条目组合装载。
//
// 触发选择回调时返回 { target, kind }，由外部接线到 PreviewHost。

import type { PreviewTarget } from "./PreviewBootstraper";
import type { MockHandlers } from "./PreviewBootstraper";

export interface SelectOption {
    key: string;
    group: string; // "独立 UI" | "原版改造"
    kind: "standalone" | "overrideOn";
    label: string;
    hint: string;
    target: PreviewTarget | null;
    overlayTarget: PreviewTarget | null; // 仅 overrideOn
}

export interface SelectorCallbacks {
    onSelect(option: SelectOption): void;
    /** 构建本地 mock 处理器（宿主可再叠加默认 mock）。 */
    buildMocks(target: PreviewTarget): MockHandlers;
}

/** 纯 TS 挂载选项（与消费方解耦，方便单测）。 */
export function buildOptions(targets: PreviewTarget[], vanillaScreens: string[]): SelectOption[] {
    const opts: SelectOption[] = [];

    // A. 独立 UI
    for (const t of targets) {
        opts.push({
            key: `standalone:${t.entry}`,
            group: "独立 UI",
            kind: "standalone",
            label: t.title || t.entry,
            hint: `${t.kind} · ${t.anchor}`,
            target: t,
            overlayTarget: null,
        });
    }

    // B. 原版改造：原版屏幕 × 已改动 overlay（overlay 也来自 uiAssets，即“改动过”）
    for (const screen of vanillaScreens) {
        for (const t of targets) {
            opts.push({
                key: `override:${screen}:${t.entry}`,
                group: "原版改造",
                kind: "overrideOn",
                label: `${screen} + ${t.title || t.entry}`,
                hint: `原版屏幕 ${screen} 叠加 ${t.kind}`,
                target: null,
                overlayTarget: t,
            });
        }
    }

    return opts;
}

export interface PlaySelectorHandle {
    /** 用新数据重建选项列表（uiAssets / vanilla 屏幕变化时调用）。 */
    setTargets(targets: PreviewTarget[], vanillaScreens: string[]): void;
    /** 以编程方式选中某选项（key）。 */
    select(key: string): void;
    getSelected(): SelectOption | null;
    destroy(): void;
}

/**
 * 在容器里渲染侧边标签页列表。`opts` 为当前选项，`onSelect` 在选中时回调。
 */
export function createPlaySelector(
    container: HTMLElement,
    opts: SelectOption[],
    cb: SelectorCallbacks,
): PlaySelectorHandle {
    let options: SelectOption[] = opts;
    let selected: SelectOption | null = null;

    const listEl = document.createElement("div");
    listEl.className = "ps-list";
    container.appendChild(listEl);

    function renderGroup(group: string): void {
        const groupEl = document.createElement("div");
        groupEl.className = "ps-group";
        const titleEl = document.createElement("div");
        titleEl.className = "ps-group-title";
        titleEl.textContent = group;
        groupEl.appendChild(titleEl);
        const items = options.filter((o) => o.group === group);
        for (const it of items) {
            const item = document.createElement("div");
            item.className = "ps-item";
            item.dataset.key = it.key;
            if (selected && selected.key === it.key) item.classList.add("selected");
            const label = document.createElement("div");
            label.className = "ps-item-label";
            label.textContent = it.label;
            const hint = document.createElement("div");
            hint.className = "ps-item-hint";
            hint.textContent = it.hint;
            item.appendChild(label);
            item.appendChild(hint);
            item.addEventListener("click", () => select(it.key));
            groupEl.appendChild(item);
        }
        listEl.appendChild(groupEl);
    }

    function render(): void {
        listEl.innerHTML = "";
        const groups = [...new Set(options.map((o) => o.group))];
        groups.sort((a, b) => (a.includes("独立") ? -1 : 1) - (b.includes("独立") ? -1 : 1));
        for (const g of groups) renderGroup(g);
    }

    function select(key: string): void {
        const it = options.find((o) => o.key === key);
        if (!it) return;
        selected = it;
        render();
        cb.onSelect(it);
    }

    return {
        setTargets(targets, vanillaScreens) {
            options = buildOptions(targets, vanillaScreens);
            selected = null;
            render();
        },
        select,
        getSelected() {
            return selected;
        },
        destroy() {
            container.removeChild(listEl);
        },
    };
}