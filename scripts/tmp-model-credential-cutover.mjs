import { readFileSync, writeFileSync, rmSync } from 'node:fs'

function read(path) { return readFileSync(path, 'utf8') }
function write(path, text) { writeFileSync(path, text) }
function replaceOnce(path, from, to) {
  const text = read(path)
  const first = text.indexOf(from)
  if (first < 0) throw new Error(`${path}: source snippet not found`)
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`${path}: source snippet is not unique`)
  write(path, text.slice(0, first) + to + text.slice(first + from.length))
}
function replaceCount(path, regex, replacer, expected) {
  const text = read(path)
  let count = 0
  const next = text.replace(regex, (...args) => { count += 1; return typeof replacer === 'function' ? replacer(...args) : replacer })
  if (count !== expected) throw new Error(`${path}: expected ${expected} replacements, got ${count}`)
  write(path, next)
}

// ---- shared credential UI rules (mirrors DSH 0.1.5-alpha.1) ----
write('src/features/models/credentials.ts', `import type { ProviderConfig } from "@/shared/types";

export type CredentialWrite = { ref: string; value: string };
export type ApiKeyFailure = "API key cannot be blank" | "API key contains invalid characters";

const LEGAL_API_KEY = /^[\\x21-\\x7E]+$/;
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/;

export function deriveCredentialRef(route: string): string {
  return \`\${route.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY\`;
}

export function credentialRefFor(provider: Pick<ProviderConfig, "route" | "apiKeyEnv">): string {
  return provider.apiKeyEnv?.trim() || deriveCredentialRef(provider.route.trim());
}

function isQuoted(value: string): boolean {
  const first = value[0];
  if (first !== '"' && first !== "'" && first !== "\\\`") return false;
  return value.length > 1 && value.endsWith(first);
}

export function apiKeyFailure(draft: string): ApiKeyFailure | null {
  if (draft.length === 0) return null;
  const value = draft.trim();
  if (value.length === 0) return "API key cannot be blank";
  if (ENV_LINE.test(value) || isQuoted(value) || !LEGAL_API_KEY.test(value)) {
    return "API key contains invalid characters";
  }
  return null;
}
`)
write('src/features/models/credentials.test.ts', `import { describe, expect, it } from "vitest";
import { apiKeyFailure, deriveCredentialRef } from "./credentials";

describe("model credentials", () => {
  it("derives the same conventional credential ref as DSH", () => {
    expect(deriveCredentialRef("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(deriveCredentialRef("minimax-cn")).toBe("MINIMAX_CN_API_KEY");
    expect(deriveCredentialRef("my.gateway/v2")).toBe("MY_GATEWAY_V2_API_KEY");
  });

  it("accepts a bare printable key and rejects wrapped/env-line/whitespace input", () => {
    expect(apiKeyFailure("")).toBeNull();
    expect(apiKeyFailure("sk-test_123.ABC")).toBeNull();
    expect(apiKeyFailure("   ")).toBe("API key cannot be blank");
    expect(apiKeyFailure("OPENAI_API_KEY=sk-test")).toBe("API key contains invalid characters");
    expect(apiKeyFailure("'sk-test'")).toBe("API key contains invalid characters");
    expect(apiKeyFailure("sk test")).toBe("API key contains invalid characters");
  });
});
`)

