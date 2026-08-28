//! 模组目录文件监听（预览自动刷新）。
//!
//! 监听用户选择的模组源码目录，仅对 `*.h / *.hpp / *.cpp / *.cc` 的
//! `Create / Modify` 事件向前端发出 `mod-source-changed` 事件，前端据此
//! 防抖后重新调用 [`scan_mod_ui`](crate::mod_scanner::scan_mod_ui) 自动刷新预览。

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// 监听状态：持有停止信号，保证同一时刻只有一个活跃 watcher。
pub struct WatchState {
    stop_tx: Mutex<Option<mpsc::Sender<()>>>,
}

impl Default for WatchState {
    fn default() -> Self {
        Self {
            stop_tx: Mutex::new(None),
        }
    }
}

fn is_source(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some("h" | "hpp" | "cpp" | "cc") => true,
        _ => false,
    }
}

/// 停止当前监听（如果有）。
pub(crate) fn stop_watch_inner(state: &State<WatchState>) {
    if let Some(tx) = state.stop_tx.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

/// 监听模组源码目录。重复调用会先停止上一次监听。
#[tauri::command]
pub fn start_watch(app: AppHandle, dir: String, state: State<WatchState>) -> Result<(), String> {
    stop_watch_inner(&state);

    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let app2 = app.clone();

    std::thread::spawn(move || {
        let mut watcher = match RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    let is_create_modify = matches!(
                        ev.kind,
                        EventKind::Create(_) | EventKind::Modify(_)
                    );
                    if is_create_modify && ev.paths.iter().any(|p| is_source(p)) {
                        let _ = app2.emit("mod-source-changed", ());
                    }
                }
            },
            Config::default(),
        ) {
            Ok(w) => w,
            Err(_e) => {
                return;
            }
        };

        let root = Path::new(&dir);
        if let Err(_e) = watcher.watch(root, RecursiveMode::Recursive) {
            return;
        }

        // 阻塞直到被停止，保持 watcher 存活。
        let _ = stop_rx.recv();
    });

    *state.stop_tx.lock().unwrap() = Some(stop_tx);
    Ok(())
}

/// 停止监听。
#[tauri::command]
pub fn stop_watch(state: State<WatchState>) {
    stop_watch_inner(&state);
}