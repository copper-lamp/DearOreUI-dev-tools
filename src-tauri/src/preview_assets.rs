//! M2 预览资产加载器
//!
//! 读取 <DearOreUI 数据目录>/preview/uiAssets.json（由核心层 UiAssetExporter
//! 在 registerComponent 成功后自动导出）。App 离线读取这份导出做预览，
//! 真机与预览同源（同一份 body/脚本文本）。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 单个预览 UI 资产（与核心层 UiPreviewAsset / uiAssets.json 字段对应）。
#[derive(Debug, Serialize, Clone)]
pub struct PreviewTarget {
    pub entry: String,
    pub title: String,
    pub kind: String,
    pub anchor: String,
    pub page_scopes: Vec<String>,
    pub container_id: String,
    pub fingerprint: String,
    pub html_body: String,
    pub dom_script: String,
    pub page_script: String,
}

/// load_ui_assets 命令的返回结构。
#[derive(Debug, Serialize)]
pub struct PreviewLoadResult {
    pub targets: Vec<PreviewTarget>,
    pub path: String,
    pub ok: bool,
}

/// 尝试在 dir 下定位 uiAssets.json：优先 <dir>/preview/uiAssets.json，
/// 也兼容直接给定 manifest 路径（file 或含 preview/ 的目录）。
fn locate_manifest(dir_or_file: &Path) -> Option<PathBuf> {
    // 1) 直接是文件
    if dir_or_file.is_file() && dir_or_file.file_name().map_or(false, |f| f == "uiAssets.json") {
        return Some(dir_or_file.to_path_buf());
    }
    // 2) 目录：先试 <dir>/preview/uiAssets.json
    if dir_or_file.is_dir() {
        let cand = dir_or_file.join("preview").join("uiAssets.json");
        if cand.is_file() {
            return Some(cand);
        }
        // 3) 目录里有 uiAssets.json 本身
        let cand2 = dir_or_file.join("uiAssets.json");
        if cand2.is_file() {
            return Some(cand2);
        }
    }
    // 4) 传入的本身就是 preview 目录
    if dir_or_file.is_dir() && dir_or_file.file_name().map_or(false, |f| f == "preview") {
        let cand = dir_or_file.join("uiAssets.json");
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// 把 uiAssets.json（数组）解析为 PreviewTarget 列表。
fn parse_targets(json: serde_json::Value) -> Result<Vec<PreviewTarget>, String> {
    let arr = json.as_array().ok_or_else(|| "uiAssets.json 根节点必须是数组".to_string())?;
    let mut targets = Vec::with_capacity(arr.len());
    for item in arr {
        let str = |name: &str| -> String {
            item.get(name).and_then(|v| v.as_str()).unwrap_or_default().to_string()
        };
        let scopes = item
            .get("pageScopes")
            .and_then(|v| v.as_array())
            .map(|xs| {
                xs.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        targets.push(PreviewTarget {
            entry: str("entry"),
            title: str("title"),
            kind: str("kind"),
            anchor: str("anchor"),
            page_scopes: scopes,
            container_id: str("containerId"),
            fingerprint: str("fingerprint"),
            html_body: str("htmlBody"),
            dom_script: str("domScript"),
            page_script: str("pageScript"),
        });
    }
    Ok(targets)
}

/// 读取并解析预览资产清单。`dir_or_file` 可为：
/// - DearOreUI 数据目录（内含 preview/uiAssets.json）
/// - 直接给 uiAssets.json 文件
/// - 给 preview 目录
#[tauri::command]
pub fn load_ui_assets(dir_or_file: String) -> Result<PreviewLoadResult, String> {
    let root = PathBuf::from(&dir_or_file);
    let manifest = locate_manifest(&root)
        .ok_or_else(|| format!("未在 {} 下找到 preview/uiAssets.json", root.display()))?;

    let content = fs::read_to_string(&manifest)
        .map_err(|e| format!("读取 {:?} 失败: {e}", manifest))?;
    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析 {:?} 失败: {e}", manifest))?;

    let targets = parse_targets(json)?;
    Ok(PreviewLoadResult {
        targets,
        path: manifest.display().to_string(),
        ok: true,
    })
}