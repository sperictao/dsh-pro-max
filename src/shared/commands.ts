// shared/commands：集中式类型化 IPC——命令名全仓只出现在这里（ADR 0010）
// 参数名与 Rust 侧 #[tauri::command] 签名一一对应

import { invoke } from "@tauri-apps/api/core";
import { log } from "./logger";
import type {
  DshLatestInfo,
  DshStatus,
  InstalledPlugin,
  LauncherConfig,
  MarketCatalog,
  ModelConfig,
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
export const dshSetup = () => invokeTyped<void>("dsh_setup");
export const dshStartWeb = () => invokeTyped<string>("dsh_start_web");
export const dshStop = () => invokeTyped<void>("dsh_stop");
export const dshUpdate = () => invokeTyped<string>("dsh_update");
export const dshRemovePlugins = () => invokeTyped<void>("dsh_remove_plugins");
export const dshCheckLatest = () => invokeTyped<DshLatestInfo>("dsh_check_latest");
export const dshInstallVersion = (version: string) => invokeTyped<string>("dsh_install_version", { version });
export const dshSetAutostart = (enabled: boolean) => invokeTyped<void>("dsh_set_autostart", { enabled });

// ============ 插件市场 ============
export const marketFetch = () => invokeTyped<MarketCatalog>("market_fetch");
export const marketInstalled = () => invokeTyped<InstalledPlugin[]>("market_installed");
export const marketInstall = (specifier: string) => invokeTyped<void>("market_install", { specifier });
export const marketRemove = (name: string) => invokeTyped<void>("market_remove", { name });

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
