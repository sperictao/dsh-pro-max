#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function edit(path, transforms) {
  const file = resolve(root, path);
  let source = readFileSync(file, "utf8");
  let changed = false;
  for (const { before, after, label } of transforms) {
    if (source.includes(after)) continue;
    const first = source.indexOf(before);
    if (first < 0) throw new Error(`${path}: target not found: ${label}`);
    if (source.indexOf(before, first + before.length) >= 0) {
      throw new Error(`${path}: target not unique: ${label}`);
    }
    source = source.replace(before, after);
    changed = true;
  }
  if (changed) writeFileSync(file, source);
}

function create(path, content) {
  const file = resolve(root, path);
  if (!existsSync(file)) writeFileSync(file, content);
}

edit("src-tauri/src/model_remote.rs", [
  {
    label: "generic credential log",
    before: 'crate::logging::warn("模型列表拉取缺密钥环境变量", name);',
    after: 'crate::logging::warn("模型服务缺密钥环境变量", name);',
  },
  {
    label: "connection test implementation",
    before: `/// 批量检查密钥环境变量是否在 launcher 当前进程环境中存在且非空。\n/// 返回值仅包含调用方传入的变量名与布尔状态，不读取/返回 secret 内容。`,
    after: `/// 按 wire 协议拼真实推理端点。连接测试刻意不依赖 /models：一些兼容服务\n/// 可以正常推理但没有模型列表接口。\nfn provider_inference_url(base_url: &str, api: &str) -> Result<String, String> {\n    let base = base_url.trim().trim_end_matches('/');\n    if base.is_empty() {\n        return Err(keyf(\"Provider base URL is required to test the connection\", &[]));\n    }\n    match api {\n        \"openai-completions\" => Ok(format!(\"{base}/chat/completions\")),\n        \"openai-responses\" => Ok(format!(\"{base}/responses\")),\n        \"anthropic-messages\" => {\n            if base.ends_with(\"/v1\") {\n                Ok(format!(\"{base}/messages\"))\n            } else {\n                Ok(format!(\"{base}/v1/messages\"))\n            }\n        }\n        _ => Err(keyf(\"Provider wire protocol is required to test the connection\", &[])),\n    }\n}\n\n/// 最小真实请求：只要求模型返回最多 16 个 token，既验证模型路由/认证，又避免\n/// 把 Test Connection 变成一次正常对话。\nfn provider_test_body(api: &str, model: &str) -> Result<serde_json::Value, String> {\n    let model = model.trim();\n    if model.is_empty() {\n        return Err(keyf(\"Provider model is required to test the connection\", &[]));\n    }\n    match api {\n        \"openai-completions\" => Ok(serde_json::json!({\n            \"model\": model,\n            \"messages\": [{ \"role\": \"user\", \"content\": \"Reply OK.\" }],\n            \"max_tokens\": 16\n        })),\n        \"openai-responses\" => Ok(serde_json::json!({\n            \"model\": model,\n            \"input\": \"Reply OK.\",\n            \"max_output_tokens\": 16\n        })),\n        \"anthropic-messages\" => Ok(serde_json::json!({\n            \"model\": model,\n            \"max_tokens\": 16,\n            \"messages\": [{ \"role\": \"user\", \"content\": \"Reply OK.\" }]\n        })),\n        _ => Err(keyf(\"Provider wire protocol is required to test the connection\", &[])),\n    }\n}\n\nfn test_provider_connection(\n    base_url: &str,\n    api: &str,\n    api_key_env: Option<&str>,\n    headers: Option<&BTreeMap<String, String>>,\n    model: &str,\n) -> Result<(), String> {\n    let key = if let Some(env_name) = non_empty(api_key_env) {\n        Some(required_env_value(env_name)?)\n    } else {\n        None\n    };\n    let url = provider_inference_url(base_url, api)?;\n    let body = provider_test_body(api, model)?;\n    let client = reqwest::blocking::Client::builder()\n        .timeout(std::time::Duration::from_secs(REMOTE_LIST_TIMEOUT_SECS))\n        .user_agent(concat!(\"dsh-pro-max/\", env!(\"CARGO_PKG_VERSION\")))\n        .build()\n        .map_err(|e| {\n            crate::logging::error(\"HTTP client 初始化失败\", &e.to_string());\n            keyf(\"Cannot initialize the HTTP client\", &[])\n        })?;\n\n    let mut request = client.post(&url);\n    if api == \"anthropic-messages\" {\n        request = request.header(\"anthropic-version\", \"2023-06-01\");\n        if let Some(key) = key.as_deref() {\n            request = request.header(\"x-api-key\", key);\n        }\n    } else if let Some(key) = key.as_deref() {\n        request = request.bearer_auth(key);\n    }\n    request = apply_provider_headers(request, headers).json(&body);\n\n    let response = request.send().map_err(|e| {\n        crate::logging::error(\"模型服务连接测试失败\", &format!(\"{url}: {e}\"));\n        keyf(\"Failed to reach the provider inference endpoint\", &[])\n    })?;\n    if response.status().is_success() {\n        return Ok(());\n    }\n\n    let status = response.status().as_u16();\n    crate::logging::warn(\"模型服务连接测试返回错误\", &format!(\"HTTP {status}: {url}\"));\n    Err(keyf(\n        match status {\n            401 | 403 => \"Provider authentication failed\",\n            404 | 405 => \"Provider endpoint or wire protocol is invalid\",\n            429 => \"Provider connection test was rate limited\",\n            _ => \"Provider connection test failed\",\n        },\n        &[],\n    ))\n}\n\n/// 批量检查密钥环境变量是否在 launcher 当前进程环境中存在且非空。\n/// 返回值仅包含调用方传入的变量名与布尔状态，不读取/返回 secret 内容。`,
  },
  {
    label: "connection command",
    before: `#[tauri::command]\npub async fn model_remote_list_with_headers(`,
    after: `#[tauri::command]\npub async fn model_test_connection(\n    base_url: String,\n    api: String,\n    api_key_env: Option<String>,\n    headers: Option<BTreeMap<String, String>>,\n    model: String,\n) -> Result<(), String> {\n    crate::dsh::ipc_blocking(move || {\n        test_provider_connection(\n            &base_url,\n            &api,\n            api_key_env.as_deref(),\n            headers.as_ref(),\n            &model,\n        )\n    })\n    .await\n}\n\n#[tauri::command]\npub async fn model_remote_list_with_headers(`,
  },
  {
    label: "rust tests",
    before: `    #[test]\n    fn env_status_trims_dedupes_and_does_not_expose_values() {`,
    after: `    #[test]\n    fn connection_test_urls_target_inference_not_models() {\n        assert_eq!(\n            provider_inference_url(\"https://api.example.com/v1/\", \"openai-completions\").unwrap(),\n            \"https://api.example.com/v1/chat/completions\"\n        );\n        assert_eq!(\n            provider_inference_url(\"https://api.example.com/v1\", \"openai-responses\").unwrap(),\n            \"https://api.example.com/v1/responses\"\n        );\n        assert_eq!(\n            provider_inference_url(\"https://api.anthropic.com\", \"anthropic-messages\").unwrap(),\n            \"https://api.anthropic.com/v1/messages\"\n        );\n        assert_eq!(\n            provider_inference_url(\"https://api.anthropic.com/v1\", \"anthropic-messages\").unwrap(),\n            \"https://api.anthropic.com/v1/messages\"\n        );\n    }\n\n    #[test]\n    fn connection_test_bodies_cap_output_at_sixteen_tokens() {\n        let chat = provider_test_body(\"openai-completions\", \"m\").unwrap();\n        assert_eq!(chat[\"model\"], \"m\");\n        assert_eq!(chat[\"max_tokens\"], 16);\n\n        let responses = provider_test_body(\"openai-responses\", \"m\").unwrap();\n        assert_eq!(responses[\"max_output_tokens\"], 16);\n\n        let anthropic = provider_test_body(\"anthropic-messages\", \"m\").unwrap();\n        assert_eq!(anthropic[\"max_tokens\"], 16);\n    }\n\n    #[test]\n    fn env_status_trims_dedupes_and_does_not_expose_values() {`,
  },
]);

