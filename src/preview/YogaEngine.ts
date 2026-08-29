// YogaEngine —— 预览布局引擎桥（父页面持有真 Yoga，iframe 同源调用）
//
// 目标：让 App 离线预览用「与游戏同语义的真 Yoga flexbox」计算几何，替代
// Chromium 布局层，使「预览 ≡ 真机」。见
// Docs/DearOreUI-App布局引擎Yoga对齐-需求架构执行.md
//
// 工作原理：
//   1) 挂载容器（spec.containerId，position:fixed 铺满屏幕）作为布局根。
//   2) 深度遍历子树，为每个参与布局的元素建一个 Yoga Node，并逐个读取其
//      element.style（CSSOM），映射为 Yoga 的 flex 属性。
//   3) root.calculateLayout(containerW, containerH, LTR) —— 容器显式尺寸提供
//      确定主轴，使 flex:1 可正确分配（对齐布局规范 §2.3）。
//   4) 把每个节点 getComputedLeft/Top/Width/Height 写回 DOM（position:absolute
//      + 显式像素），几何唯一由 Yoga 决定；内容/文字仍由浏览器渲染。
//
// Electron/Tauri 同源 iframe 可跨 frame 调用父页面函数，因此把引擎对象挂到
// window.__PreviewYoga__，iframe 内联 pass 直接调用。

import Yoga from "@react-pdf/yoga";

const Y = Yoga as unknown as {
    Node: {
        create(): unknown;
    };
    FLEX_DIRECTION_ROW: number;
    FLEX_DIRECTION_ROW_REVERSE: number;
    FLEX_DIRECTION_COLUMN: number;
    FLEX_DIRECTION_COLUMN_REVERSE: number;
    JUSTIFY_FLEX_START: number;
    JUSTIFY_CENTER: number;
    JUSTIFY_FLEX_END: number;
    JUSTIFY_SPACE_BETWEEN: number;
    JUSTIFY_SPACE_AROUND: number;
    JUSTIFY_SPACE_EVENLY: number;
    ALIGN_AUTO: number;
    ALIGN_FLEX_START: number;
    ALIGN_CENTER: number;
    ALIGN_FLEX_END: number;
    ALIGN_STRETCH: number;
    ALIGN_BASELINE: number;
    ALIGN_SPACE_BETWEEN: number;
    ALIGN_SPACE_AROUND: number;
    WRAP_NO_WRAP: number;
    WRAP_WRAP: number;
    WRAP_WRAP_REVERSE: number;
    POSITION_TYPE_RELATIVE: number;
    POSITION_TYPE_ABSOLUTE: number;
    EDGE_LEFT: number;
    EDGE_TOP: number;
    EDGE_RIGHT: number;
    EDGE_BOTTOM: number;
    DIRECTION_LTR: number;
};

// ---- 值解析：px 数字 / 百分比 → 字符串；其余 → null（自动/空） ----
function len(v: string): string | null {
    const t = (v || "").trim();
    if (!t || t === "auto" || t === "none") return null;
    if (t.endsWith("%")) return t; // Yoga wrapper 支持 "50%"
    const n = parseFloat(t);
    return Number.isFinite(n) ? String(n) : null;
}

function lenNum(v: string): number | null {
    const t = (v || "").trim();
    if (!t || !Number.isFinite(parseFloat(t))) return null;
    return parseFloat(t);
}

type Node = any;

const JUSTIFY_MAP: Record<string, number> = {
    "flex-start": Y.JUSTIFY_FLEX_START,
    center: Y.JUSTIFY_CENTER,
    "flex-end": Y.JUSTIFY_FLEX_END,
    "space-between": Y.JUSTIFY_SPACE_BETWEEN,
    "space-around": Y.JUSTIFY_SPACE_AROUND,
    "space-evenly": Y.JUSTIFY_SPACE_EVENLY,
};