// ---- ProviderDialog: write-only API key; derived ref only when a key is entered ----
const dialog = 'src/features/models/ProviderDialog.tsx'
replaceOnce(dialog,
  'import { useProviderModels } from "./useProviderModels";\n',
  'import { useProviderModels } from "./useProviderModels";\nimport { apiKeyFailure, credentialRefFor, type CredentialWrite } from "./credentials";\n',
)
replaceOnce(dialog,
  '  onSubmit: (provider: ProviderConfig, originalRoute: string | null) => Promise<void>;\n',
  '  onSubmit: (provider: ProviderConfig, originalRoute: string | null, credential: CredentialWrite | null) => Promise<void>;\n',
)
replaceOnce(dialog,
  '  const [pickedPreset, setPickedPreset] = useState<ModelPreset | null>(null);\n',
  '  const [pickedPreset, setPickedPreset] = useState<ModelPreset | null>(null);\n  // Secret is write-only UI state: never hydrate it from ProviderConfig or the credential store.\n  const [apiKeyDraft, setApiKeyDraft] = useState("");\n',
)
replaceOnce(dialog,
  '  const editChanged = !isEdit || comparableProvider(draft) !== comparableProvider(state.provider);\n  // Add 尚未选服务时只有临时搜索文本，不算配置工作；一旦选定服务就保护这段进度。\n  const hasUnsavedChanges = isEdit ? editChanged : serviceChosen;\n',
  '  const configChanged = !isEdit || comparableProvider(draft) !== comparableProvider(state.provider);\n  const keyValue = apiKeyDraft.trim();\n  const apiKeyError = apiKeyFailure(apiKeyDraft);\n  const editChanged = configChanged || apiKeyDraft.length > 0;\n  // Add 尚未选服务时只有临时搜索文本，不算配置工作；一旦选定服务就保护这段进度。\n  const hasUnsavedChanges = isEdit ? editChanged : serviceChosen;\n',
)
replaceOnce(dialog,
  '  const updateConnection = (value: Partial<ProviderConfig>) => {\n',
  '  const updateApiKey = (value: string) => {\n    setApiKeyDraft(value);\n    invalidateTestResult();\n    setSubmitError(null);\n  };\n\n  const updateConnection = (value: Partial<ProviderConfig>) => {\n',
)
replaceOnce(dialog,
`  // 托管预设无显式 apiKeyEnv 时可能由 dsh/pi-ai 的 ambient/已存登录认证；
  // Launcher 自身拿不到那条凭据 seam，因此不主动撞匿名请求。自定义端点仍允许匿名发现。
  const discoveryActive =
    showComposer &&
    !currentUrlIssue &&
    Boolean(draft.baseURL?.trim()) &&
    (!knownService || Boolean(draft.apiKeyEnv?.trim()));
  const discovery = useProviderModels(discoveryActive, draft);
  const testTarget = providerConnectionTarget(draft);
  const launcherCanTest = !knownService || Boolean(draft.apiKeyEnv?.trim());
`,
`  // 已保存引用由 Rust credential plane 解析；尚未保存的 key 只随本次 Test/Fetch 请求传递。
  const hasRequestCredential = Boolean(draft.apiKeyEnv?.trim()) || keyValue.length > 0;
  const discoveryActive =
    showComposer &&
    !currentUrlIssue &&
    Boolean(draft.baseURL?.trim()) &&
    (!knownService || hasRequestCredential);
  const discovery = useProviderModels(discoveryActive, draft, keyValue || null);
  const testTarget = providerConnectionTarget(draft);
  const launcherCanTest = !knownService || hasRequestCredential;
`)
replaceOnce(dialog,
`        draft.headers,
        target.model,
      );`,
`        draft.headers,
        target.model,
        keyValue || null,
      );`)
replaceOnce(dialog,
  '    setSubmitError(null);\n    invalidateTestResult();\n\n    if (!preset) {\n',
  '    setSubmitError(null);\n    setApiKeyDraft("");\n    invalidateTestResult();\n\n    if (!preset) {\n',
)
replaceOnce(dialog,
  '    editChanged &&\n    !saving;\n',
  '    editChanged &&\n    !apiKeyError &&\n    !saving;\n',
)
replaceOnce(dialog,
`    try {
      await onSubmit(
        {
          ...draft,
          route: draft.route.trim(),
          displayName: draft.displayName?.trim() || null,
          baseURL: draft.baseURL?.trim() ? normalizeBaseUrl(draft.baseURL) : null,
          apiKeyEnv: draft.apiKeyEnv?.trim() || null,
        },
        isEdit ? state.provider.route : null,
      );
`,
`    try {
      const credentialRef = credentialRefFor(draft);
      await onSubmit(
        {
          ...draft,
          route: draft.route.trim(),
          displayName: draft.displayName?.trim() || null,
          baseURL: draft.baseURL?.trim() ? normalizeBaseUrl(draft.baseURL) : null,
          // Existing refs stay stable; a reference-free provider only records the conventional ref when a key is entered.
          apiKeyEnv: draft.apiKeyEnv?.trim() || (keyValue ? credentialRef : null),
        },
        isEdit ? state.provider.route : null,
        keyValue ? { ref: credentialRef, value: keyValue } : null,
      );
`)