edit("src-tauri/src/main.rs", [
  {
    label: "register connection command",
    before: `            model_remote::model_env_status,\n            model_remote::model_remote_list_with_headers,`,
    after: `            model_remote::model_env_status,\n            model_remote::model_test_connection,\n            model_remote::model_remote_list_with_headers,`,
  },
]);

edit("src/shared/commands.ts", [
  {
    label: "frontend connection command",
    before: `// 上游模型列表（兼连通性验证）；密钥经环境变量名解析，普通 Provider headers 一并发送，\n// 凭据类保留头由 Rust 层再次过滤，不能覆盖 apiKeyEnv 认证。\nexport const modelRemoteList = (`,
    after: `// 独立连接测试：向真实推理端点发送最多 16 个输出 token 的最小请求；不依赖 /models。\nexport const modelTestConnection = (\n  baseURL: string,\n  api: string,\n  apiKeyEnv: string | null,\n  headers: Record<string, string | undefined> | null,\n  model: string,\n) =>\n  invokeTyped<void>(\"model_test_connection\", { baseUrl: baseURL, api, apiKeyEnv, headers, model });\n// 上游模型列表仅负责模型发现；密钥经环境变量名解析，普通 Provider headers 一并发送，\n// 凭据类保留头由 Rust 层再次过滤，不能覆盖 apiKeyEnv 认证。\nexport const modelRemoteList = (`,
  },
]);

