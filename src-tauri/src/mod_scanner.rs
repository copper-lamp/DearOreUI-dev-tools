//! 模组 UI 自动识别器（离线静态扫描，模组零改动）
//!
//! 用户给定模组源码目录后，扫描其中所有 `.h`/`.cpp`，识别用 DearOreUI API
//! 声明的每个 `registerComponent`，提取 UiManifest / ComponentSpec / DomNode /
//! 页面脚本（`R"delim(... )delim"` raw string），组装成与
//! [`PreviewTarget`](crate::preview_assets::PreviewTarget) 同构的预览资产。
//! 纯静态分析，不运行游戏，也不改写模组。
//!
//! 解析范围限定为声明子集（DearOreUI 示例 mod 均满足）；无法识别的字段优雅降级。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::preview_assets::PreviewTarget;

/// scan_mod_ui 命令的返回结构（复用 PreviewTarget）。
#[derive(Debug, Serialize)]
pub struct ModScanResult {
    pub targets: Vec<PreviewTarget>,
    pub files: Vec<String>,
    pub warnings: Vec<String>,
    pub path: String,
    pub ok: bool,
}

// ---------------------------------------------------------------------------
// 基础文本工具
// ---------------------------------------------------------------------------

/// 返回 hay 中所有 needle 出现位置。
fn find_all(hay: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut start = 0;
    while let Some(rel) = hay[start..].find(needle) {
        let pos = start + rel;
        out.push(pos);
        start = pos + needle.len();
    }
    out
}