const keyField = /([ \t]*)<label className="flex flex-col gap-1 text-xs opacity-70">\n\1  \{t\("API Key Env Var"\)\}\n\1  <input\n[\s\S]*?\n\1  \/>\n\1<\/label>/g
replaceCount(dialog, keyField, (_match, indent) => `${indent}<label className="flex flex-col gap-1 text-xs opacity-70">
${indent}  {t("API Key")}
${indent}  <input
${indent}    ref={apiKeyInputRef}
${indent}    type="password"
${indent}    className={INPUT_MONO}
${indent}    value={apiKeyDraft}
${indent}    onChange={(event) => updateApiKey(event.target.value)}
${indent}    placeholder={t("Enter API key")}
${indent}    aria-label={t("API Key")}
${indent}    aria-invalid={Boolean(apiKeyError)}
${indent}    autoComplete="off"
${indent}    spellCheck={false}
${indent}  />
${indent}  {apiKeyError && (
${indent}    <span role="alert" className="text-destructive">
${indent}      {t(apiKeyError)}
${indent}    </span>
${indent}  )}
${indent}</label>`, 3)

// ---- discovery hook: transient key is memory-only and bypasses stale persistent cache ----
const discovery = 'src/features/models/useProviderModels.ts'
replaceOnce(discovery,
`async function fetchRemote(provider: ProviderConfig): Promise<string[]> {
  return await cmd.modelRemoteList(
    provider.baseURL ?? "",
    provider.api ?? null,
    provider.apiKeyEnv ?? null,
    provider.headers,
  );
}`,
`async function fetchRemote(provider: ProviderConfig, apiKey: string | null): Promise<string[]> {
  return await cmd.modelRemoteList(
    provider.baseURL ?? "",
    provider.api ?? null,
    provider.apiKeyEnv ?? null,
    provider.headers,
    apiKey,
  );
}`)
replaceOnce(discovery,
`export function useProviderModels(
  active: boolean,
  provider: ProviderConfig,
): ProviderModelsDiscovery {`,
`export function useProviderModels(
  active: boolean,
  provider: ProviderConfig,
  apiKey: string | null = null,
): ProviderModelsDiscovery {`)
replaceOnce(discovery,
`  const paramsRef = useRef(provider);
  paramsRef.current = provider;
`,
`  const paramsRef = useRef(provider);
  paramsRef.current = provider;
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
`)
replaceOnce(discovery, '      const models = await fetchRemote(current);\n', '      const models = await fetchRemote(current, apiKeyRef.current);\n')
replaceOnce(discovery,
`    void (async () => {
      try {
        const cached = await cmd.modelRemoteCacheGet(baseURL, api, apiKeyEnv, provider.headers);
        if (requestSeq.current !== requestId) return;
        if (cached?.models.length) {
          setState({ status: "loading", models: cached.models, source: "cache" });
        }
      } catch {
        // Cache is an optimization only; a damaged/unavailable cache never
        // blocks live discovery.
      }
`,
`    void (async () => {
      // A typed-but-unsaved key is a new credential boundary. Do not paint a cache
      // produced by another key; the secret itself is never persisted in the cache key.
      if (!apiKey) {
        try {
          const cached = await cmd.modelRemoteCacheGet(baseURL, api, apiKeyEnv, provider.headers);
          if (requestSeq.current !== requestId) return;
          if (cached?.models.length) {
            setState({ status: "loading", models: cached.models, source: "cache" });
          }
        } catch {
          // Cache is an optimization only; a damaged/unavailable cache never blocks live discovery.
        }
      }
`)
replaceOnce(discovery, '  }, [active, baseURL, api, apiKeyEnv, hKey]);\n', '  }, [active, baseURL, api, apiKeyEnv, hKey, apiKey]);\n')