edit("src/features/models/shared.ts", [
  {
    label: "provider connection target",
    before: `export function firstProviderModelId(provider: ProviderConfig): string | null {\n  return providerModelChoices(provider)[0]?.id ?? null;\n}\n\nexport const emptyProvider`,
    after: `export function firstProviderModelId(provider: ProviderConfig): string | null {\n  return providerModelChoices(provider)[0]?.id ?? null;\n}\n\nexport type ProviderConnectionTarget = {\n  baseURL: string;\n  api: string;\n  model: string;\n};\n\n/**\n * 连接测试所需的有效路由：显式连接字段优先，内置 route 缺字段时继承同版本预设。\n * 只做运行时投影，不把继承值写回 settings.yaml。\n */\nexport function providerConnectionTarget(provider: ProviderConfig): ProviderConnectionTarget | null {\n  const preset = PRESET_BY_ROUTE.get(provider.route.trim());\n  const rawBaseURL = provider.baseURL?.trim() || preset?.baseUrl?.trim() || \"\";\n  const baseURL = rawBaseURL ? normalizeBaseUrl(rawBaseURL) : \"\";\n  const api = provider.api?.trim() || preset?.api?.trim() || \"\";\n  const model = firstProviderModelId(provider);\n  if (!baseURL || !api || !model) return null;\n  return { baseURL, api, model };\n}\n\nexport const emptyProvider`,
  },
]);

edit("src/features/models/inheritedModels.test.ts", [
  {
    label: "connection target import",
    before: `import { firstProviderModelId, MODEL_PRESETS, providerModelChoices } from \"./shared\";`,
    after: `import {\n  firstProviderModelId,\n  MODEL_PRESETS,\n  providerConnectionTarget,\n  providerModelChoices,\n} from \"./shared\";`,
  },
  {
    label: "connection target tests",
    before: `  it(\"does not invent inherited models for an unknown custom route\", () => {\n    expect(providerModelChoices(provider({ route: \"my-local-gateway\" }))).toEqual([]);\n    expect(firstProviderModelId(provider({ route: \"my-local-gateway\" }))).toBeNull();\n  });\n});`,
    after: `  it(\"does not invent inherited models for an unknown custom route\", () => {\n    expect(providerModelChoices(provider({ route: \"my-local-gateway\" }))).toEqual([]);\n    expect(firstProviderModelId(provider({ route: \"my-local-gateway\" }))).toBeNull();\n  });\n\n  it(\"resolves inherited endpoint, protocol and model without materializing them\", () => {\n    const preset = MODEL_PRESETS.find((item) => item.id === \"openai\")!;\n    const inherited = provider({ baseURL: null, api: null });\n    expect(providerConnectionTarget(inherited)).toEqual({\n      baseURL: preset.baseUrl,\n      api: preset.api,\n      model: preset.modelIds[0],\n    });\n    expect(inherited.models).toEqual([]);\n    expect(inherited.baseURL).toBeNull();\n    expect(inherited.api).toBeNull();\n  });\n\n  it(\"requires a model for custom connection tests\", () => {\n    expect(\n      providerConnectionTarget(\n        provider({ route: \"my-local-gateway\", baseURL: \"http://127.0.0.1:1234/v1\" }),\n      ),\n    ).toBeNull();\n  });\n});`,
  },
]);

