//! 主窗口显隐与位置恢复（setup、托盘、单实例、关窗最小化共用）

use tauri::Manager;

/// 显示并聚焦主窗口（托盘点击 / 菜单 / 第二实例激活）
pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        let _ = app.show();
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 隐藏主窗口到托盘
pub(crate) fn hide_main_window_to_tray(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    // macOS 上连 Dock 图标一起隐去，驻留托盘才完整
    #[cfg(target_os = "macos")]
    let _ = app.hide();
}