// ---- parent save: config first, credential second; retry skips already-committed config ----
const view = 'src/features/models/ModelsView.tsx'
replaceOnce(view,
  'import { ProviderDialog, type ProviderDialogState } from "./ProviderDialog";\n',
  'import { ProviderDialog, type ProviderDialogState } from "./ProviderDialog";\nimport type { CredentialWrite } from "./credentials";\n',
)
replaceOnce(view,
`  const submitProvider = async (provider: ProviderConfig, originalRoute: string | null) => {
    const current = config ?? EMPTY_CONFIG;
    let status = envStatus;
    const envName = provider.apiKeyEnv?.trim();
    if (envName && status?.[envName] === undefined) {
      try {
        status = { ...(status ?? {}), ...(await cmd.modelEnvStatus([envName])) };
      } catch {
        status = status ?? {};
      }
    }
    const next = withValidDefaultReasoning(
      upsertProvider(
        current,
        provider,
        originalRoute,
        providerReadiness(provider, status).ready,
      ),
      catalog,
    );
    // ProviderDialog owns a persistent contextual error and retry path; avoid duplicating
    // the same save failure as a transient page-level toast.
    await persist(next, provider.route, false);
    setDialog(null);
    toast(t("Model configuration saved — changes take effect immediately"), "success");
  };
`,
`  const submitProvider = async (
    provider: ProviderConfig,
    originalRoute: string | null,
    credential: CredentialWrite | null,
  ) => {
    const current = config ?? EMPTY_CONFIG;
    // If settings committed but credential storage failed, the dialog stays open. On retry
    // the committed provider is already in state, so only the credential stage is repeated.
    const committed = current.providers.find((item) => item.route === provider.route);
    const configAlreadyCommitted = committed != null && JSON.stringify(committed) === JSON.stringify(provider);
    let next = current;
    if (!configAlreadyCommitted) {
      next = withValidDefaultReasoning(
        upsertProvider(
          current,
          provider,
          originalRoute,
          credential == null && providerReadiness(provider, envStatus).ready,
        ),
        catalog,
      );
      await persist(next, provider.route, false);
    }

    let status = envStatus ?? {};
    if (credential) {
      const stored = await cmd.modelCredentialSet(credential.ref, credential.value);
      status = { ...status, [credential.ref]: stored.configured };
      setEnvStatus(status);
    }

    // A newly stored credential can make the first provider Ready only after the
    // settings write. Materialize the default in a second settings write only then.
    if (!next.defaultProvider?.trim() && providerReadiness(provider, status).ready) {
      const withDefault = withValidDefaultReasoning(
        upsertProvider(next, provider, null, true),
        catalog,
      );
      if (JSON.stringify(withDefault) !== JSON.stringify(next)) {
        await persist(withDefault, provider.route, false);
        next = withDefault;
      }
    }

    setDialog(null);
    toast(t("Model configuration saved — changes take effect immediately"), "success");
  };
`)
replaceOnce(view,
  '              "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored as environment variable names, never as values.",\n',
  '              "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored in the DSH credential store, never in settings.yaml.",\n',
)
replaceOnce(view,
`        : readiness.kind === "missing-env"
          ? \`\${readiness.envName}: \${t("Not set")}\`
`,
`        : readiness.kind === "missing-env"
          ? t("API key is not configured")
`)
replaceOnce(view,
`    readiness.kind === "missing-env"
      ? t("Environment variable is not set in the environment where dsh-pro-max was launched")
`,
`    readiness.kind === "missing-env"
      ? t("API key is not configured")
`)

// ---- typed commands: credential status adapter + transient key parameter ----
const commands = 'src/shared/commands.ts'
replaceOnce(commands,
`// 旧 Models UI 仍暂时使用 launcher 进程环境状态；下一步 UI cutover 后删除。
export const modelEnvStatus = (names: string[]) =>
  invokeTyped<Record<string, boolean>>("model_env_status", { names });
`,
`// Compatibility adapter for existing readiness call sites: the booleans now come from
// DSH credential describe, not from the Launcher process environment.
export const modelEnvStatus = async (names: string[]) => {
  const described = await modelCredentialDescribe(names);
  return Object.fromEntries(names.map((name) => [name, described[name]?.configured === true]));
};
`)
replaceOnce(commands,
`export const modelTestConnection = (
  baseURL: string,
  api: string,
  apiKeyEnv: string | null,
  headers: Record<string, string | undefined> | null,
  model: string,
) =>
  invokeTyped<void>("model_test_connection", { baseUrl: baseURL, api, apiKeyEnv, headers, model });
`,
`export const modelTestConnection = (
  baseURL: string,
  api: string,
  apiKeyEnv: string | null,
  headers: Record<string, string | undefined> | null,
  model: string,
  apiKey: string | null = null,
) =>
  invokeTyped<void>("model_test_connection", { baseUrl: baseURL, api, apiKeyEnv, headers, model, apiKey });
`)
replaceOnce(commands,
`export const modelRemoteList = (
  baseURL: string,
  api: string | null,
  apiKeyEnv: string | null,
  headers: Record<string, string | undefined> | null = null,
) =>
  // Tauri 按 camelCase 形参名取参：base_url → baseUrl（baseURL 永不命中）
  invokeTyped<string[]>("model_remote_list_with_headers", { baseUrl: baseURL, api, apiKeyEnv, headers });
`,
`export const modelRemoteList = (
  baseURL: string,
  api: string | null,
  apiKeyEnv: string | null,
  headers: Record<string, string | undefined> | null = null,
  apiKey: string | null = null,
) =>
  // apiKey is transient write-only UI state; persisted requests resolve apiKeyEnv in Rust.
  invokeTyped<string[]>("model_remote_list_with_headers", { baseUrl: baseURL, api, apiKeyEnv, headers, apiKey });
`)

