//! 系统托盘：菜单构建（含 dsh 三键可用性镜像）与托盘图标装配。
//! dsh 三键的启用规则只在本模块（build_tray_menu）：前端经 sync_tray_dsh_actions
//! 推送裸事实 {running, busy}，这里完成「空闲且未运行才可启动」的映射。

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::Emitter;

use crate::i18n;
use crate::window;

/// 托盘 dsh 三键的状态镜像 (running, busy)：前端 store 是唯一事实来源，
/// 经 sync_tray_dsh_actions 推送，这里只缓存最近一次同步值，供菜单重建
/// （语言切换）时复用，避免 Rust 侧再推一份运行状态
static TRAY_DSH_STATE: std::sync::Mutex<(bool, bool)> = std::sync::Mutex::new((false, false));

/// 按当前解析语言构建托盘菜单（setup 与语言切换重建共用）。
/// dsh 三键的可用性与首页按钮一致：启动仅在「未运行且空闲」时可用，
/// 关闭/重启仅在「运行中且空闲」时可用（该映射是托盘侧唯一 busy 规则）
fn build_tray_menu(
    app: &tauri::AppHandle,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let (running, busy) = TRAY_DSH_STATE.lock().map(|s| *s).unwrap_or((false, false));
    let show = MenuItemBuilder::with_id("show", i18n::tr("Show Main Window")).build(app)?;
    let start = MenuItemBuilder::with_id("dsh-start", i18n::tr("One-click start dsh web"))
        .enabled(!busy && !running)
        .build(app)?;
    let stop = MenuItemBuilder::with_id("dsh-stop", i18n::tr("One-click stop dsh web"))
        .enabled(!busy && running)
        .build(app)?;
    let restart = MenuItemBuilder::with_id("dsh-restart", i18n::tr("One-click restart dsh web"))
        .enabled(!busy && running)
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", i18n::tr("Quit")).build(app)?;
    Ok(MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&start)
        .item(&stop)
        .item(&restart)
        .separator()
        .item(&quit)
        .build()?)
}

/// 托盘重建菜单的共用路径：按当前语言与 TRAY_DSH_STATE 重建并替换
pub(crate) fn rebuild_tray_menu(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let menu = build_tray_menu(app).map_err(|e| {
            log::error!("[rebuild_tray_menu] 重建托盘菜单失败: {}", e);
            e.to_string()
        })?;
        tray.set_menu(Some(menu)).map_err(|e| {
            log::error!("[rebuild_tray_menu] 设置托盘菜单失败: {}", e);
            e.to_string()
        })?;
    }
    Ok(())
}

/// 前端推送 dsh 运行状态（dshRunning / 任一流程 busy），托盘三键随之镜像
/// 首页按钮的可用性。同值幂等跳过，避免无谓的菜单重建
#[tauri::command]
pub(crate) fn sync_tray_dsh_actions(
    app: tauri::AppHandle,
    running: bool,
    busy: bool,
) -> Result<(), String> {
    if let Ok(mut state) = TRAY_DSH_STATE.lock() {
        if *state == (running, busy) {
            return Ok(());
        }
        *state = (running, busy);
    }
    rebuild_tray_menu(&app)
}

/// 创建系统托盘（图标 + 菜单 + 事件）
pub(crate) fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::tray::TrayIconBuilder;

    let menu = build_tray_menu(app.handle())?;

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("DSH Pro Max")
        .show_menu_on_left_click(false);
    // macOS 菜单栏用单色 template 图（黑色+alpha，随亮暗模式与高亮自动适配）。
    // 图案 = 应用图标原插画的角色剪影：亮度硬阈值取墨线 → potrace 矢量化
    // （icons/tray-icon.svg 母版）→ 36px 渲染（对齐 muda 硬编码的 18pt 绘制
    // 尺寸，Retina 2x 1:1）。墨覆盖率必须压在 ~1/3：过高会在 18pt 下缩成
    // 「白色实心块」，看起来像带背景色的瓷片
    #[cfg(target_os = "macos")]
    {
        tray = tray
            .icon(tauri::include_image!("icons/tray-icon-Template.png"))
            .icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        "show" => window::show_main_window(app),
        // dsh 三键只是远端触发器：交互逻辑（模式选择、busy 守卫、时间轴、
        // 打开浏览器）在前端 dshActions 单独实现，转发菜单 id 由前端执行；
        // 主窗口已关闭（webview 销毁）时与「显示主窗口」一样静默无效
        "dsh-start" | "dsh-stop" | "dsh-restart" => {
            let _ = app.emit("tray-dsh-action", event.id().as_ref());
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let tauri::tray::TrayIconEvent::Click {
            button: tauri::tray::MouseButton::Left,
            button_state: tauri::tray::MouseButtonState::Up,
            ..
        } = event
        {
            window::show_main_window(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}
