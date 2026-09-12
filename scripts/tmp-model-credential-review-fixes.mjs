import { readFileSync, writeFileSync, rmSync } from 'node:fs'

function replaceOnce(path, from, to) {
  const text = readFileSync(path, 'utf8')
  const first = text.indexOf(from)
  if (first < 0) throw new Error(`${path}: source snippet not found`)
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`${path}: source snippet is not unique`)
  writeFileSync(path, text.slice(0, first) + to + text.slice(first + from.length))
}

replaceOnce(
  'src/features/models/ProviderDialog.tsx',
`  const discoveryActive =
    showComposer &&
    !currentUrlIssue &&
    Boolean(draft.baseURL?.trim()) &&
    (!knownService || hasRequestCredential);`,
`  const discoveryActive =
    showComposer &&
    !currentUrlIssue &&
    !apiKeyError &&
    Boolean(draft.baseURL?.trim()) &&
    (!knownService || hasRequestCredential);`,
)
replaceOnce(
  'src/features/models/ProviderDialog.tsx',
`  const canTest =
    showComposer && launcherCanTest && !currentUrlIssue && Boolean(testTarget) && !saving && !testing;`,
`  const canTest =
    showComposer &&
    launcherCanTest &&
    !currentUrlIssue &&
    !apiKeyError &&
    Boolean(testTarget) &&
    !saving &&
    !testing;`,
)

replaceOnce(
  'src-tauri/src/model_remote.rs',
`        remember_provider_models(
            &base_url,
            api.as_deref(),
            api_key_env.as_deref(),
            headers.as_ref(),
            &models,
        );`,
`        // A write-only unsaved key is intentionally outside the persistent cache identity.
        // Do not let a probe that the user may discard overwrite the saved credential's cache.
        if non_empty(api_key.as_deref()).is_none() {
            remember_provider_models(
                &base_url,
                api.as_deref(),
                api_key_env.as_deref(),
                headers.as_ref(),
                &models,
            );
        }`,
)
replaceOnce(
  'src-tauri/src/model_remote.rs',
`//! \`dsh::models\` 负责 settings.yaml 模型域；这里承接带自定义 headers 的
//! \`/models\` HTTP 探测以及凭据环境变量可用性检查。后者只返回布尔值，绝不
//! 把 secret 内容跨 IPC 暴露给前端。`,
`//! \`dsh::models\` 负责 settings.yaml 模型域；这里承接带自定义 headers 的
//! \`/models\` HTTP 探测与最小推理测试。凭据值只在 Rust 内解析或作为一次性
//! write-only 请求参数进入，绝不从 IPC 返回前端。`,
)

// The old process-environment readiness IPC is no longer part of the Models path.
replaceOnce(
  'src-tauri/src/model_remote.rs',
`fn env_value_available(name: &str) -> bool {
    std::env::var(name)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

`,
'',
)
replaceOnce(
  'src-tauri/src/model_remote.rs',
`/// 批量检查密钥环境变量是否在 launcher 当前进程环境中存在且非空。
/// 返回值仅包含调用方传入的变量名与布尔状态，不读取/返回 secret 内容。
#[tauri::command]
pub fn model_env_status(names: Vec<String>) -> BTreeMap<String, bool> {
    names
        .into_iter()
        .filter_map(|raw| {
            let name = raw.trim().to_string();
            if name.is_empty() {
                None
            } else {
                let available = env_value_available(&name);
                Some((name, available))
            }
        })
        .collect()
}

`,
'',
)
replaceOnce(
  'src-tauri/src/model_remote.rs',
`    #[test]
    fn env_status_trims_dedupes_and_does_not_expose_values() {
        let missing = "__DSH_PRO_MAX_READINESS_TEST_MISSING_8E4D3A2F__";
        let status = model_env_status(vec![
            "".to_string(),
            format!("  {missing}  "),
            missing.to_string(),
        ]);
        assert_eq!(status.len(), 1);
        assert_eq!(status.get(missing), Some(&false));
    }
`,
'',
)
replaceOnce(
  'src-tauri/src/main.rs',
`            model_remote::model_env_status,
`,
'',
)

rmSync('scripts/tmp-model-credential-review-fixes.mjs')
rmSync('.github/workflows/tmp-model-credential-review-fixes.yml')
