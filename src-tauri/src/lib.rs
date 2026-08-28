mod fs_watch;
mod mod_scanner;
mod preview_assets;
mod vanilla_import;

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
            fs_watch::stop_watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}