edit("src/features/models/ModelsView.tsx", [
  {
    label: "view shared import",
    before: `  firstProviderModelId,\n  fmtTokens,\n  providerModelChoices,`,
    after: `  firstProviderModelId,\n  fmtTokens,\n  providerConnectionTarget,\n  providerModelChoices,`,
  },
  {
    label: "testing route state",
    before: `  const [busyRoute, setBusyRoute] = useState<string | null>(null);\n  const [busyGlobal, setBusyGlobal] = useState(false);`,
    after: `  const [busyRoute, setBusyRoute] = useState<string | null>(null);\n  const [testingRoute, setTestingRoute] = useState<string | null>(null);\n  const [busyGlobal, setBusyGlobal] = useState(false);`,
  },
  {
    label: "row connection tester",
    before: `  /** 服务行快捷探测：仅 Ready Provider 可请求；自定义无 apiKeyEnv 仍可匿名探测。 */\n  const probeProvider = async (provider: ProviderConfig) => {`,
    after: `  /** 连接测试与模型发现分离：真实推理请求验证 endpoint/auth/model，绝不调用 /models。 */\n  const testProvider = async (provider: ProviderConfig) => {\n    const target = providerConnectionTarget(provider);\n    if (!target || !readyRoutes.has(provider.route)) return;\n    setTestingRoute(provider.route);\n    try {\n      await cmd.modelTestConnection(\n        target.baseURL,\n        target.api,\n        provider.apiKeyEnv,\n        provider.headers,\n        target.model,\n      );\n      toast(t(\"Connection successful\"), \"success\");\n    } catch (error) {\n      toast(tErr(String(error)), \"error\");\n    } finally {\n      setTestingRoute(null);\n    }\n  };\n\n  /** 服务行模型发现：仅 Ready Provider 可请求；自定义无 apiKeyEnv 仍可匿名探测。 */\n  const probeProvider = async (provider: ProviderConfig) => {`,
  },
  {
    label: "row test state",
    before: `                const armed = armedDelete === provider.route;\n                const rowBusy = busyRoute === provider.route;\n                const firstModel = firstProviderModelId(provider);`,
    after: `                const armed = armedDelete === provider.route;\n                const testing = testingRoute === provider.route;\n                const rowBusy = busyRoute === provider.route || testing;\n                const firstModel = firstProviderModelId(provider);`,
  },
  {
    label: "row test capability",
    before: `                const canProbe = Boolean(provider.baseURL?.trim()) && readiness.ready;\n                return (`,
    after: `                const canTest = Boolean(providerConnectionTarget(provider)) && readiness.ready;\n                const canProbe = Boolean(provider.baseURL?.trim()) && readiness.ready;\n                return (`,
  },
  {
    label: "row test button",
    before: `                      {canProbe && (\n                        <button`,
    after: `                      {canTest && (\n                        <button\n                          className={BTN_SM}\n                          disabled={rowBusy || busyGlobal}\n                          onClick={() => void testProvider(provider)}\n                          title={t(\"Sends a minimal model request to verify the endpoint and credentials.\")}\n                        >\n                          {testing ? t(\"Testing…\") : t(\"Test connection\")}\n                        </button>\n                      )}\n                      {canProbe && (\n                        <button`,
  },
]);