// ---- Rust-only credential resolver for provider probes; never exposed as IPC ----
write('src-tauri/src/model_credential_resolver.rs', `//! Internal secret resolution for Launcher-originated provider probes.
//! No function in this module is a Tauri command; secret values never cross IPC.

use serde_yaml::Value as Yaml;
use std::fs;
use std::path::{Path, PathBuf};

fn valid_ref(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else { return false };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn dsh_dir() -> Result<PathBuf, String> {
    Ok(crate::config::home_dir()?.join(".dsh"))
}

#[cfg(unix)]
fn assert_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let Ok(metadata) = fs::metadata(path) else { return Ok(()) };
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 == 0 { Ok(()) } else {
        Err("Credentials file is readable beyond its owner; run chmod 600 before continuing".to_string())
    }
}
#[cfg(not(unix))]
fn assert_owner_only(_path: &Path) -> Result<(), String> { Ok(()) }

fn file_value(path: &Path, name: &str) -> Result<Option<String>, String> {
    if !path.exists() { return Ok(None) }
    assert_owner_only(path)?;
    let text = fs::read_to_string(path).map_err(|_| "Failed to read the credentials file".to_string())?;
    if text.trim().is_empty() { return Ok(None) }
    let root: Yaml = serde_yaml::from_str(&text).map_err(|_| "Failed to parse the credentials file".to_string())?;
    let map = root.as_mapping().ok_or_else(|| "Credentials file must be a mapping".to_string())?;
    let version = map.get(Yaml::String("version".into()));
    if version.is_none() {
        return Ok(map.get(Yaml::String(name.into())).and_then(Yaml::as_str).filter(|v| !v.is_empty()).map(str::to_string));
    }
    if version.and_then(Yaml::as_i64) != Some(1) {
        return Err("Credentials file declares an unsupported version".to_string());
    }
    Ok(map
        .get(Yaml::String("refs".into()))
        .and_then(Yaml::as_mapping)
        .and_then(|refs| refs.get(Yaml::String(name.into())))
        .and_then(Yaml::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

fn dotenv_value(path: &Path, name: &str) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    for raw in text.lines() {
        let mut line = raw.trim();
        if line.is_empty() || line.starts_with('#') { continue }
        if let Some(rest) = line.strip_prefix("export ") { line = rest.trim_start() }
        let (key, raw_value) = line.split_once('=')?;
        let key_matches = if cfg!(windows) { key.trim().eq_ignore_ascii_case(name) } else { key.trim() == name };
        if !key_matches { continue }
        let value = raw_value.trim();
        let value = if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\\'') && value.ends_with('\\'')))
        { &value[1..value.len() - 1] } else { value };
        return (!value.is_empty()).then(|| value.to_string());
    }
    None
}

pub(crate) fn resolve(raw: &str) -> Result<Option<String>, String> {
    let name = raw.trim();
    if !valid_ref(name) { return Err("Credential reference must be a POSIX-style environment variable name".to_string()) }
    if let Ok(value) = std::env::var(name) {
        if !value.is_empty() { return Ok(Some(value)) }
    }
    let home = dsh_dir()?;
    if let Some(value) = file_value(&home.join(".credentials.yaml"), name)? { return Ok(Some(value)) }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(value) = dotenv_value(&cwd.join(".env"), name) { return Ok(Some(value)) }
    }
    if let Some(value) = dotenv_value(&home.join(".env"), name) { return Ok(Some(value)) }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_versioned_managed_refs_without_exposing_other_values() {
        let dir = std::env::temp_dir().join(format!("dsh-pro-max-resolver-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".credentials.yaml");
        fs::write(&file, "version: 1\\nrefs:\\n  CUTOVER_TEST_KEY: secret-value\\n").unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(file_value(&file, "CUTOVER_TEST_KEY").unwrap().as_deref(), Some("secret-value"));
        assert_eq!(file_value(&file, "OTHER_KEY").unwrap(), None);
        let _ = fs::remove_dir_all(dir);
    }
}
`)
replaceOnce('src-tauri/src/main.rs', 'mod model_credentials;\nmod model_remote;\n', 'mod model_credentials;\nmod model_credential_resolver;\nmod model_remote;\n')