const ALIGN_MAP: Record<string, number> = {
    auto: Y.ALIGN_AUTO,
    "flex-start": Y.ALIGN_FLEX_START,
    center: Y.ALIGN_CENTER,
    "flex-end": Y.ALIGN_FLEX_END,
    stretch: Y.ALIGN_STRETCH,
    baseline: Y.ALIGN_BASELINE,
};

/** 把元素的 CSSOM 内联样式映射到 Yoga 节点（对齐布局规范：无 gap/grid）。 */
function applyStyle(n: Node, s: CSSStyleDeclaration): void {
    // flex-direction
    switch (s.flexDirection) {
        case "row": n.setFlexDirection(Y.FLEX_DIRECTION_ROW); break;
        case "row-reverse": n.setFlexDirection(Y.FLEX_DIRECTION_ROW_REVERSE); break;
        case "column": n.setFlexDirection(Y.FLEX_DIRECTION_COLUMN); break;
        case "column-reverse": n.setFlexDirection(Y.FLEX_DIRECTION_COLUMN_REVERSE); break;
    }
    if (s.justifyContent && JUSTIFY_MAP[s.justifyContent] !== undefined) {
        n.setJustifyContent(JUSTIFY_MAP[s.justifyContent]);
    }
    if (s.alignItems && ALIGN_MAP[s.alignItems] !== undefined) {
        n.setAlignItems(ALIGN_MAP[s.alignItems]);
    }
    if (s.alignSelf && s.alignSelf !== "auto" && ALIGN_MAP[s.alignSelf] !== undefined) {
        n.setAlignSelf(ALIGN_MAP[s.alignSelf]);
    }
    if (s.flexWrap === "wrap") n.setFlexWrap(Y.WRAP_WRAP);
    else if (s.flexWrap === "wrap-reverse") n.setFlexWrap(Y.WRAP_WRAP_REVERSE);

    // flex-grow / shrink / basis（flex:1 会被 CSSOM 拆成 grow:1 shrink:1 basis:0%）
    if (s.flexGrow) n.setFlexGrow(Number(parseFloat(s.flexGrow)));
    if (s.flexShrink) n.setFlexShrink(Number(parseFloat(s.flexShrink)));
    if (s.flexBasis && s.flexBasis !== "auto") {
        const b = len(s.flexBasis);
        if (b != null) n.setFlexBasis(b);
        else n.setFlexBasisAuto();
    }

    // 尺寸（含百分比与 min/max）
    if (s.width) { const w = len(s.width); if (w != null) n.setWidth(w); }
    if (s.height) { const h = len(s.height); if (h != null) n.setHeight(h); }
    if (s.minWidth) { const w = len(s.minWidth); if (w != null) n.setMinWidth(w); }
    if (s.minHeight) { const h = len(s.minHeight); if (h != null) n.setMinHeight(h); }
    if (s.maxWidth) { const w = len(s.maxWidth); if (w != null) n.setMaxWidth(w); }
    if (s.maxHeight) { const h = len(s.maxHeight); if (h != null) n.setMaxHeight(h); }

    // margin / padding（简写在 CSSOM 已展开到各边）
    const setMargin = (edge: number, v: string): void => {
        const m = len(v);
        if (m != null) n.setMargin(edge, m);
    };
    setMargin(Y.EDGE_LEFT, s.marginLeft);
    setMargin(Y.EDGE_TOP, s.marginTop);
    setMargin(Y.EDGE_RIGHT, s.marginRight);
    setMargin(Y.EDGE_BOTTOM, s.marginBottom);

    const setPad = (edge: number, v: string): void => {
        const p = len(v);
        if (p != null) n.setPadding(edge, p);
    };
    setPad(Y.EDGE_LEFT, s.paddingLeft);
    setPad(Y.EDGE_TOP, s.paddingTop);
    setPad(Y.EDGE_RIGHT, s.paddingRight);
    setPad(Y.EDGE_BOTTOM, s.paddingBottom);

    // border 宽度（Yoga 记 border-box；setBorder 为原生数字接口）
    if (s.borderTopWidth) { const b = lenNum(s.borderTopWidth); if (b != null) n.setBorder(Y.EDGE_TOP, b); }
    if (s.borderRightWidth) { const b = lenNum(s.borderRightWidth); if (b != null) n.setBorder(Y.EDGE_RIGHT, b); }
    if (s.borderBottomWidth) { const b = lenNum(s.borderBottomWidth); if (b != null) n.setBorder(Y.EDGE_BOTTOM, b); }
    if (s.borderLeftWidth) { const b = lenNum(s.borderLeftWidth); if (b != null) n.setBorder(Y.EDGE_LEFT, b); }

    // 定位：absolute / fixed 都按绝对定位处理（fixed 仅为浮层锚点，见规范）
    if (s.position === "absolute" || s.position === "fixed") {
        n.setPositionType(Y.POSITION_TYPE_ABSOLUTE);
        if (s.top) { const v = lenNum(s.top); if (v != null) n.setPosition(Y.EDGE_TOP, v); }
        if (s.right) { const v = lenNum(s.right); if (v != null) n.setPosition(Y.EDGE_RIGHT, v); }
        if (s.bottom) { const v = lenNum(s.bottom); if (v != null) n.setPosition(Y.EDGE_BOTTOM, v); }
        if (s.left) { const v = lenNum(s.left); if (v != null) n.setPosition(Y.EDGE_LEFT, v); }
    } else if (s.position === "relative") {
        n.setPositionType(Y.POSITION_TYPE_RELATIVE);
    }

    if (s.aspectRatio) { const r = parseFloat(s.aspectRatio); if (Number.isFinite(r) && r > 0) n.setAspectRatio(r); }
}