edit("src/features/models/ProviderDialog.tsx", [
  {
    label: "dialog commands import",
    before: `import { useTranslation } from \"react-i18next\";\nimport { BTN, BTN_PRIMARY, BTN_SM, INPUT, INPUT_MONO, SELECT } from \"@/shared/lib/ui\";`,
    after: `import { useTranslation } from \"react-i18next\";\nimport * as cmd from \"@/shared/commands\";\nimport { BTN, BTN_PRIMARY, BTN_SM, INPUT, INPUT_MONO, SELECT } from \"@/shared/lib/ui\";`,
  },
  {
    label: "dialog target import",
    before: `  normalizeBaseUrl,\n  validateBaseUrl,`,
    after: `  normalizeBaseUrl,\n  providerConnectionTarget,\n  validateBaseUrl,`,
  },
  {
    label: "dialog test states",
    before: `  const [fetchError, setFetchError] = useState<string | null>(null);\n  const [saving, setSaving] = useState(false);`,
    after: `  const [fetchError, setFetchError] = useState<string | null>(null);\n  const [testing, setTesting] = useState(false);\n  const [testResult, setTestResult] = useState<{ kind: \"success\" | \"error\"; text: string } | null>(null);\n  const [saving, setSaving] = useState(false);`,
  },
  {
    label: "clear test on connection edit",
    before: `    patch(value);\n    revokeRemote();\n    setSubmitError(null);`,
    after: `    patch(value);\n    revokeRemote();\n    setTestResult(null);\n    setSubmitError(null);`,
  },
  {
    label: "dialog target and can test",
    before: `  const currentUrlIssue = validateBaseUrl(draft.baseURL ?? \"\");\n\n  const onBaseURLBlur`,
    after: `  const currentUrlIssue = validateBaseUrl(draft.baseURL ?? \"\");\n  const testTarget = providerConnectionTarget(draft);\n  const canTest = showComposer && !currentUrlIssue && Boolean(testTarget) && !saving && !fetching && !testing;\n\n  const onBaseURLBlur`,
  },
  {
    label: "dialog test function",
    before: `  const fetchModels = async () => {`,
    after: `  const testConnection = async () => {\n    const target = providerConnectionTarget(draft);\n    if (!target || currentUrlIssue) return;\n    setTesting(true);\n    setTestResult(null);\n    try {\n      await cmd.modelTestConnection(\n        target.baseURL,\n        target.api,\n        draft.apiKeyEnv,\n        draft.headers,\n        target.model,\n      );\n      setTestResult({ kind: \"success\", text: t(\"Connection successful\") });\n    } catch (error) {\n      setTestResult({ kind: \"error\", text: tErr(String(error)) });\n    } finally {\n      setTesting(false);\n    }\n  };\n\n  const fetchModels = async () => {`,
  },
  {
    label: "clear test on preset",
    before: `    setSubmitError(null);\n    revokeRemote();\n\n    if (!preset)`,
    after: `    setSubmitError(null);\n    setTestResult(null);\n    revokeRemote();\n\n    if (!preset)`,
  },
  {
    label: "clear test on model edit",
    before: `  const setModels = (models: ModelEntry[]) => patch({ models });`,
    after: `  const setModels = (models: ModelEntry[]) => {\n    patch({ models });\n    setTestResult(null);\n  };`,
  },
  {
    label: "dialog header test button",
    before: `            {showComposer && (\n              <button\n                type=\"button\"\n                className={BTN_SM}\n                aria-expanded={advancedOpen}`,
    after: `            {showComposer && (\n              <button\n                type=\"button\"\n                className={BTN_SM}\n                disabled={!canTest}\n                onClick={() => void testConnection()}\n                title={t(\"Sends a minimal model request to verify the endpoint and credentials.\")}\n              >\n                {testing ? t(\"Testing…\") : t(\"Test connection\")}\n              </button>\n            )}\n            {showComposer && (\n              <button\n                type=\"button\"\n                className={BTN_SM}\n                aria-expanded={advancedOpen}`,
  },
  {
    label: "dialog test result",
    before: `          {submitError && (\n            <div className=\"rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive\" role=\"alert\">\n              {submitError}\n            </div>\n          )}\n\n          {/* 添加路径第一步`,
    after: `          {submitError && (\n            <div className=\"rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive\" role=\"alert\">\n              {submitError}\n            </div>\n          )}\n          {testResult && (\n            <div\n              className={\`rounded-md border px-3 py-2 text-xs \${\n                testResult.kind === \"success\"\n                  ? \"border-primary/30 bg-primary/5 text-primary\"\n                  : \"border-destructive/40 bg-destructive/5 text-destructive\"\n              }\`}\n              role={testResult.kind === \"error\" ? \"alert\" : \"status\"}\n            >\n              {testResult.text}\n            </div>\n          )}\n\n          {/* 添加路径第一步`,
  },
]);

