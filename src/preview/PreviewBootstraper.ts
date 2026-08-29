// PreviewBootstraper — M2 预览装配器
//
// 按 设计文档 §2.1c 的装载顺序，把一个 PreviewTarget 装配成一个独立的
// srcdoc 文档（注入到 PreviewHost 的 iframe）：
//   1) 注入 OreuiCompatShim（engine / mock 后端）
//   2) 注入 stage5-runtime.js（真机同一份资产，行为不变）
//   3) 注入 stage7-ui-bootstrap.js（真机同一份资产）
//   4) 解析 domScript → spec.body，挂载到 containerId
//   5) 挂载后执行 pageScript（页面逻辑；用 try/catch 兜内置错误进 consoleBridge）
//
// 真机与预览**同源**：运行时/bootstrap 资产以内置副本（src/runtime-assets）读取，
// 副本由 scripts/sync_runtime_assets.mjs 从核心侧 DearOreUI/assets 同步而来。
// 独立仓库发布时依赖副本，避免跨仓越级导入。

import { shimSource, postStage5PatchSource } from "./OreuiCompatShim";
// ?raw 内联导入，见 vite-env.d.ts 的 *?raw 声明。
import stage5RuntimeRaw from "../runtime-assets/stage5-runtime.js?raw";
import stage7BootstrapRaw from "../runtime-assets/stage7-ui-bootstrap.js?raw";
// 预览布局接管（真 Yoga，见 Docs/DearOreUI-App布局引擎Yoga对齐-需求架构执行.md）
import yogaLayoutPassRaw from "../runtime-assets/yoga-layout-pass.js?raw";

export interface PreviewTarget {
    entry: string;
    title: string;
    kind: string;
    anchor: string;
    page_scopes: string[];
    container_id: string;
    fingerprint: string;
    html_body: string;
    dom_script: string;
    page_script: string;
}

/** 单个 mock 处理器：method -> (args) => any */
export type MockHandler = (args: Record<string, unknown>) => unknown;
export type MockHandlers = Record<string, MockHandler>;

/**
 * 依据 PreviewTarget + mock handlers + 上下文 id，生成 iframe 的 srcdoc。
 */
export function assemblePreviewDocument(target: PreviewTarget, handlers: MockHandlers, contextId: number): string {
    // stage5 的 contextId / bridge 占位符需要替换为当前上下文 id（真机由
    // RuntimeInjector 替换）。预览侧 bridge 视为可用（Shim 提供了 engine）。
    const stage5 = stage5RuntimeRaw
        .split("__DEAROREUI_CTX__").join(String(contextId))
        .split("__DEAROREUI_BRIDGE__").join("true");

    // grep 显示 stage7 也有 __DEAROREUI_CTX__；一并替换以保持一致。
    const stage7 = stage7BootstrapRaw.split("__DEAROREUI_CTX__").join(String(contextId));

    // 把 mock handlers 以字面量方式塞进 __PreviewMock__.handlers。
    // 注意：装配脚本#5 里唯一可用的绑定是 `mock`（== window.__PreviewMock__），并没有
    // 名为 `handlers` 的变量；直接写 `handlers[...]` 会抛 ReferenceError，导致挂载脚本
    // 在定义 bootOnce 之前就中止、没有任何内容渲染。改写到 mock.handlers 上（与 shim 的
    // __PreviewMock__.call 读取 this.handlers 对齐）。
    const handlerList = Object.entries(handlers)
        .map(([m, fn]) => `mock.handlers[${JSON.stringify(m)}] = (${fn.toString()});`)
        .join("\n        ");

    const doc = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
    html, body { margin: 0; padding: 0; height: 100%; }
    body { background: transparent; overflow: hidden; }
</style>
</head>
<body>
<script>
${shimSource()}
</script>
<script>
${stage5}
</script>
<script>
${postStage5PatchSource()}
</script>
<script>
${stage7}
</script>
<script>
(function() {
    // 注入宿主提供的 mock 处理器。
    var mock = window.__PreviewMock__;
    (function() {
        ${handlerList}
    })();

    var dom = (${target.dom_script || "[]"});
    var spec = {
        containerId: ${JSON.stringify(target.container_id || "dearoreui-preview-root")},
        modNamespace: "preview",
        uiId: ${JSON.stringify(target.title)},
        kind: ${JSON.stringify(target.kind)},
        anchorStyle: "top:0;left:0;width:100%;height:100%;",
        pointerEvents: true,
        body: dom,
        scripts: [],
        styles: []
    };
    var ui = window.__DearOreUI__ && window.__DearOreUI__.ui;
    if (!ui || !ui.mount) {
        window.__PreviewMock__.emit("preview:error", { message: "ui machinery missing" });
        return;
    }
    function bootOnce() {
        if (!document.body) return false;
        try {
            ui.specs.push(spec);
            ui.mount(spec);
        } catch (e) {
            window.__PreviewMock__.emit("preview:error", { message: String(e && e.message || e) });
        }
        // 挂载后执行页面脚本（页面逻辑）。eval 在此仅用于离线预览回放；真机走 ExecuteScript。
        var ps = ${JSON.stringify(target.page_script)};
        if (ps) {
            try { window.eval(ps); }
            catch (e) {
                window.__PreviewMock__.emit("preview:error", { message: String(e && e.message || e) });
            }
        }
        window.__PreviewMock__.emit("preview:mounted", { entry: ${JSON.stringify(target.entry)} });
        return true;
    }
    if (!bootOnce()) {
        var iv = window.setInterval(function() {
            if (bootOnce()) window.clearInterval(iv);
        }, 100);
        window.setTimeout(function() { window.clearInterval(iv); }, 15000);
    }
})();
</script>
<script>
    // 挂载后接管布局：父页面注入的真 Yoga 引擎（yoga-layout-pass.js）。
    ${yogaLayoutPassRaw}
</script>
</body>
</html>`;
    return doc;
}