const remote = 'src-tauri/src/model_remote.rs'
replaceCount(remote,
`fn required_env_value(name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        _ => {
            crate::logging::warn("模型服务缺密钥环境变量", name);
            Err(keyf(
                "Environment variable is not set in the environment where dsh-pro-max was launched",
                &[],
            ))
        }
    }
}

`, '', 1)
replaceOnce(remote,
`fn remote_models_url(base_url: &str, api: Option<&str>) -> Result<String, String> {`,
`fn request_api_key(api_key: Option<&str>, api_key_env: Option<&str>) -> Result<Option<String>, String> {
    if let Some(value) = non_empty(api_key) {
        if !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
            return Err(keyf("API key contains invalid characters", &[]));
        }
        return Ok(Some(value.to_string()));
    }
    let Some(reference) = non_empty(api_key_env) else { return Ok(None) };
    let value = crate::model_credential_resolver::resolve(reference)?;
    value.map(Some).ok_or_else(|| keyf("API key is not configured", &[]))
}

fn remote_models_url(base_url: &str, api: Option<&str>) -> Result<String, String> {`)
replaceOnce(remote,
`fn fetch_remote_models(
    base_url: &str,
    api: Option<&str>,
    api_key_env: Option<&str>,
    headers: Option<&BTreeMap<String, String>>,
) -> Result<Vec<String>, String> {
    // apiKeyEnv 未配置 = 明确允许匿名模型发现；一旦配置则环境变量必须存在且
    // 非空，不静默回退匿名访问，避免把凭据配置错误伪装成可用状态。
    let key = if let Some(env_name) = non_empty(api_key_env) {
        Some(required_env_value(env_name)?)
    } else {
        None
    };
`,
`fn fetch_remote_models(
    base_url: &str,
    api: Option<&str>,
    api_key_env: Option<&str>,
    api_key: Option<&str>,
    headers: Option<&BTreeMap<String, String>>,
) -> Result<Vec<String>, String> {
    // Transient write-only key wins for an unsaved draft; otherwise resolve the stored
    // reference using the same precedence as DSH credentials-local.
    let key = request_api_key(api_key, api_key_env)?;
`)
replaceOnce(remote,
`fn test_provider_connection(
    base_url: &str,
    api: &str,
    api_key_env: Option<&str>,
    headers: Option<&BTreeMap<String, String>>,
    model: &str,
) -> Result<(), String> {
    let key = if let Some(env_name) = non_empty(api_key_env) {
        Some(required_env_value(env_name)?)
    } else {
        None
    };
`,
`fn test_provider_connection(
    base_url: &str,
    api: &str,
    api_key_env: Option<&str>,
    api_key: Option<&str>,
    headers: Option<&BTreeMap<String, String>>,
    model: &str,
) -> Result<(), String> {
    let key = request_api_key(api_key, api_key_env)?;
`)
replaceOnce(remote,
`pub async fn model_test_connection(
    base_url: String,
    api: String,
    api_key_env: Option<String>,
    headers: Option<BTreeMap<String, String>>,
    model: String,
) -> Result<(), String> {`,
`pub async fn model_test_connection(
    base_url: String,
    api: String,
    api_key_env: Option<String>,
    headers: Option<BTreeMap<String, String>>,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {`)
replaceOnce(remote,
`            api_key_env.as_deref(),
            headers.as_ref(),
            &model,
`,
`            api_key_env.as_deref(),
            api_key.as_deref(),
            headers.as_ref(),
            &model,
`)
replaceOnce(remote,
`pub async fn model_remote_list_with_headers(
    base_url: String,
    api: Option<String>,
    api_key_env: Option<String>,
    headers: Option<BTreeMap<String, String>>,
) -> Result<Vec<String>, String> {`,
`pub async fn model_remote_list_with_headers(
    base_url: String,
    api: Option<String>,
    api_key_env: Option<String>,
    headers: Option<BTreeMap<String, String>>,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {`)