for (const [path, zh] of [
  ["src/shared/i18n/en.ts", false],
  ["src/shared/i18n/zh-CN.ts", true],
]) {
  const entries = zh
    ? `  \"Connection successful\": \"连接成功\",\n  \"Test connection\": \"测试连接\",\n  \"Testing…\": \"测试中…\",\n  \"Sends a minimal model request to verify the endpoint and credentials.\": \"发送一个最小模型请求，用于验证端点和凭据。\",\n  \"Provider base URL is required to test the connection\": \"测试连接需要服务商接口地址\",\n  \"Provider wire protocol is required to test the connection\": \"测试连接需要 wire 协议\",\n  \"Provider model is required to test the connection\": \"测试连接需要模型\",\n  \"Failed to reach the provider inference endpoint\": \"无法访问服务商推理端点\",\n  \"Provider authentication failed\": \"服务商认证失败\",\n  \"Provider endpoint or wire protocol is invalid\": \"服务商端点或 wire 协议无效\",\n  \"Provider connection test was rate limited\": \"服务商连接测试触发限流\",\n  \"Provider connection test failed\": \"服务商连接测试失败\",\n`
    : `  \"Connection successful\": \"Connection successful\",\n  \"Test connection\": \"Test connection\",\n  \"Testing…\": \"Testing…\",\n  \"Sends a minimal model request to verify the endpoint and credentials.\": \"Sends a minimal model request to verify the endpoint and credentials.\",\n  \"Provider base URL is required to test the connection\": \"Provider base URL is required to test the connection\",\n  \"Provider wire protocol is required to test the connection\": \"Provider wire protocol is required to test the connection\",\n  \"Provider model is required to test the connection\": \"Provider model is required to test the connection\",\n  \"Failed to reach the provider inference endpoint\": \"Failed to reach the provider inference endpoint\",\n  \"Provider authentication failed\": \"Provider authentication failed\",\n  \"Provider endpoint or wire protocol is invalid\": \"Provider endpoint or wire protocol is invalid\",\n  \"Provider connection test was rate limited\": \"Provider connection test was rate limited\",\n  \"Provider connection test failed\": \"Provider connection test failed\",\n`;
  edit(path, [
    {
      label: "connection i18n",
      before: `  \"Environment variable is not set in the environment where dsh-pro-max was launched\":`,
      after: entries + `  \"Environment variable is not set in the environment where dsh-pro-max was launched\":`,
    },
  ]);
}

