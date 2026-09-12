// shared/commands：集中式类型化 IPC——命令名全仓只出现在这里（ADR 0010）
// 参数名与 Rust 侧 #[tauri::command] 签名一一对应

import { invoke } from "@tauri-apps/api/core";
import { log } from "./logger";
import type {
  DshLatestInfo,
  DshStatus,
  DshStepEvent,
  DiscoveryCompat,
  InstalledPlugin,
  InstallOutcome,
  LauncherConfig,
  MarketCatalog,
  ImportGroup,
  ImportRunResult,
  MarketDiagnostics,
  ModelCatalogFile,
  ModelConfig,
  ModelCredentialInfo,
  PluginReleaseNotes,
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
// 本地快照直读（首屏秒显，不涉及网络）；缺失/损坏为 null
export const marketSnapshot = () => invokeTyped<MarketCatalog | null>("market_snapshot");
export const marketInstalled = () => invokeTyped<InstalledPlugin[]>("market_installed");
// 成功返回安装回执（落进 profile 的 name+spec）；无法唯一定位落点（github: 重装）时为 null。
// 被 pnpm 拦截构建脚本时返回 needsApproval（包名 + 待写 yaml 路径），走用户审批流
export const marketInstall = (specifier: string) => invokeTyped<InstallOutcome>("market_install", { specifier });
// 用户审批放行后执行：写入 profile 的 pnpm-workspace.yaml → 重跑安装（过
// 同一安装护栏），返回与 market_install 同构的安装结果
export const marketApproveBuilds = (specifier: string, packages: string[]) =>
  invokeTyped<InstallOutcome>("market_approve_builds", { specifier, packages });
export const marketRemove = (name: string) => invokeTyped<void>("market_remove", { name });
// 翻转插件下次启动启用状态（写 profile cordis.patch.yml 的 disabled 覆盖行，
// 重启 dsh web 后生效）；返回落盘后的启停事实
export const marketSetPluginEnabled = (name: string, enabled: boolean) =>
  invokeTyped<InstalledPlugin>("market_set_plugin_enabled", { name, enabled });
// 更新检测：npm 形态已装插件比对 registry latest；全部可检包都失败才报错
export const marketCheckUpdates = () => invokeTyped<PluginUpdateInfo[]>("market_check_updates");
// 批量更新前预下载（store 预热）：并发 pnpm store add 把 npm 形态更新包的
// tarball 拉进内容寻址 store，随后串行 dsh plugin add 直接复用（零下载）。
// 恒 Ok（单包失败容忍），profile 不可得等系统级错误才 reject
export const marketPrefetch = (specifiers: string[]) =>
  invokeTyped<void>("market_prefetch", { specifiers });
// 取消当前活跃的插件安装/移除（busy 态取消按钮，G2）；无活跃命令返回 false（幂等）
export const marketCancel = () => invokeTyped<boolean>("market_cancel");
// 发现页兼容性批量查询（G4）：目录不携带 npm manifest，前端对可见卡片的
// npm 形态包名分批查询；部分失败以缺席表达（按未知处理）
export const marketDiscoveryCompat = (names: string[]) =>
  invokeTyped<DiscoveryCompat[]>("market_discovery_compat", { names });
// 更新说明（G5）：awesome-dsh-plugin 目录侧每日探针；未覆盖的仓库返回 null
export const marketReleaseNotes = (repo: string) =>
  invokeTyped<PluginReleaseNotes | null>("market_release_notes", { repo });
// 深度诊断（G7）：dsh --dump-config 组合事实（重复入口 id / 孤儿 patch 行）
export const marketDiagnostics = () => invokeTyped<MarketDiagnostics>("market_diagnostics");

// ============ 模型配置 ============
export const modelConfigLoad = () => invokeTyped<ModelConfig>("model_config_load");
export const modelConfigSave = (config: ModelConfig) => invokeTyped<void>("model_config_save", { config });
// models.dev 全量目录：load 读本地快照（缺失/损坏为 null），refresh 拉取并落快照
export const modelCatalogLoad = () => invokeTyped<ModelCatalogFile | null>("model_catalog_load");
export const modelCatalogRefresh = () => invokeTyped<ModelCatalogFile>("model_catalog_refresh");
// DSH credential plane：读取只返回 configured/source/writable，secret 从不回传前端。
// set 是唯一携带明文 secret 的单向 IPC；unset 删除 managed credential reference。
export const modelCredentialDescribe = (names: string[]) =>
  invokeTyped<Record<string, ModelCredentialInfo>>("model_credential_describe", { names });
export const modelCredentialSet = (name: string, value: string) =>
  invokeTyped<ModelCredentialInfo>("model_credential_set", { name, value });
export const modelCredentialUnset = (name: string) =>
  invokeTyped<ModelCredentialInfo>("model_credential_unset", { name });
// 旧 Models UI 仍暂时使用 launcher 进程环境状态；下一步 UI cutover 后删除。
export const modelEnvStatus = (names: string[]) =>
  invokeTyped<Record<string, boolean>>("model_env_status", { names });
export type ProviderModelsCacheEntry = { models: string[]; fetchedAt: number };
// Provider 模型发现缓存：按连接指纹读取，只返回模型 ID 与时间戳。
export const modelRemoteCacheGet = (
  baseURL: string,
  api: string | null,
  apiKeyEnv: string | null,
  headers: Record<string, string | undefined> | null = null,
) =>
  invokeTyped<ProviderModelsCacheEntry | null>("model_remote_cache_get", {
    baseUrl: baseURL,
    api,
    apiKeyEnv,
    headers,
  });
// 独立连接测试：向真实推理端点发送最多 16 个输出 token 的最小请求；不依赖 /models。
export const modelTestConnection = (
  baseURL: string,
  api: string,
  apiKeyEnv: string | null,
  headers: Record<string, string | undefined> | null,
  model: string,
) =>
  invokeTyped<void>("model_test_connection", { baseUrl: baseURL, api, apiKeyEnv, headers, model });
// 上游模型列表仅负责模型发现；密钥经环境变量名解析，普通 Provider headers 一并发送，
// 凭据类保留头由 Rust 层再次过滤，不能覆盖 apiKeyEnv 认证。
export const modelRemoteList = (
  baseURL: string,
  api: string | null,
  apiKeyEnv: string | null,
  headers: Record<string, string | undefined> | null = null,
) =>
  // Tauri 按 camelCase 形参名取参：base_url → baseUrl（baseURL 永不命中）
  invokeTyped<string[]>("model_remote_list_with_headers", { baseUrl: baseURL, api, apiKeyEnv, headers });
// 配置导入：扫描本机其他工具的 provider 声明（缺失来源静默为空组），按 key 导入
export const modelConfigImportScan = () => invokeTyped<ImportGroup[]>("model_config_import_scan");
export const modelConfigImportRun = (keys: string[]) =>
  invokeTyped<ImportRunResult>("model_config_import_run", { keys });

// ============ 更新 ============
export const getUpdaterConfigHealth = () => invokeTyped<UpdaterConfigHealth>("get_updater_config_health");
export const getUpdaterHelpPaths = () => invokeTyped<UpdaterHelpPaths>("get_updater_help_paths");
export const checkUpdate = (expectedVersion: string | null) =>
  invokeTyped<UpdateInfo>("check_update", { expectedVersion });
export const installUpdate = (expectedVersion: string | null) =>
  invokeTyped<string>("install_update", { expectedVersion });

// ============ 语言 ============
export const getResolvedLanguage = () => invokeTyped<string>("get_resolved_language");
export const setLanguage = (setting: string) => invokeTyped<void>("set_language", { setting });