replaceOnce(remote,
`            api_key_env.as_deref(),
            headers.as_ref(),
        )?;`,
`            api_key_env.as_deref(),
            api_key.as_deref(),
            headers.as_ref(),
        )?;`)
replaceOnce(remote,
`    fn provider_cache_key_tracks_connection_fingerprint_without_secret_values() {`,
`    fn transient_api_key_is_validated_without_becoming_cache_identity() {
        assert_eq!(request_api_key(Some("sk-test_123"), None).unwrap().as_deref(), Some("sk-test_123"));
        assert!(request_api_key(Some("bad key"), None).is_err());
        assert_eq!(request_api_key(None, None).unwrap(), None);
    }

    #[test]
    fn provider_cache_key_tracks_connection_fingerprint_without_secret_values() {`)

// ---- i18n ----
replaceOnce('src/shared/i18n/en.ts',
  '  "API Key Env Var": "API Key Env Var",\n',
  '  "API Key Env Var": "API Key Env Var",\n  "API Key": "API Key",\n  "Enter API key": "Enter API key",\n  "API key cannot be blank": "API key cannot be blank",\n  "API key contains invalid characters": "API key contains invalid characters",\n  "API key is not configured": "API key is not configured",\n',
)
replaceOnce('src/shared/i18n/en.ts',
  '  "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored as environment variable names, never as values.": "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored as environment variable names, never as values.",\n',
  '  "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored as environment variable names, never as values.": "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored as environment variable names, never as values.",\n  "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored in the DSH credential store, never in settings.yaml.": "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored in the DSH credential store, never in settings.yaml.",\n',
)
replaceOnce('src/shared/i18n/zh-CN.ts',
  '  "API Key Env Var": "API Key 环境变量名",\n',
  '  "API Key Env Var": "API Key 环境变量名",\n  "API Key": "API 密钥",\n  "Enter API key": "输入 API 密钥",\n  "API key cannot be blank": "API 密钥不能为空",\n  "API key contains invalid characters": "API 密钥格式无效，请仅粘贴密钥值",\n  "API key is not configured": "尚未配置 API 密钥",\n',
)
replaceOnce('src/shared/i18n/zh-CN.ts',
  '  "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored as environment variable names, never as values.": "编辑 ~/.dsh/settings.yaml 的模型配置。API Key 仅保存环境变量名，不保存明文值。",\n',
  '  "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored as environment variable names, never as values.": "编辑 ~/.dsh/settings.yaml 的模型配置。API Key 仅保存环境变量名，不保存明文值。",\n  "Edit the model settings of ~/.dsh/settings.yaml. API keys are stored in the DSH credential store, never in settings.yaml.": "编辑 ~/.dsh/settings.yaml 的模型配置。API 密钥保存在 DSH 凭据存储中，不会写入 settings.yaml。",\n',
)

// ---- tests aligned with write-only field ----
for (const path of [
  'src/features/models/ProviderDialog.add.test.tsx',
  'src/features/models/ProviderDialog.edit.test.tsx',
  'src/features/models/ProviderDialog.base-url-validation.test.tsx',
  'src/features/models/ProviderDialog.close.test.tsx',
  'src/features/models/ProviderDialog.connection.test.tsx',
  'src/features/models/ProviderDialog.custom.test.tsx',
  'src/features/models/ProviderDialog.test-connection-retry.test.tsx',
]) {
  let text = read(path)
  text = text.replaceAll('API Key Env Var', 'API Key')
  text = text.replace(/getByRole\("textbox", \{ name: "API Key" \}\)/g, 'getByLabelText("API Key")')
  write(path, text)
}
replaceOnce('src/features/models/ProviderDialog.add.test.tsx',
  '    await user.type(apiKey, "DEEPSEEK_API_KEY");\n',
  '    await user.type(apiKey, "sk-deepseek-test");\n',
)
replaceOnce('src/features/models/ProviderDialog.add.test.tsx',
`    const [provider, originalRoute] = onSubmit.mock.calls[0];
    expect(originalRoute).toBeNull();
    expect(provider.route).toBe("deepseek");
    expect(provider.displayName).toBe("DeepSeek");
    expect(provider.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(provider.models.map((model) => model.id)).toEqual(["deepseek-v4-pro"]);
`,
`    const [provider, originalRoute, credential] = onSubmit.mock.calls[0];
    expect(originalRoute).toBeNull();
    expect(provider.route).toBe("deepseek");
    expect(provider.displayName).toBe("DeepSeek");
    expect(provider.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(provider.models.map((model) => model.id)).toEqual(["deepseek-v4-pro"]);
    expect(credential).toEqual({ ref: "DEEPSEEK_API_KEY", value: "sk-deepseek-test" });
`)
replaceOnce('src/features/models/ProviderDialog.edit.test.tsx',
  '    await user.clear(apiKey);\n    await user.type(apiKey, "DEEPSEEK_PROD_API_KEY");\n',
  '    expect(apiKey).toHaveValue("");\n    await user.type(apiKey, "sk-deepseek-prod");\n',
)
replaceOnce('src/features/models/ProviderDialog.edit.test.tsx',
`    const [saved, originalRoute] = onSubmit.mock.calls[0];
    expect(originalRoute).toBe("deepseek");
    expect(saved.route).toBe("deepseek");
    expect(saved.displayName).toBe("DeepSeek");
    expect(saved.apiKeyEnv).toBe("DEEPSEEK_PROD_API_KEY");
`,
`    const [saved, originalRoute, credential] = onSubmit.mock.calls[0];
    expect(originalRoute).toBe("deepseek");
    expect(saved.route).toBe("deepseek");
    expect(saved.displayName).toBe("DeepSeek");
    expect(saved.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(credential).toEqual({ ref: "DEEPSEEK_API_KEY", value: "sk-deepseek-prod" });
`)
replaceOnce('src/features/models/ProviderDialog.connection.test.tsx',
`      { "X-Tenant": "desktop" },
      "my-model",
    );`,
`      { "X-Tenant": "desktop" },
      "my-model",
      null,
    );`)