interface Mapped {
    el: HTMLElement;
    node: Node;
}

// ---- 文本测量：Canvas2D measureText，按真实字号/字体/行高测出自然几何 ----
// 还原游戏引擎的字体度量行为：裸 Yoga 不做文本测量，会把这些叶子算出 0×0。
let measureCanvas: HTMLCanvasElement | null = null;
function measureCtx(): CanvasRenderingContext2D | null {
    if (!measureCanvas) measureCanvas = document.createElement("canvas");
    try {
        return measureCanvas.getContext("2d");
    } catch {
        return null;
    }
}

function textWidth(text: string, cs: CSSStyleDeclaration): number {
    const c = measureCtx();
    if (!c) return 0;
    const fs = parseFloat(cs.fontSize) || 12;
    c.font = [cs.fontStyle || "normal", cs.fontWeight || "normal", `${fs}px`, cs.fontFamily || "sans-serif"].join(" ");
    return c.measureText(text).width;
}

function lineH(cs: CSSStyleDeclaration): number {
    const fs = parseFloat(cs.fontSize) || 12;
    const lh = cs.lineHeight;
    return lh && lh !== "normal" && Number.isFinite(parseFloat(lh)) ? parseFloat(lh) : fs * 1.2;
}

/** 直接文本子节点合并后的非空串；无则 null。 */
function directText(el: HTMLElement): string | null {
    let t = "";
    for (let i = 0; i < el.childNodes.length; i++) {
        const n = el.childNodes[i];
        if (n.nodeType === Node.TEXT_NODE) t += n.textContent || "";
    }
    const tt = t.trim();
    return tt ? tt : null;
}

/** 文本叶子：仅含文本、无布局子元素（由该元素收集到的文本撑开几何）。 */
function isTextLeaf(el: HTMLElement): boolean {
    return el.childElementCount === 0 && directText(el) != null;
}

/** fixed 全屏锚点：position:fixed 且无显式宽高（仅靠 inset:0 撑开）→ 按视口铺满。 */
function isFixedFullscreen(el: HTMLElement): boolean {
    return el.style.position === "fixed" && !el.style.width && !el.style.height;
}

