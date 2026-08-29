mod fs_watch;
mod mod_scanner;
mod preview_assets;
mod vanilla_import;

/// 当前应用版本（与发布 tag 同步：release.yml 构建前写回 Cargo.toml）。供“检查更新”对比。
#[tauri::command]
fn current_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 用系统默认浏览器打开外部链接（仅 Windows；检查更新跳转下载页用）。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    Err("暂仅支持 Windows 打开浏览器".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
        tauri::Builder::default()
        .setup(|app| {
            // 主窗口应用 Acrylic 毛玻璃（Windows）。标题栏保持透明透出系统打磨背景，
            // 下方 workspace 用实色覆盖。
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                use window_vibrancy::apply_acrylic;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = apply_acrylic(window, Some((247, 247, 247, 150)));
                }
            }
            Ok(())
        })
        .manage(fs_watch::WatchState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            vanilla_import::import_vanilla,
            vanilla_import::list_vanilla_screens,
            preview_assets::load_ui_assets,
            mod_scanner::scan_mod_ui,
            fs_watch::start_watch,
            fs_watch::stop_watch,
            current_app_version,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}