/// 从 `open`（指向某个开括号）起，配平到同层闭合括号，返回紧随闭合括号之后的偏移。
fn balanced_end(hay: &str, open: usize, open_c: char, close_c: char) -> Option<usize> {
    let bytes = hay.as_bytes();
    if bytes.get(open) != Some(&(open_c as u8)) {
        return None;
    }
    let mut depth = 0;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] as char {
            c if c == open_c => depth += 1,
            c if c == close_c => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// 读取一个双引号字符串字面量（从开引号位置起），返回不含引号的内容与结束偏移。
fn read_quoted(hay: &str, open_quote: usize) -> Option<(String, usize)> {
    let bytes = hay.as_bytes();
    if bytes.get(open_quote) != Some(&b'"') {
        return None;
    }
    let mut out = String::new();
    let mut i = open_quote + 1;
    while i < bytes.len() {
        match bytes[i] as char {
            '"' => return Some((out, i + 1)),
            '\\' if i + 1 < bytes.len() => {
                let n = bytes[i + 1] as char;
                out.push(if n == 'n' {
                    '\n'
                } else if n == 't' {
                    '\t'
                } else if n == 'r' {
                    '\r'
                } else {
                    n
                });
                i += 2;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    None
}

/// 略过空白/换行后返回下一个非空白字符位置。
fn skip_ws(hay: &str, mut i: usize) -> usize {
    let bytes = hay.as_bytes();
    while i < bytes.len() && (bytes[i] as char).is_whitespace() {
        i += 1;
    }
    i
}

/// 读取 `=` 之后的一个值：
/// - 若以 `"` 开头 → 读字符串字面量；
/// - 若为 `{` → 读配平花括号块；
/// - 否则读标识符式 token（到 `,` `)` `}` `;` 或空白），用于枚举 `UiKind::Overlay` 等。
fn read_value(hay: &str, eq_pos: usize) -> Option<(String, usize)> {
    let ws = skip_ws(hay, eq_pos + 1);
    let c = hay.as_bytes().get(ws).copied()? as char;
    match c {
        '"' => read_quoted(hay, ws).map(|(v, e)| (v, e)),
        '{' => {
            let end = balanced_end(hay, ws, '{', '}')?;
            let block = &hay[ws..end];
            Some((block.trim().to_string(), end))
        }
        '(' => {
            let end = balanced_end(hay, ws, '(', ')')?;
            let block = &hay[ws + 1..end - 1];
            Some((block.trim().to_string(), end))
        }
        _ => {
            let mut i = ws;
            let bytes = hay.as_bytes();
            while i < bytes.len() {
                let ch = bytes[i] as char;
                if ch == ',' || ch == ')' || ch == '}' || ch == ';' || ch.is_whitespace() {
                    break;
                }
                i += 1;
            }
            if i == ws {
                return None;
            }
            Some((hay[ws..i].trim().to_string(), i))
        }
    }
}

/// 从 body 找到所有 `.name` 后（允许任意空白）紧跟 `=` 的赋值，返回每个取值。
/// 容忍源码的多空格对齐（如 `uiManifest.id            = "x"`）。
/// 返回 (值, 是否为字符串字面量, 值结束偏移)。`is_str` 用于区分
/// `id = "calendar"`（字符串）与 `id = mModId`（变量 token）。
fn collect_assigns(body: &str, name: &str) -> Vec<(String, bool, usize)> {
    let mut out = Vec::new();
    for p in find_all(body, name) {
        let ws = skip_ws(body, p + name.len());
        if body.as_bytes().get(ws) == Some(&b'=') {
            let after = skip_ws(body, ws + 1);
            let is_str = body.as_bytes().get(after) == Some(&b'"');
            if let Some((v, e)) = read_value(body, ws) {
                out.push((v, is_str, e));
            }
        }
    }
    out
}

/// 取 `A::B::C` 的最后一段（枚举简名）。
fn enum_last(s: &str) -> String {
    s.rsplit("::").next().unwrap_or(s).trim().to_string()
}

/// 从一段源文本提取所有 raw string 常量：`R"<delim>(<内容>)<delim>"`。
/// 返回 (常量名, 内容) 列表；常量名从 `=` 左侧最近标识符取。
fn extract_raw_strings(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        // 定位 R"
        if bytes[i] == b'R' && bytes[i + 1] == b'"' {
            // 读 delim
            let mut j = i + 2;
            while j < bytes.len() && (bytes[j] as char).is_ascii_alphanumeric() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'(' {
                let delim = &text[i + 2..j];
                let body_start = j + 1;
                // 找结束 ")delim"
                let close = format!("){delim}\"");
                if let Some(rel) = text[body_start..].find(&close) {
                    let content = &text[body_start..body_start + rel];
                    // 向前找最近标识符（`x = R"` 中 x）
                    let name = const_name_before(text, i);
                    out.push((name, content.to_string()));
                    i = body_start + rel + close.len();
                    continue;
                }
            }
            i += 1;
            continue;
        }
        i += 1;
    }
    out
}

/// 在 `pos` 前（同上下文）找最近的标识符 token 作为常量名。
fn const_name_before(text: &str, pos: usize) -> String {
    // 往回跳过 =、空白、以及数组/指针后缀（[] * &），再取前一标识符。
    let bytes = text[..pos].as_bytes();
    let mut i = pos;
    loop {
        if i == 0 {
            break;
        }
        let c = bytes[i - 1] as char;
        if c.is_whitespace() || c == '=' || c == ':' || c == '[' || c == ']' || c == '*' || c == '&' {
            i -= 1;
        } else {
            break;
        }
    }
    let mut end = i;
    while end > 0 && is_ident_char(bytes[end - 1] as char) {
        end -= 1;
    }
    text[end..i].trim().to_string()
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

// ---------------------------------------------------------------------------
// 字段提取（UiManifest / ComponentSpec / DomNode）
// ---------------------------------------------------------------------------

#[derive(Default)]
struct UiFields {
    id: String,
    kind: String,
    anchor: String,
    page_scopes: Vec<String>,
    container_id: String,
    fingerprint: String,
    label: String,
    style: String,
    display_name: String,
    mod_namespace: String,
    body_var: String,
}

/// 在 registerAll 函数体里分别识别 UiManifest / ComponentSpec 字段。
/// 通过值的前缀枚举（`dearoreui::api::UiKind`）消歧 `.kind`，
/// 通过"字符串字面量 vs 变量"消歧 `.id`（UiManifest.id 是字面量，modManifest.id 是变量）。
fn extract_fields(func_body: &str) -> UiFields {
    let mut f = UiFields::default();

    // displayName（ModManifest）
    for (v, is_str, _) in collect_assigns(func_body, ".displayName") {
        if is_str {
            f.display_name = v;
            break;
        }
    }
    // modNamespace
    for (v, is_str, _) in collect_assigns(func_body, ".modNamespace") {
        if is_str {
            f.mod_namespace = v;
            break;
        }
    }

    // kind：取含 UiKind 的赋值（ComponentKind 忽略）
    for (v, _, _) in collect_assigns(func_body, ".kind") {
        if v.contains("UiKind") {
            f.kind = enum_last(&v);
            break;
        }
    }

    // id：取字符串字面量（UiManifest.id = "calendar"），避开 modManifest.id = 变量
    for (v, is_str, _) in collect_assigns(func_body, ".id") {
        if is_str {
            f.id = v;
            break;
        }
    }

    // anchor
    for (v, _, _) in collect_assigns(func_body, ".anchor") {
        if !v.contains("::") || v.contains("UiAnchor") {
            f.anchor = enum_last(&v);
            break;
        }
    }

    // fingerprint
    for (v, is_str, _) in collect_assigns(func_body, ".fingerprint") {
        if is_str {
            f.fingerprint = v;
            break;
        }
    }

    // label（panel）
    for (v, is_str, _) in collect_assigns(func_body, ".label") {
        if is_str {
            f.label = v;
            break;
        }
    }

    // style（panel）
    for (v, is_str, _) in collect_assigns(func_body, ".style") {
        if is_str {
            f.style = v;
            break;
        }
    }

    // pageScopes = { PageScope::Any, ... }
    if let Some((v, _, _)) = collect_assigns(func_body, ".pageScopes").into_iter().next() {
        if v.starts_with('{') {
            for q in find_all(&v, "PageScope") {
                let rest = &v[q..];
                let last = enum_last(rest.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ':'));
                let seg = last.split_whitespace().next().unwrap_or("");
                if !seg.is_empty() {
                    f.page_scopes.push(seg.to_string());
                }
            }
            if f.page_scopes.is_empty() {
                f.page_scopes.push("Any".to_string());
            }
        }
    }

    // containerId：若为字符串字面量保留；否则（makeUiContainerId 等）走默认
    if let Some((v, is_str, _)) = collect_assigns(func_body, ".containerId").into_iter().next() {
        if is_str {
            f.container_id = v;
        } else if !v.is_empty() && !v.contains("makeUiContainerId") {
            f.container_id = v.trim_matches('"').to_string();
        }
    }

    // body 变量：.body = std::move(x) / .body = x
    if let Some((v, _, _)) = collect_assigns(func_body, ".body").into_iter().next() {
        let var = v
            .strip_prefix("std::move(")
            .map(|s| s.trim_end_matches(')'))
            .unwrap_or(&v)
            .trim()
            .to_string();
        if !var.is_empty() {
            f.body_var = var;
        }
    }

    if f.kind.is_empty() {
        f.kind = "Overlay".to_string();
    }
    if f.anchor.is_empty() {
        f.anchor = "TopLeft".to_string();
    }
    f
}

/// 解析 `DomNode{...}` 块，返回 (tag, attrs, style, text)。
fn parse_dom_node(block: &str) -> Option<(String, String, String, String)> {
    let mut tag = String::new();
    let mut attrs = String::new();
    let mut style = String::new();
    let mut text = String::new();

    for (field, sink) in [
        (".tag", &mut tag),
        (".style", &mut style),
        (".text", &mut text),
        (".attrs", &mut attrs),
    ] {
        let pat = format!("{field} =");
        if let Some(p) = block.find(&pat) {
            let eq = p + pat.len() - 1;
            if let Some((v, _)) = read_value(block, eq) {
                *sink = v;
            }
        }
    }
    Some((tag, attrs, style, text))
}

/// 属性 `{{"id","cal-root"},{"cls","x"}}` → stage7 兼容的数组 `[["id","cal-root"],["cls","x"]]`。
fn attrs_to_js(attrs: &str) -> String {
    if !attrs.starts_with('{') {
        return "[]".to_string();
    }
    let mut arr: Vec<String> = Vec::new();
    let mut i = 0;
    while let Some(rel) = attrs[i..].find('"') {
        let kq = i + rel;
        if let Some((k, e1)) = read_quoted(attrs, kq) {
            // 找 "," 后的值引号
            let after = attrs[e1..].find(',');
            let vq = if let Some(c) = after { e1 + c + 1 } else { e1 };
            let vqs = skip_ws(attrs, vq);
            if let Some((v, _e2)) = read_quoted(attrs, vqs) {
                arr.push(format!(
                    "[{},{}]",
                    serde_json::to_string(&k).unwrap_or_else(|_| "\"\"".into()),
                    serde_json::to_string(&v).unwrap_or_else(|_| "\"\"".into()),
                ));
            }
            // 跳到该 pair 的闭 }
            if let Some(cl) = attrs[vqs..].find('}') {
                i = vqs + cl + 1;
            } else {
                break;
            }
        } else {
            break;
        }
    }
    if arr.is_empty() {
        return "[]".to_string();
    }
    format!("[{}]", arr.join(","))
}

/// 序列化一个 stage7 节点：`{t,s,x,a?,c?}`（t=tag, s=style, x=text, a=attrs 数组, c=children）。
/// 逐个字段 `t/s/x/a/c` 与 dearOreUiBuildDom 严格对齐（真机/预览同一解析器）。
fn node_js_str(tag: &str, attrs: &str, style: &str, text: &str, children: &[String]) -> String {
    let t = if tag.is_empty() { "div" } else { tag };
    let mut o = format!(
        "{{\"t\":{},\"s\":{},\"x\":{}",
        serde_json::to_string(t).unwrap_or_else(|_| "\"div\"".into()),
        serde_json::to_string(style).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()),
    );
    if !attrs.is_empty() {
        o.push_str(&format!(",\"a\":{attrs}"));
    }
    if !children.is_empty() {
        o.push_str(&format!(",\"c\":[{}]", children.join(",")));
    }
    o.push('}');
    o
}

/// 收集 body 变量所有 push_back 的 DomNode，分离出正常节点与 script 节点。
/// 返回 (dom_js_nodes, page_script_node_text)。
fn collect_body(_whole_file: &str, func_body: &str, var: &str) -> (Vec<(String, String, String, String)>, Vec<String>) {
    // dom_js_nodes 实际按 JS 数组形式输出；此处用 Vec<(tag,attrs,style,text)> 中间表示。
    let mut dom: Vec<(String, String, String, String)> = Vec::new();
    let mut scripts: Vec<String> = Vec::new();

    if var.is_empty() {
        return (Vec::new(), scripts);
    }
    let pat = format!("{var}.push_back(");
    let base = func_body;
    for p in find_all(base, &pat) {
        let open = p + pat.len() - 1; // '('
        let Some(end) = balanced_end(base, open, '(', ')') else {
            continue;
        };
        let block = &base[open + 1..end - 1];
        let Some((tag, attrs, style, text)) = parse_dom_node(block) else {
            continue;
        };
        if tag == "script" {
            scripts.push(text);
        } else {
            dom.push((tag, attrs, style, text));
        }
    }
    (dom, scripts)
}

// ---------------------------------------------------------------------------
// ComponentSpec 组合树 → stage7 节点数组（离线组件渲染器，复刻 ComponentRenderer 结构）
// ---------------------------------------------------------------------------

/// 读取声明式字段 `<var>.<field> = value`，容忍多空格对齐。
fn var_field(fb: &str, var: &str, field: &str) -> Option<String> {
    let pat = format!("{var}.{field}");
    for p in find_all(fb, &pat) {
        let ws = skip_ws(fb, p + pat.len());
        if fb.as_bytes().get(ws) == Some(&b'=') {
            return read_value(fb, ws).map(|(v, _)| v);
        }
    }
    None
}

/// 从 `children = {std::move(a), std::move(b)}` 提取引用变量名。
fn extract_children_refs(v: &str) -> Vec<String> {
    let mut out = Vec::new();
    for p in find_all(v, "std::move(") {
        let s = p + "std::move(".len();
        let b = v.as_bytes();
        let mut j = s;
        while j < b.len() && is_ident_char(b[j] as char) {
            j += 1;
        }
        if j > s {
            let n = v[s..j].to_string();
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

/// registerComponent(mModId, uiManifest, <root>) 的第三参（组件根变量名）。
fn extract_root_component(fb: &str) -> Option<String> {
    let rc = fb.find("registerComponent")?;
    let open = fb[rc..].find('(')? + rc;
    let end = balanced_end(fb, open, '(', ')')?;
    let inner = &fb[open + 1..end - 1];
    // 顶层逗号切分
    let mut args = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    let b = inner.as_bytes();
    for i in 0..inner.len() {
        match b[i] as char {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                args.push(inner[start..i].trim().to_string());
                start = i + 1;
            }
            _ => {}
        }
    }
    if start < inner.len() {
        args.push(inner[start..].trim().to_string());
    }
    let root = args.get(2)?;
    let root = root.strip_prefix("std::move(").map_or(root.as_str(), |s| s.trim_end_matches(')'));
    if root.is_empty() {
        None
    } else {
        Some(root.to_string())
    }
}

/// Text 组件按 variant 的近似样式（离线预览用；参考 ComponentRenderer Text 分支）。
fn component_text_style(variant: &str) -> String {
    (match variant {
        "heading" => "font-weight:700;font-size:1.6rem;color:#fff;",
        "subheading" => "font-size:1.3rem;color:#ddd;",
        "muted" => "font-size:0.9rem;color:#999;",
        "tiny" => "font-size:0.8rem;color:#aaaaaa;",
        _ => "font-size:1rem;color:#eeeeee;",
    })
    .to_string()
}

/// Panel 按 style 变体的近似样式（dark/transparent/translucent/bordered/…）。
fn component_panel_style(style: &str) -> String {
    (match style {
        "dark" => "background:rgba(0,0,0,0.78);padding:1.2rem;",
        "transparent" => "background:transparent;height:100%;overflow-y:auto;",
        "translucent" => "background:rgba(0,0,0,0.72);padding:1.2rem;",
        "bordered" => "background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.2);padding:1.2rem;",
        "furnace" => "background:#4a4a4a;padding:1.2rem;",
        "chest" => "background:#3c2f1e;padding:1.2rem;",
        _ => "background:rgba(40,40,40,0.6);padding:1.2rem;",
    })
    .to_string()
}

/// 单个 ComponentKind → stage7 节点字符串；children 已递归展开。
fn kind_to_node_js(
    kind: &str,
    label: &str,
    variant: &str,
    style: &str,
    orientation: &str,
    cols: u32,
    children: &[String],
) -> String {
    match kind {
        "Text" => node_js_str("div", "", &component_text_style(variant), label, &[]),
        "Panel" => node_js_str("div", "", &component_panel_style(style), label, children),
        "Card" => {
            let css = if style == "bordered" {
                "padding:1.2rem 1.6rem;border:1px solid rgba(255,255,255,0.2);"
            } else {
                "padding:1.2rem 1.6rem;"
            };
            node_js_str("div", "", css, label, children)
        }
        "Button" => {
            let css = match variant {
                "primary" => "padding:0.8rem 1.6rem;cursor:pointer;box-sizing:border-box;background:#3a7bd5;color:#fff;",
                _ => "padding:0.8rem 1.6rem;cursor:pointer;box-sizing:border-box;border:1px solid rgba(255,255,255,0.3);color:#fff;",
            };
            node_js_str("button", "", css, label, children)
        }
        "ListItem" => node_js_str("div", "", "display:flex;align-items:center;padding:0.8rem 1.4rem;box-sizing:border-box;", label, children),
        "Divider" => node_js_str("hr", "", "border:0;height:1px;background:rgba(255,255,255,0.2);", "", &[]),
        "Input" => node_js_str("input", "", "padding:0.6rem 0.8rem;box-sizing:border-box;color:#333;", "", &[]),
        "Stack" => {
            let dir = if orientation == "row" { "row" } else { "column" };
            node_js_str("div", "", &format!("display:flex;flex-direction:{dir};gap:0.6rem;"), "", children)
        }
        "Grid" => {
            // 引擎忽略 display:grid，用嵌套 flex 行复刻 1fr 网格（同核心层策略）。
            let cols = if cols == 0 { 1 } else { cols };
            let mut rows: Vec<String> = Vec::new();
            let mut cell: Vec<String> = Vec::new();
            for (idx, c) in children.iter().enumerate() {
                cell.push(c.clone());
                if (idx as u32 + 1) % cols == 0 || idx + 1 == children.len() {
                    rows.push(node_js_str("div", "", "display:flex;flex-direction:row;gap:0.6rem;", "", &cell));
                    cell.clear();
                }
            }
            node_js_str("div", "", "display:flex;flex-direction:column;gap:0.6rem;", "", &rows)
        }
        "ScrollView" => node_js_str("div", "", "overflow-y:auto;height:100%;", "", children),
        "Section" => {
            let mut all: Vec<String> = Vec::new();
            if !label.is_empty() {
                all.push(node_js_str("div", "", "font-size:1.3rem;color:#ddd;", label, &[]));
            }
            all.extend_from_slice(children);
            node_js_str("div", "", "display:flex;flex-direction:column;gap:0.6rem;", "", &all)
        }
        "Spacer" => node_js_str("div", "", "flex:1;", "", &[]),
        "Modal" => {
            let backdrop = node_js_str("div", "", "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);", label, children);
            node_js_str("div", "", "display:flex;align-items:center;justify-content:center;", "", &[backdrop])
        }
        _ => {
            let text = if label.is_empty() { kind } else { label };
            node_js_str("div", "", "color:#fff;", text, children)
        }
    }
}

/// 递归把 ComponentSpec 变量树渲染为 stage7 节点数组（带环检测）。
fn build_node_js(fb: &str, var: &str, seen: &mut Vec<String>) -> Option<String> {
    if seen.iter().any(|s| s == var) {
        return None;
    }
    seen.push(var.to_string());
    let kind = var_field(fb, var, "kind")
        .map(|k| enum_last(&k))
        .unwrap_or_else(|| "Panel".to_string());
    let label = var_field(fb, var, "label").unwrap_or_default();
    let variant = var_field(fb, var, "variant").unwrap_or_default();
    let style = var_field(fb, var, "style").unwrap_or_default();
    let orientation = var_field(fb, var, "orientation").unwrap_or_default();
    let columns = var_field(fb, var, "columns")
        .and_then(|c| c.trim().parse::<u32>().ok())
        .unwrap_or(1);
    let mut children: Vec<String> = Vec::new();
    if let Some(cv) = var_field(fb, var, "children") {
        for r in extract_children_refs(&cv) {
            if let Some(n) = build_node_js(fb, &r, seen) {
                children.push(n);
            }
        }
    }
    Some(kind_to_node_js(&kind, &label, &variant, &style, &orientation, columns, &children))
}

/// 组件组合树 → 根节点 JS 数组。
fn build_component_tree(fb: &str, root: &str) -> Vec<String> {
    let mut seen = Vec::new();
    match build_node_js(fb, root, &mut seen) {
        Some(n) => vec![n],
        None => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// 单文件扫描
// ---------------------------------------------------------------------------

fn scan_file(text: &str, warnings: &mut Vec<String>) -> Vec<PreviewTarget> {
    let raw_strings = extract_raw_strings(text);
    let mut out = Vec::new();

    // 定位所有 registerAll 函数体
    let mut search = 0;
    while let Some(rel) = text[search..].find("registerAll") {
        let start = search + rel;
        // 找函数体 {（第一个 '{'）
        let Some(open_brace) = text[start..].find('{') else {
            break;
        };
        let ob = start + open_brace;
        let Some(end) = balanced_end(text, ob, '{', '}') else {
            search = start + "registerAll".len();
            continue;
        };
        let func_body = &text[ob + 1..end - 1];

        // 必须有正式注册调用
        if !func_body.contains("registerComponent") {
            search = end;
            continue;
        }

        let f = extract_fields(func_body);
        let (dom_nodes, scripts) = collect_body(text, func_body, &f.body_var);
        // 构建 stage7 兼容节点数组：优先 DomNode body，否则尝试 ComponentSpec 组合树。
        let mut js_nodes: Vec<String> = Vec::new();
        if !dom_nodes.is_empty() {
            for (t, a, s, tx) in &dom_nodes {
                js_nodes.push(node_js_str(t, &attrs_to_js(a), s, tx, &[]));
            }
        } else if let Some(root) = extract_root_component(func_body) {
            js_nodes = build_component_tree(func_body, &root);
        }
        if js_nodes.is_empty() && scripts.is_empty() {
            warnings.push("body 为空，跳过 UI（无 DomNode body / 无 ComponentSpec 组合树）".to_string());
        } else {
            let dom_script = format!("[{}]", js_nodes.join(","));

            // page_script：优先取 script 节点的引用常量 → 查 raw string；否则原样
            let mut page_script = scripts.first().cloned().unwrap_or_default();
            if !page_script.is_empty() && is_simple_ident(&page_script) {
                if let Some((_, content)) = raw_strings.iter().find(|(n, _)| n == &page_script) {
                    page_script = content.clone();
                }
            }

            let entry = if !f.id.is_empty() { f.id } else { "ui".into() };
            let title = if !f.label.is_empty() {
                f.label.clone()
            } else if !f.display_name.is_empty() {
                f.display_name.clone()
            } else {
                entry.clone()
            };

            out.push(PreviewTarget {
                entry,
                title,
                kind: f.kind,
                anchor: f.anchor,
                page_scopes: f.page_scopes,
                container_id: f.container_id,
                fingerprint: f.fingerprint,
                html_body: String::new(),
                dom_script,
                page_script,
            });
        }
        search = end;
    }
    out
}

fn is_simple_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if is_ident_char(c) || c == '_' => {}
        _ => return false,
    }
    chars.all(is_ident_char)
}

/// 递归收集目录下的 .h/.cpp。
fn collect_source_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return files;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            files.extend(collect_source_files(&p));
        } else {
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or_default().to_ascii_lowercase();
            if ext == "h" || ext == "hpp" || ext == "cpp" || ext == "cc" || ext == "cxx" {
                files.push(p);
            }
        }
    }
    files
}

/// 从源文本中提取外部 page-script 资产文件名（.js）。
///
/// 示例组件用 `loadPageScriptAsset(modDir, "ex03_page_script.js")` 在运行时从
/// <mod>/scripts/<filename> 加载页面脚本，而非把内容内联为 raw string。扫描器读不到
/// 该文件内容，便在 page_script 字段留下一个残 token（见 scan_file）。这里优先在该
/// 调用内取引号文件名，兜底取任意 `"*.js"` 字面量。
fn extract_js_asset_fname(content: &str) -> Option<String> {
    const NEEDLE: &str = "loadPageScriptAsset";
    let mut search = 0;
    while let Some(pos) = content[search..].find(NEEDLE) {
        let start = search + pos;
        let after = &content[start + NEEDLE.len()..];
        if let Some(qi) = after.find('"') {
            let rest = &after[qi + 1..];
            if let Some(ei) = rest.find('"') {
                let name = &rest[..ei];
                if name.ends_with(".js") {
                    return Some(name.to_string());
                }
            }
        }
        search = start + NEEDLE.len();
    }
    // 兜底：任意以 .js 结尾的引号字面量。
    let mut i = 0;
    let b = content.as_bytes();
    while i < b.len() {
        if b[i] == b'"' {
            if let Some(e) = content[i + 1..].find('"') {
                let cand = &content[i + 1..i + 1 + e];
                if cand.ends_with(".js") {
                    return Some(cand.to_string());
                }
                i += 1 + e;
                continue;
            }
        }
        i += 1;
    }
    None
}

/// 在 mod 目录下定位并读取外部 page-script 资产内容（与 PageScriptAsset.h 的
/// `<mod>/scripts/<filename>` 加载约定对齐；附加源码位与构建产物位作回退）。
fn resolve_page_script_asset(dir: &Path, fname: &str) -> Option<String> {
    const SEARCH: [&str; 4] = ["assets/scripts", "scripts", "bin/my-mod/scripts", "src/assets/scripts"];
    for sub in SEARCH {
        let p = dir.join(sub).join(fname);
        if p.is_file() {
            if let Ok(c) = fs::read_to_string(&p) {
                return Some(c);
            }
        }
    }
    None
}

/// 判断该 page_script 是否仍是未解析的外部资产占位（简单标识符 token）。
/// 只有 inline raw string 才能解析成多字符 JS；外部资产读不到时残留 `pageScript` 之类
/// 的标识符。空串（无脚本）返回 false。
fn is_external_script_placeholder(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    // 已命中的 inline raw string 内容是真实 JS（含换行/空白/函数/关键字），直接排除。
    // 占位 token 有两种形态：
    //   1) 简单标识符：`.text = pageScript`
    //   2) 引用表达式：`.text = std::move(pageScript)`
    if is_simple_ident(s) {
        return true;
    }
    s.contains("std::move(") || s.contains("move(")
}

/// 扫描模组目录，产出可预览的 UI 资产。
#[tauri::command]
pub fn scan_mod_ui(dir: String) -> Result<ModScanResult, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("不是有效目录：{dir}"));
    }
    let mut warnings = Vec::new();
    let mut targets = Vec::new();
    let mut scanned = Vec::new();

    for file in collect_source_files(&root) {
        let Ok(content) = fs::read_to_string(&file) else {
            continue;
        };
        let mut t = scan_file(&content, &mut warnings);
        // 外部 page-script：scan_file 只能解析 inline raw string，外部资产留下的
        // 简单标识符 token 在这里补解析，从 mod 目录资产加载真实 JS 内容。
        for tg in &mut t {
            if is_external_script_placeholder(&tg.page_script) {
                if let Some(fname) = extract_js_asset_fname(&content) {
                    match resolve_page_script_asset(&root, &fname) {
                        Some(src) => tg.page_script = src,
                        None => warnings.push(format!(
                            "page-script 资产未找到：{fname}（{} 引用）；预览无页面逻辑",
                            file.display()
                        )),
                    }
                }
            }
        }
        if !t.is_empty() {
            scanned.push(file.display().to_string());
            targets.extend(t);
        }
    }

    if targets.is_empty() {
        return Ok(ModScanResult {
            targets,
            files: scanned,
            warnings,
            path: dir.clone(),
            ok: true,
        });
    }

    Ok(ModScanResult {
        targets,
        files: scanned,
        warnings,
        path: dir,
        ok: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_string_extraction() {
        let src = r#"constexpr const char* kPageScript = R"js((function () {
  var a = 1;
})();
)js";"#;
        let rs = extract_raw_strings(src);
        assert_eq!(rs.len(), 1);
        assert_eq!(rs[0].0, "kPageScript");
        assert!(rs[0].1.contains("var a = 1"));
    }

    #[test]
    fn attrs_js() {
        // stage7 期望数组格式 [["id","cal-root"],["cls","x"]]（非对象 {k:v}）。
        let js = attrs_to_js(r#"{{"id","cal-root"},{"cls","x"}}"#);
        assert!(js.contains(r#"["id","cal-root"]"#), "got: {js}");
        assert!(js.contains(r#"["cls","x"]"#), "got: {js}");
    }

    #[test]
    fn page_scopes_enum() {
        let body = r#"
            uiManifest.pageScopes = {dearoreui::api::PageScope::Any};
            uiManifest.kind = dearoreui::api::UiKind::Overlay;
            uiManifest.anchor = dearoreui::api::UiAnchor::TopRight;
            uiManifest.id = "calendar_grid";
            uiManifest.fingerprint = "v1";
            panel.label = "Calendar";
            panel.style = "dark";
        "#;
        let f = extract_fields(body);
        assert_eq!(f.kind, "Overlay");
        assert_eq!(f.anchor, "TopRight");
        assert_eq!(f.page_scopes, vec!["Any".to_string()]);
        assert_eq!(f.id, "calendar_grid");
        assert_eq!(f.fingerprint, "v1");
        assert_eq!(f.label, "Calendar");
    }

    #[test]
    fn scan_real_mod() {
        let r = crate::mod_scanner::scan_mod_ui(r"D:\Oreui\dearoreui-ExampleMod".into()).unwrap();
        println!("targets={}", r.targets.len());
        for t in &r.targets {
            println!(
                "  entry={} title={} kind={} anchor={} scopes={:?} ps_len={} dom_len={}",
                t.entry, t.title, t.kind, t.anchor, t.page_scopes, t.page_script.len(), t.dom_script.len()
            );
        }
        println!("files={:?}", r.files);
        println!("warnings={:?}", r.warnings);
    }
}