function walk(parentNode: Node, el: HTMLElement, out: Mapped[], W: number, H: number): void {
    for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i] as HTMLElement;
        const cs = child.style;
        if (cs.display === "none") continue; // 不参与布局（等价从布局树摘除）
        const node = NodeSafe.create();
        applyStyle(node, cs);
        if (isTextLeaf(child)) {
            // 文本叶子：交给测量函数撑开（单行自然宽高），不再塌成 0×0。
            const ccs = getComputedStyle(child);
            const txt = directText(child)!;
            const w = textWidth(txt, ccs);
            const h = lineH(ccs);
            node.setMeasureFunc(() => ({ width: Math.ceil(w), height: Math.ceil(h) }));
        } else if (isFixedFullscreen(child)) {
            // fixed 全屏锚点（无显式宽高）→ 按视口铺满，避免收起。
            node.setWidth(String(W));
            node.setHeight(String(H));
        }
        parentNode.insertChild(node, parentNode.getChildCount());
        out.push({ el: child, node });
        walk(node, child, out, W, H);
    }
}

// 工具：统一建节点（便于出错即整体回退）
const NodeSafe = {
    create(): any {
        return Y.Node.create();
    },
};

/**
 * 对挂载容器整棵子树做一次 Yoga 几何计算，并把结果写回 DOM（绝对定位）。
 * 任一步出错都不抛出，静默回退为 Chromium 布局，预览不白屏。
 */
export function yogaLayout(root: HTMLElement): boolean {
    try {
        const W = root.clientWidth || 0;
        const H = root.clientHeight || 0;
        if (!W || !H) return false;

        const rootNode = NodeSafe.create();
        rootNode.setWidth(String(W));
        rootNode.setHeight(String(H));
        applyStyle(rootNode, root.style);

        const mapped: Mapped[] = [];
        walk(rootNode, root, mapped, W, H);

        rootNode.calculateLayout(W, H, Y.DIRECTION_LTR);

        for (const m of mapped) {
            const { el, node } = m;
            const left = node.getComputedLeft();
            const top = node.getComputedTop();
            const cw = node.getComputedWidth();
            const ch = node.getComputedHeight();
            const st = el.style;
            // 幂等写回：仅在与当前值不同时才落 DOM，避免重复重算造成累计舍入偏移。
            st.position = "absolute";
            if (Number.isFinite(cw) && cw + "px" !== st.width) st.width = cw + "px";
            if (Number.isFinite(ch) && ch + "px" !== st.height) st.height = ch + "px";
            if (Number.isFinite(left) && left + "px" !== st.left) st.left = left + "px";
            if (Number.isFinite(top) && top + "px" !== st.top) st.top = top + "px";
            try { node.free(); } catch { /* 忽略 */ }
        }
        try { rootNode.free(); } catch { /* 忽略 */ }
        return true;
    } catch {
        // 引擎异常 → 放弃本次接管，保留浏览器默认布局。
        return false;
    }
}

/** 预览引擎桥对象（暴露给同源 iframe）。 */
export interface PreviewYogaEngine {
    available: boolean;
    /** 一次完整构图：镜像 DOM → Yoga → 绝对定位落位。 */
    layout(root: HTMLElement): boolean;
}

function buildEngine(): PreviewYogaEngine {
    return {
        available: true,
        layout: (root) => yogaLayout(root),
    };
}

/** 惰性把引擎挂到 window.__PreviewYoga__（父页面全局，iframe 经 window.parent 读取）。 */
export function installYogaEngine(): PreviewYogaEngine {
    const w = window as unknown as { __PreviewYoga__?: PreviewYogaEngine };
    if (!w.__PreviewYoga__) {
        w.__PreviewYoga__ = buildEngine();
    }
    return w.__PreviewYoga__;
}