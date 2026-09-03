// shared/commands：集中式类型化 IPC——命令名全仓只出现在这里（ADR 0010）
// 参数名与 Rust 侧 #[tauri::command] 签名一一对应

import { invoke } from "@tauri-apps/api/core";
import { log } from "./logger";
import type {
  DshLatestInfo,
  DshStatus,
  DshStepEvent,
  InstalledPlugin,
  InstallOutcome,
  InstallReceipt,
  LauncherConfig,
  MarketCatalog,
  ModelConfig,
  PluginUpdateInfo,
  UpdateInfo,
  UpdaterConfigHealth,
  UpdaterHelpPaths,
} from "./types";

/// 唯一 invoke 出口：失败统一记一条前端日志（带命令名），再原样抛给调用方 toast。
/// 命令名全仓只出现在这里（ADR 0010），新命令必须经此包装。
async function invokeTyped<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    log.error(`invoke ${command}`, e);
    throw e;
  }
}

// ============ 配置 ============
export const loadConfig = () => invokeTyped<LauncherConfig>("load_config");
export const updateSettings = (config: LauncherConfig) => invokeTyped<void>("update_settings", { config });
export const autostartIsEnabled = () => invokeTyped<boolean>("autostart_is_enabled");
export const autostartSet = (enabled: boolean) => invokeTyped<void>("autostart_set", { enabled });
export const getLogDir = () => invokeTyped<string>("get_log_dir");

// ============ dsh ============
export const dshDetect = (verifyRemoteUrl = false) =>
  invokeTyped<DshStatus>("dsh_detect", { verifyRemoteUrl });
// 步骤骨架（全 pending + 标题 key）：新流程开始时的重置形态，步骤序列与
// 标题都来自 Rust 契约，前端不持有步骤列表副本
export const dshStepSchema = (remote: boolean) =>
  invokeTyped<DshStepEvent[]>("dsh_step_schema", { remote });
export const dshSetup = () => invokeTyped<void>("dsh_setup");
export const dshStartWeb = () => invokeTyped<string>("dsh_start_web");
// dsh-web.log 尾部：启动失败节点「查看日志」内嵌展示用（缺失/为空返回空串）
export const dshWebLog = () => invokeTyped<string>("dsh_web_log");
export const dshStop = () => invokeTyped<void>("dsh_stop");
export const dshUpdate = () => invokeTyped<string>("dsh_update");
export const dshRemovePlugins = () => invokeTyped<void>("dsh_remove_plugins");
export const dshCheckLatest = () => invokeTyped<DshLatestInfo>("dsh_check_latest");
export const dshInstallVersion = (version: string) => invokeTyped<string>("dsh_install_version", { version });
export const dshSetAutostart = (enabled: boolean) => invokeTyped<void>("dsh_set_autostart", { enabled });
// 托盘 dsh 三键的可用性镜像首页按钮：推送 dshRunning / 任一流程 busy
export const syncTrayDshActions = (running: boolean, busy: boolean) =>
  invokeTyped<void>("sync_tray_dsh_actions", { running, busy });

// ============ 插件市场 ============
export const marketFetch = () => invokeTyped<MarketCatalog>("market_fetch");
// 本地快照直读（首屏秒显，不涉及网络）；缺失/损坏/旧格式返回 null
export const marketSnapshot = () => invokeTyped<MarketCatalog | null>("market_snapshot");
export const marketInstalled = () => invokeTyped<InstalledPlugin[]>("market_installed");
// 成功返回安装回执（落进 profile 的 name+spec）；无法唯一定位落点（github: 重装）时为 null。
// 被 pnpm 拦截构建脚本时返回 needsApproval（包名 + 待写 yaml 路径），走用户审批流
export const marketInstall = (specifier: string) => invokeTyped<InstallOutcome>("market_install", { specifier });
// 用户审批放行后执行：写入 profile 的 pnpm-workspace.yaml → 重跑安装，返回安装回执
export const marketApproveBuilds = (specifier: string, packages: string[]) =>
  invokeTyped<InstallReceipt | null>("market_approve_builds", { specifier, packages });
export const marketRemove = (name: string) => invokeTyped<void>("market_remove", { name });
// 更新检测：npm 形态已装插件比对 registry latest；全部可检包都失败才报错
export const marketCheckUpdates = () => invokeTyped<PluginUpdateInfo[]>("market_check_updates");

// ============ 模型配置 ============
export const modelConfigLoad = () => invokeTyped<ModelConfig>("model_config_load");
export const modelConfigSave = (config: ModelConfig) => invokeTyped<void>("model_config_save", { config });

// ============ 更新 ============
export const getUpdaterConfigHealth = () => invokeTyped<UpdaterConfigHealth>("get_updater_config_health");
export const getUpdaterHelpPaths = () => invokeTyped<UpdaterHelpPaths>("get_updater_help_paths");
export const checkUpdate = () => invokeTyped<UpdateInfo>("check_update");
export const installUpdate = (expectedVersion: string | null) =>
  invokeTyped<string>("install_update", { expectedVersion });

// ============ 语言 ============
export const getResolvedLanguage = () => invokeTyped<string>("get_resolved_language");
export const setLanguage = (setting: string) => invokeTyped<void>("set_language", { setting });