replaceOnce('src/features/models/ProviderDialog.test-connection-retry.test.tsx',
  '    await user.clear(apiKey);\n    await user.type(apiKey, "DEEPSEEK_PROD_API_KEY");\n',
  '    await user.type(apiKey, "sk-deepseek-prod");\n',
)
replaceOnce('src/features/models/ProviderDialog.test-connection-retry.test.tsx',
`      null,
      "deepseek-chat",
    ]);
    expect(test.mock.calls[1]).toEqual([
      "https://api.deepseek.com/v1",
      "openai-completions",
      "DEEPSEEK_PROD_API_KEY",
      null,
      "deepseek-chat",
    ]);`,
`      null,
      "deepseek-chat",
      null,
    ]);
    expect(test.mock.calls[1]).toEqual([
      "https://api.deepseek.com/v1",
      "openai-completions",
      "DEEPSEEK_API_KEY",
      null,
      "deepseek-chat",
      "sk-deepseek-prod",
    ]);`)
replaceOnce('src/features/models/ProviderDialog.test-connection-retry.test.tsx',
  '    await user.clear(apiKey);\n    await user.type(apiKey, "DEEPSEEK_ROTATED_KEY");\n',
  '    await user.type(apiKey, "sk-deepseek-rotated");\n',
)
replaceOnce('src/features/models/ProviderDialog.test-connection-retry.test.tsx',
  '    expect(test.mock.calls[1]?.[2]).toBe("DEEPSEEK_ROTATED_KEY");\n',
  '    expect(test.mock.calls[1]?.[2]).toBe("DEEPSEEK_API_KEY");\n    expect(test.mock.calls[1]?.[5]).toBe("sk-deepseek-rotated");\n',
)

// New discovery behavior: transient key skips cache and is passed only to live request.
let hookTest = read('src/features/models/useProviderModels.test.tsx')
hookTest = hookTest.replace(/\n\}\);\s*$/, `

  it("uses an unsaved API key only for the live probe and skips persistent cache", async () => {
    const cache = vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue({ models: ["old-model"], fetchedAt: 1 });
    const remote = vi.spyOn(cmd, "modelRemoteList").mockResolvedValue(["new-model"]);
    const { result } = renderHook(() => useProviderModels(true, provider, "sk-unsaved"));
    await flush();
    expect(cache).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_DEBOUNCE_MS); });
    await flush();
    expect(result.current.models).toEqual(["new-model"]);
    expect(remote.mock.calls[0]?.[4]).toBe("sk-unsaved");
  });
});
`)
write('src/features/models/useProviderModels.test.tsx', hookTest)

// Remove the temporary mutator from the product diff.
rmSync('scripts/tmp-model-credential-cutover.mjs')
rmSync('.github/workflows/tmp-model-credential-cutover.yml')
