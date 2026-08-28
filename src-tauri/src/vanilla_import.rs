//! M0 原版资源导入器（VanillaImporter）
//!
//! 从游戏数据目录 `<game>/data/gui/dist/hbui` 导入主题 CSS、字体、atlas、
//! 原版屏幕（HTML）到设计工具本地 VFS `vanilla/<ver>/`，并生成
//! `vanillaManifest.json` 记录来源版本与清单。
//!
//! 规划：`DearOreUI-离线UI预览与布局规范化-需求架构执行.md` §1.6 / §2.1b / M0

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 单个导入文件的落地记录。
#[derive(Debug, Serialize, Clone)]
pub struct ImportedFile {
    pub rel: String,
    pub bytes: u64,
}

/// import_vanilla 命令的返回结构。
#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub version: String,
    pub root: String,
    pub css: Vec<ImportedFile>,
    pub fonts: Vec<ImportedFile>,
    pub atlas: Vec<ImportedFile>,
    pub screens: Vec<ImportedFile>,
    pub assets: Vec<ImportedFile>,
    pub screen_ids: Vec<String>,
    pub total_bytes: u64,
    pub errors: Vec<String>,
    pub ok: bool,
}

#[derive(Default)]
struct Groups {
    css: Vec<ImportedFile>,
    fonts: Vec<ImportedFile>,
    atlas: Vec<ImportedFile>,
    screens: Vec<ImportedFile>,
    assets: Vec<ImportedFile>,
}

/// 按相对路径把每个资源归入子目录（与真实 hbui 布局解耦，按模式分类）。
fn classify(rel: &str) -> &'static str {
    let lower = rel.to_lowercase().replace('\\', "/");
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    if name.ends_with(".css") {
        return "css";
    }
    if lower.contains("/fonts/") || lower.starts_with("fonts/") {
        return "fonts";
    }
    if (name.ends_with(".png") || name.ends_with(".json")) && name.contains("atlas") {
        return "atlas";
    }
    if name.ends_with(".html") {
        return "screens";
    }
    "assets"
}

