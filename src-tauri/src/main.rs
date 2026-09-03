// 发布版按 Windows GUI 子系统链接，否则双击 exe 会附带一个控制台窗口，
// 关掉控制台会把整个进程树（含软件窗体）一起杀掉
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 装配点：插件注册、命令路由与 setup/窗口钩子。实现按域分文件——
// tray（菜单与托盘图标）、window（显隐与恢复）、updater、config、i18n、dsh

use tauri::Manager;

mod config;
mod dsh;
mod i18n;
mod logging;
mod tray;
mod updater;
mod version;
mod window;

use config::LauncherConfig;

/// 进程事故通知需要的全局 AppHandle（setup 时填充）
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// 受管子进程事故系统通知（ADR 0006：仅限生命周期事故，漂移/updater 不弹）
#[allow(dead_code)]
pub(crate) fn notify_process_failure(name: &str, message: &str) {
    use tauri_plugin_notification::NotificationExt;
    let Some(app) = APP_HANDLE.get() else { return };
    let _ = app
        .notification()
        .builder()
        .title(i18n::keyf("{name} failed", &[("name", name.to_string())]))
        .body(message)
        .show();
}

/// 命令错误适配的统一实现：记错误日志后把错误文本交给前端 toast。
/// 薄命令适配器删不掉（Tauri 要求 #[tauri::command] 签名），但日志+转串
/// 的样板只写一次
fn command_err(e: impl std::fmt::Display) -> String {
    log::error!("{}", e);
    e.to_string()
}

/// 开机自启动开关：事实来源是 OS 注册项（插件），不在 LauncherConfig 里存布尔值
#[tauri::command]
fn autostart_is_enabled(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let r = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    r.map_err(command_err)
}

/// 日志目录路径（设置页「打开日志目录」按钮用）
#[tauri::command]
fn get_log_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_log_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(command_err)
}

/// 加载配置
#[tauri::command]
async fn load_config() -> Result<LauncherConfig, String> {
    config::load_config()
}

/// 当前解析语言（"en" | "zh-CN"），前端初始化 i18next 时取
#[tauri::command]
fn get_resolved_language() -> String {
    i18n::current().to_string()
}

/// 语言设置变更：重新解析并用新语言重建托盘菜单
/// （config 由前端经 update_settings 落盘，这里只切运行时状态）
#[tauri::command]
fn set_language(app: tauri::AppHandle, setting: String) -> Result<(), String> {
    i18n::set_current(i18n::resolve_language(&setting));
    tray::rebuild_tray_menu(&app)
}

/// 保存配置（全量覆盖，仅前端已知字段的场景使用）
#[tauri::command]
async fn save_config(config: LauncherConfig) -> Result<(), String> {
    config::save_config(&config)
}

/// 仅更新设置类字段，保留其余字段不变
#[tauri::command]
async fn update_settings(config: LauncherConfig) -> Result<(), String> {
    let mut current = config::load_config()?;
    config::merge_settings(&mut current, &config);
    config::save_config(&current)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // panic 落盘：logger 初始化后发生的 panic 进日志文件，
    // 用户报「应用打不开」时现场可查。初始化前的早期 panic 只进 stderr（已知上限）
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {}", info);
        default_hook(info);
    }));

    tauri::Builder::default()
        // single-instance 必须最先注册：第二实例在此退出，其余插件不重复初始化
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show_main_window(app);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // 单文件上限 2MB，超限后轮转（KeepOne：旧文件直接删除，仅保留当前一份）
                .max_file_size(2 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .build(),
        )
        // args 在 macOS 登录项上不生效，mac 自启会显示主窗口而非静默到托盘
        .plugin(tauri_plugin_autostart::Builder::new().args(["--autostart"]).build())
        // 不记 VISIBLE：自启静默到托盘不该被持久化成「下次也不显示」
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::PendingUpdateState::default())
        .setup(|app| {
            log::info!("DSH Pro Max 启动中...");
            let _ = APP_HANDLE.set(app.handle().clone());
            // 启动即解析界面语言（system → 具体语言），托盘与后续所有产串处都读它
            let setting = config::load_config()
                .map(|c| c.language)
                .unwrap_or_else(|_| "system".to_string());
            i18n::set_current(i18n::resolve_language(&setting));
            if let Err(e) = tray::setup_tray(app) {
                log::error!("初始化系统托盘失败: {}", e);
            }
            // 主窗口保持可交互创建；自启拉起（--autostart）再隐藏到托盘，
            // 避免 macOS WebKit 在隐藏创建后再显示时丢失鼠标事件。
            if std::env::args().any(|a| a == "--autostart") {
                window::hide_main_window_to_tray(app.handle());
            } else {
                // window-state 恢复的坐标可能落在已拔掉的显示器上；
                // 与任一显示器可视区无交集时放弃恢复位置、改居中
                if let Some(window) = app.get_webview_window("main") {
                    let on_screen = match (window.outer_position(), window.outer_size()) {
                        (Ok(pos), Ok(size)) => {
                            let monitors = window.available_monitors().unwrap_or_default();
                            monitors.is_empty()
                                || monitors.iter().any(|m| {
                                    let mp = m.position();
                                    let ms = m.size();
                                    pos.x + size.width as i32 > mp.x
                                        && pos.x < mp.x + ms.width as i32
                                        && pos.y + size.height as i32 > mp.y
                                        && pos.y < mp.y + ms.height as i32
                                })
                        }
                        _ => true,
                    };
                    if !on_screen {
                        let _ = window.center();
                    }
                }
                window::show_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let minimize_to_tray = config::load_config()
                    .map(|c| c.minimize_to_tray_on_close)
                    .unwrap_or(false);
                if minimize_to_tray {
                    // 阻止关闭，窗口隐入托盘
                    api.prevent_close();
                    window::hide_main_window_to_tray(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            autostart_is_enabled,
            autostart_set,
            get_log_dir,
            load_config,
            get_resolved_language,
            set_language,
            save_config,
            update_settings,
            dsh::dsh_detect,
            dsh::dsh_step_schema,
            dsh::dsh_setup,
            dsh::dsh_web_log,
            dsh::dsh_start_web,
            dsh::dsh_stop,
            dsh::dsh_set_autostart,
            tray::sync_tray_dsh_actions,
            dsh::dsh_update,
            dsh::dsh_remove_plugins,
            dsh::dsh_check_latest,
            dsh::dsh_install_version,
            dsh::market_fetch,
            dsh::market_installed,
            dsh::market_snapshot,
            dsh::market_install,
            dsh::market_approve_builds,
            dsh::market_remove,
            dsh::market_check_updates,
            dsh::model_config_load,
            dsh::model_config_save,
            updater::get_updater_config_health,
            updater::get_updater_help_paths,
            updater::check_update,
            updater::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("启动 DSH Pro Max 失败");
}

fn main() {
    run();
}