create("src/features/models/ModelsView.connection.test.tsx", `import { render, screen, waitFor } from \"@testing-library/react\";\nimport userEvent from \"@testing-library/user-event\";\nimport { createElement } from \"react\";\nimport { beforeEach, describe, expect, it, vi } from \"vitest\";\nimport * as cmd from \"@/shared/commands\";\nimport { useAppStore } from \"@/shared/store\";\nimport type { ModelCatalogFile, ModelConfig, ProviderConfig } from \"@/shared/types\";\nimport { MODEL_PRESETS } from \"./shared\";\nimport { ModelsView } from \"./ModelsView\";\n\nconst preset = MODEL_PRESETS.find((item) => item.id === \"openai\")!;\nconst provider: ProviderConfig = {\n  route: \"openai\",\n  displayName: \"OpenAI\",\n  baseURL: null,\n  api: null,\n  apiKeyEnv: \"OPENAI_API_KEY\",\n  models: [],\n  headers: { \"X-Title\": \"dsh-pro-max\" },\n  timeoutMs: null,\n  reasoning: null,\n  extra: null,\n};\nconst config: ModelConfig = {\n  defaultProvider: \"openai\",\n  defaultModel: preset.modelIds[0]!,\n  defaultReasoningEffort: null,\n  providers: [provider],\n};\nconst catalog: ModelCatalogFile = { fetchedAt: Math.floor(Date.now() / 1000), entries: [] };\n\nbeforeEach(() => {\n  vi.restoreAllMocks();\n  vi.clearAllMocks();\n  useAppStore.setState({ toasts: [], modelConfigBusy: false });\n  vi.spyOn(cmd, \"modelConfigLoad\").mockResolvedValue(structuredClone(config));\n  vi.spyOn(cmd, \"modelCatalogLoad\").mockResolvedValue(catalog);\n  vi.spyOn(cmd, \"modelCatalogRefresh\").mockResolvedValue(catalog);\n  vi.spyOn(cmd, \"modelEnvStatus\").mockResolvedValue({ OPENAI_API_KEY: true });\n  vi.spyOn(cmd, \"modelTestConnection\").mockResolvedValue(undefined);\n  vi.spyOn(cmd, \"modelRemoteList\").mockResolvedValue([]);\n});\n\ndescribe(\"ModelsView provider connection test\", () => {\n  it(\"tests the inherited inference target without calling model discovery\", async () => {\n    const user = userEvent.setup();\n    render(createElement(ModelsView));\n\n    await user.click(await screen.findByRole(\"button\", { name: \"Test connection\" }));\n\n    await waitFor(() => expect(cmd.modelTestConnection).toHaveBeenCalledOnce());\n    expect(cmd.modelTestConnection).toHaveBeenCalledWith(\n      preset.baseUrl,\n      preset.api,\n      \"OPENAI_API_KEY\",\n      { \"X-Title\": \"dsh-pro-max\" },\n      preset.modelIds[0],\n    );\n    expect(cmd.modelRemoteList).not.toHaveBeenCalled();\n    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(\"Connection successful\");\n  });\n});\n`);

create("src/features/models/ProviderDialog.connection.test.tsx", `import { render, screen, waitFor } from \"@testing-library/react\";\nimport userEvent from \"@testing-library/user-event\";\nimport { beforeEach, describe, expect, it, vi } from \"vitest\";\nimport * as cmd from \"@/shared/commands\";\nimport type { ProviderConfig } from \"@/shared/types\";\nimport { ProviderDialog } from \"./ProviderDialog\";\n\nconst provider: ProviderConfig = {\n  route: \"my-gateway\",\n  displayName: \"My Gateway\",\n  baseURL: \"https://gateway.example.com/v1\",\n  api: \"openai-completions\",\n  apiKeyEnv: \"MY_GATEWAY_KEY\",\n  models: [\n    {\n      id: \"my-model\",\n      name: null,\n      contextWindow: null,\n      maxTokens: null,\n      input: null,\n      reasoningEfforts: null,\n      extra: null,\n    },\n  ],\n  headers: { \"X-Tenant\": \"desktop\" },\n  timeoutMs: null,\n  reasoning: null,\n  extra: null,\n};\n\nbeforeEach(() => {\n  vi.restoreAllMocks();\n  vi.clearAllMocks();\n  vi.spyOn(cmd, \"modelTestConnection\").mockResolvedValue(undefined);\n});\n\ndescribe(\"ProviderDialog connection test\", () => {\n  it(\"tests the draft inference configuration and renders the result inline\", async () => {\n    const user = userEvent.setup();\n    render(\n      <ProviderDialog\n        state={{ mode: \"edit\", index: 0, provider }}\n        catalog={[]}\n        onClose={vi.fn()}\n        onSubmit={vi.fn()}\n      />,\n    );\n\n    await user.click(screen.getByRole(\"button\", { name: \"Test connection\" }));\n\n    await waitFor(() => expect(cmd.modelTestConnection).toHaveBeenCalledOnce());\n    expect(cmd.modelTestConnection).toHaveBeenCalledWith(\n      \"https://gateway.example.com/v1\",\n      \"openai-completions\",\n      \"MY_GATEWAY_KEY\",\n      { \"X-Tenant\": \"desktop\" },\n      \"my-model\",\n    );\n    expect(await screen.findByRole(\"status\")).toHaveTextContent(\"Connection successful\");\n  });\n});\n`);

console.log("✓ Step 5 dedicated connection test patch applied");