/// 备份着色：遍历 source 目录，把文件按分类复制到 out/<sub>/<rel>。
/// rel 是相对 source 的路径（正斜杠），用于 VFS 里的 `vanilla://` 解析。
fn import_tree(
    source: &Path,
    out: &Path,
    groups: &mut Groups,
    screen_ids: &mut Vec<String>,
    errors: &mut Vec<String>,
) {
    let mut stack: Vec<PathBuf> = vec![source.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                errors.push(format!("读取目录 {:?} 失败: {e}", dir));
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = match path.strip_prefix(source) {
                Ok(r) => r
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/"),
                Err(_) => path
                    .file_name()
                    .map(|f| f.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            };

            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(e) => {
                    errors.push(format!("读取 {:?} 类型失败: {e}", path));
                    continue;
                }
            };

            if ft.is_dir() {
                stack.push(path);
                continue;
            }

            // routes.json 不落地，仅解析出原版屏幕 id 清单。
            if rel.eq_ignore_ascii_case("routes.json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(arr) = json.as_array() {
                            for item in arr {
                                if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                                    if !screen_ids.contains(&id.to_string()) {
                                        screen_ids.push(id.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
                continue;
            }

            let cat = classify(&rel);
            // 镜像源目录结构（保持真实相对路径，便于预览侧按原路径解析引用），
            // 分类仅用于 manifest 分组统计。
            let dest = out.join(&rel);
            if let Some(parent) = dest.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let file = ImportedFile { rel, bytes: size };

            match fs::copy(&path, &dest) {
                Ok(_) => match cat {
                    "css" => groups.css.push(file),
                    "fonts" => groups.fonts.push(file),
                    "atlas" => groups.atlas.push(file),
                    "screens" => groups.screens.push(file),
                    _ => groups.assets.push(file),
                },
                Err(e) => errors.push(format!("复制 {:?} 失败: {e}", path)),
            }
        }
    }
}

fn total_bytes(groups: &Groups) -> u64 {
    [&groups.css, &groups.fonts, &groups.atlas, &groups.screens, &groups.assets]
        .iter()
        .flat_map(|g| g.iter())
        .map(|f| f.bytes)
        .sum()
}

#[tauri::command]
pub fn import_vanilla(
    source: String,
    dest: String,
    version: Option<String>,
) -> Result<ImportResult, String> {
    let src = PathBuf::from(&source);
    if !src.is_dir() {
        return Err(format!("源目录不存在或不合法: {}", src.display()));
    }

    // 兼容两种入口：直接给 hbui 目录，或给 gui/dist 目录（内部找 hbui）。
    let base = if src.join("index.html").is_file() {
        src.clone()
    } else if src.join("hbui").is_dir() {
        src.join("hbui")
    } else {
        src.clone()
    };
    if !base.is_dir() {
        return Err(format!(
            "在 {} 下未找到可用的 hbui 资源目录",
            src.display()
        ));
    }

    let ver = version
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "v-unknown".to_string());
    let out_root = PathBuf::from(&dest).join("vanilla").join(&ver);
    fs::create_dir_all(&out_root)
        .map_err(|e| format!("无法创建输出目录 {:?}: {e}", out_root))?;

    let mut groups = Groups::default();
    let mut screen_ids = Vec::new();
    let mut errors = Vec::new();
    import_tree(&base, &out_root, &mut groups, &mut screen_ids, &mut errors);

    let total = total_bytes(&groups);
    let result = ImportResult {
        version: ver.clone(),
        root: out_root.display().to_string(),
        css: groups.css,
        fonts: groups.fonts,
        atlas: groups.atlas,
        screens: groups.screens,
        assets: groups.assets,
        screen_ids,
        total_bytes: total,
        errors,
        ok: true,
    };

    write_manifest(&out_root, &result)?;
    Ok(result)
}

/// 写 vanillaManifest.json（含版本、各分组文件清单、屏幕 id 清单）。
fn write_manifest(root: &Path, r: &ImportResult) -> Result<(), String> {
    let manifest = serde_json::json!({
        "version": r.version,
        "counts": {
            "css": r.css.len(),
            "fonts": r.fonts.len(),
            "atlas": r.atlas.len(),
            "screens": r.screens.len(),
            "assets": r.assets.len(),
            "total_bytes": r.total_bytes,
        },
        "screen_ids": &r.screen_ids,
        "files": {
            "css": r.css.iter().map(|f| &f.rel).collect::<Vec<_>>(),
            "fonts": r.fonts.iter().map(|f| &f.rel).collect::<Vec<_>>(),
            "atlas": r.atlas.iter().map(|f| &f.rel).collect::<Vec<_>>(),
            "screens": r.screens.iter().map(|f| &f.rel).collect::<Vec<_>>(),
            "assets": r.assets.iter().map(|f| &f.rel).collect::<Vec<_>>(),
        },
    });
    let path = root.join("vanillaManifest.json");
    let text = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("序列化 manifest 失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入 {:?} 失败: {e}", path))
}

/// list_vanilla_screens 的返回结构。
#[derive(Debug, Serialize)]
pub struct VanillaScreensResult {
    pub version: String,
    pub screens: Vec<String>,
    pub ok: bool,
}

/// 扫描本地 VFS `vanilla/<ver>/`，返回最新版本的原子屏幕清单。
/// 供 PlaySelector 组装“原版改造”组合。设计文档 §1.6 / §1.7。
#[tauri::command]
pub fn list_vanilla_screens(vfs_root: String) -> Result<VanillaScreensResult, String> {
    let root = PathBuf::from(&vfs_root).join("vanilla");
    if !root.is_dir() {
        return Ok(VanillaScreensResult { version: String::new(), screens: Vec::new(), ok: true });
    }

    let mut versions: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| format!("读取 {:?} 失败: {e}", root))? {
        let Ok(e) = entry else { continue };
        if e.path().is_dir() {
            versions.push(e.path());
        }
    }
    // 字典序即大致版本序；取最后一个作为“最新”。
    versions.sort();
    let newest = versions.last();
    let Some(newest) = newest else {
        return Ok(VanillaScreensResult { version: String::new(), screens: Vec::new(), ok: true });
    };

    let version = newest
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or_default()
        .to_string();

    let manifest_path = newest.join("vanillaManifest.json");
    let screens = if manifest_path.is_file() {
        let content = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("读取 {:?} 失败: {e}", manifest_path))?;
        let json: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("解析 {:?} 失败: {e}", manifest_path))?;
        json.get("screen_ids")
            .and_then(|v| v.as_array())
            .map(|xs| xs.iter().filter_map(|x| x.as_str()).map(|s| s.to_string()).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(VanillaScreensResult { version, screens, ok: true })
}