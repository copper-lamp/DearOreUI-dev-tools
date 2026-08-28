// OreuiCompatShim — M2 预览垫片
//
// 职责：在浏览器预览 iframe 里模拟真实客户端里**由宿主提供**的那部分环境，
// 使得同一份 stage5-runtime.js / stage7-ui-bootstrap.js / pageScript 可以
// 原样运行（真机与预览同源）。设计文档 §2.3。
//
// 具体提供：
//   1. `window.engine.trigger('facet:request', ...)` — 让 stage5-runtime.js 在
//      加载时判定 `hasFacet = true`（真实客户端里这是 Coherent Gameface 引擎）。
//      预览里 engine.trigger 解码 facade 请求并路由到本地 mock 后端。
//   2. `window.__PreviewMock__` — 预览宿主（PreviewHost）注入 mock 处理器与
//      事件数据源用的钩子；call/事件推送都走它。
//   3. 不模拟 facet “每视图单发”的崩溃语义（预览允许多次往返，见设计文档 1.3）。
//
// 本文件导出一个返回 JS 源码字符串的函数，由 PreviewBootstraper 原样内联。

/**
 * 生成 Shim 脚本源码。不依赖预览宿主的任何绑定，只读 window / document。
 */
export function shimSource(): string {
    return `(function() {
    // ---- 1. engine：让 stage5-runtime 判定 facet 可用，并把请求路由到本地 mock ----
    window.__PreviewMock__ = {
        handlers: {},           // method -> (args) => any
        pushData: {},           // 保留：宿主可直接调用 window.__PreviewMock__.emit(name, payload)
        emit: function(name, payload) {
            var bus = window.__DearOreUI__ && window.__DearOreUI__.events;
            if (bus && bus.push) { try { bus.push(name, payload); } catch (e) {} }
        },
        call: function(method, args) {
            var h = this.handlers[method];
            if (typeof h === 'function') {
                try { return h(args); } catch (e) { return { error: 1, message: String(e && e.message || e) }; }
            }
            // 未注册的方法：返回一个带 preview 标记的占位响应，方便宿主诊断遗漏。
            return { preview: true, unhandled: method, args: args };
        }
    };

    window.engine = window.engine || {};
    window.engine.trigger = function(event /* , owner, ns, payload */) {
        if (event !== 'facet:request') return;
        // 真实客户端调用形式：engine.trigger('facet:request','dearoreui','dearoreui',{params})
        var args = arguments;
        var payload = args.length >= 4 ? args[3] : (args[0] && args[0].params ? args[0] : null);
        var params = payload && payload.params;
        if (typeof params === 'string') params = JSON.parse(params);

        var req = null;
        try { req = typeof params === 'string' ? JSON.parse(params) : params; }
        catch (e) { return; }
        if (!req || typeof req !== 'object') return;

        if (req.type === 'request') {
            var argsForHandler = {};
            if (req.payload) {
                try { argsForHandler = JSON.parse(req.payload); } catch (e) { argsForHandler = { _raw: req.payload }; }
            }
            var resp = window.__PreviewMock__.call(req.method, argsForHandler);
            var mobile = {
                type: 'response',
                id: req.id,
                error: (resp && resp.error) ? 1 : 0,
                payload: JSON.stringify(resp)
            };
            // 让 stage5 注册在 bus 上的 Promise 回调被触发。
            window.setTimeout(function() {
                var bus = window.__DearOreUI__ && window.__DearOreUI__.bus;
                if (bus && bus.push) { try { bus.push(String(req.id), JSON.stringify(mobile)); } catch (e) {} }
            }, 0);
        }
        // req.type === 'report' 单向：无需回包
    };
})();`;
}

/** 注入 stage5 运行后需要的一次性补丁：允许预览里多次 callHost 往返。 */
export function postStage5PatchSource(): string {
    return `(function() {
    var ipc = window.__DearOreUI__ && window.__DearOreUI__.ipc;
    if (!ipc) return;
    var orig = ipc.callHost;
    ipc.callHost = function(method, args) {
        // 预览不模拟 “每视图单发”，每次调用都允许重新 dispatch。
        window.__DearOreUI__.dispatchUsed = false;
        return orig.call(this, method, args);
    };
})();`;
}