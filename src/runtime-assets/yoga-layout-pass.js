(function () {
  // yoga-layout-pass —— 预览 iframe 内联布局接管
  //
  // 挂载脚本把 UI 构建进容器后，本脚本接续执行一次 Yoga 构图（把几何写回
  // DOM，绝对定位），使预览与游戏引擎同语义。
  //
  // 尺寸适配：页面脚本（ex02/ex03/ex04）自身监听 window.resize，在分辨率变化
  // 时按新视口重建 buildLayout（绝对定位精确像素），与游戏内随屏幕尺寸重排一致。
  // 因此这里**不**注册 resize 接管——避免与脚本重建在同一事件下互相覆盖几何。
  // 仅在挂载时跑一次，作为"几何一次写入"的兜底接管。
  //
  // 前置要求：与父页面同源（srcdoc 继承父源），引擎对象跨 frame 可见。
  // 兜底：桥不可用/容器未就绪 → 静默跳过，保留 Chromium 布局，预览永不白屏。

  function findSpec() {
    var ui = window.__DearOreUI__ && window.__DearOreUI__.ui;
    return (ui && ui.specs && ui.specs[0]) || null;
  }
  function containerId() {
    var s = findSpec();
    return (s && s.containerId) || "dearoreui-preview-root";
  }
  function engine() {
    try {
      var w = window.parent;
      return (w && w.__PreviewYoga__) || null;
    } catch (e) {
      return null;
    }
  }

  var injected = false;
  function run() {
    if (injected) return true; // 已接管，保持幂等，后续由脚本自身端 resize 重建
    var eng = engine();
    if (!eng || !eng.available) return true; // 桥不可用 → 回退 Chromium 布局，预览不白屏
    var root = document.getElementById(containerId());
    if (!root) return false; // 容器未就绪 → 稍后重试
    try {
      eng.layout(root);
    } catch (e) {
      /* 布局异常：保留上一帧布局，不打断观察 */
    }
    injected = true;
    return true;
  }

  if (!run()) {
    var iv = window.setInterval(function () {
      if (run()) window.clearInterval(iv);
    }, 80);
    window.setTimeout(function () {
      window.clearInterval(iv);
    }, 20000);
  }
})();