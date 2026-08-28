// ResourcePanel —— 左侧可折叠资源列表
//
// 渲染从核心层导出的 uiAssets.json 条目，点击后在右侧 Canvas 中预览对应 UI。

import type { PreviewTarget } from "./PreviewBootstraper";

export interface ResourcePanelCallbacks {
    onSelect(target: PreviewTarget): void;
}

export interface ResourcePanelHandle {
    setTargets(targets: PreviewTarget[]): void;
    select(entry: string): void;
    getSelected(): PreviewTarget | null;
    destroy(): void;
}

export function createResourcePanel(
    container: HTMLElement,
    cb: ResourcePanelCallbacks,
): ResourcePanelHandle {
    let targets: PreviewTarget[] = [];
    let selected: PreviewTarget | null = null;

    const listEl = container.querySelector<HTMLElement>("#resource-list")!;

    function render(): void {
        listEl.innerHTML = "";
        if (targets.length === 0) {
            listEl.innerHTML =
                '<div class="resource-empty">未载入资产。请通过“项目 &gt; 设置预览目录”指定 DearOreUI 数据目录。</div>';
            return;
        }
        for (const t of targets) {
            const item = document.createElement("div");
            item.className = "resource-item";
            item.dataset.entry = t.entry;
            if (selected && selected.entry === t.entry) {
                item.classList.add("selected");
            }

            const left = document.createElement("div");
            const name = document.createElement("div");
            name.className = "resource-item-name";
            name.textContent = t.title || t.entry;
            const path = document.createElement("div");
            path.className = "resource-item-path";
            path.textContent = t.kind + " · " + t.anchor;
            left.appendChild(name);
            left.appendChild(path);

            item.appendChild(left);
            item.addEventListener("click", () => select(t.entry));
            listEl.appendChild(item);
        }
    }

    function select(entry: string): void {
        const t = targets.find((x) => x.entry === entry);
        if (!t) return;
        selected = t;
        render();
        cb.onSelect(t);
    }

    return {
        setTargets(ts) {
            targets = ts;
            selected = null;
            render();
        },
        select,
        getSelected() {
            return selected;
        },
        destroy() {
            listEl.innerHTML = "";
        },
    };
}
