import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

async function edit(path, mutate) {
  const full = join(root, path);
  const before = await readFile(full, "utf8");
  const after = mutate(before);
  if (after === before) throw new Error(`${path}: patch produced no change`);
  await writeFile(full, after);
}

function once(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`missing ${label}`);
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`ambiguous ${label}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

await edit("src/features/models/ModelsView.tsx", (text) => {
  text = once(
    text,
    'import type { CredentialWrite } from "./credentials";',
    'import { deriveCredentialRef, type CredentialWrite } from "./credentials";',
    "credential import",
  );
  text = once(
    text,
    `async function resolveProviderEnvStatus(providers: ProviderConfig[]): Promise<Record<string, boolean>> {\n  const names = providerEnvNames(providers);\n  return names.length > 0 ? cmd.modelEnvStatus(names) : {};\n}\n`,
    `async function resolveProviderEnvStatus(providers: ProviderConfig[]): Promise<Record<string, boolean>> {\n  const names = providerEnvNames(providers);\n  return names.length > 0 ? cmd.modelEnvStatus(names) : {};\n}\n\n/** Match DSH Models ownership: only this page's derived, configured, writable key is ours to remove. */\nasync function removeOwnedProviderCredential(provider: ProviderConfig): Promise<void> {\n  const ref = provider.apiKeyEnv?.trim();\n  if (!ref || ref !== deriveCredentialRef(provider.route.trim())) return;\n  const described = await cmd.modelCredentialDescribe([ref]);\n  const credential = described[ref];\n  if (credential?.configured === true && credential.writable) {\n    await cmd.modelCredentialUnset(ref);\n  }\n}\n`,
    "owned credential helper",
  );
  text = once(
    text,
    `    setDeletingRoute(route);\n    try {\n      await persist(next, route);`,
    `    setDeletingRoute(route);\n    try {\n      if (removed) {\n        try {\n          // Credential first: if settings removal later fails, retry is safe because unset is idempotent.\n          await removeOwnedProviderCredential(removed);\n        } catch (error) {\n          toast(\`${"${t(\"Remove provider\")}: ${tErr(String(error))}"}\`, "error");\n          throw error;\n        }\n      }\n      await persist(next, route);`,
    "remove provider credential ordering",
  );
  return text;
});

await edit("src/features/models/ModelsView.test.tsx", (text) => {
  text = once(
    text,
    `  vi.spyOn(cmd, "modelCredentialSet").mockResolvedValue({ configured: true, source: "file", writable: true });\n  vi.spyOn(cmd, "modelEnvStatus").mockImplementation(async (names) =>`,
    `  vi.spyOn(cmd, "modelCredentialSet").mockResolvedValue({ configured: true, source: "file", writable: true });\n  vi.spyOn(cmd, "modelCredentialDescribe").mockImplementation(async (names) =>\n    Object.fromEntries(names.map((name) => [name, { configured: true, source: "file", writable: true }])),\n  );\n  vi.spyOn(cmd, "modelCredentialUnset").mockResolvedValue({ configured: false, source: null, writable: true });\n  vi.spyOn(cmd, "modelEnvStatus").mockImplementation(async (names) =>`,
    "credential mocks",
  );
  text = once(
    text,
    `    expect(firstSaved.providers[0].apiKeyEnv).toBe("DEEPSEEK_API_KEY");\n    expect(firstSaved.defaultProvider).toBeNull();`,
    `    expect(firstSaved.providers[0].apiKeyEnv).toBe("DEEPSEEK_API_KEY");\n    expect(JSON.stringify(firstSaved)).not.toContain("sk-deepseek-test");\n    expect(firstSaved.defaultProvider).toBeNull();`,
    "secret separation first save",
  );
  text = once(
    text,
    `    expect(saved.defaultProvider).toBe(saved.providers[0].route);\n    expect(saved.defaultModel).toBe("deepseek-v4-pro");`,
    `    expect(saved.defaultProvider).toBe(saved.providers[0].route);\n    expect(saved.defaultModel).toBe("deepseek-v4-pro");\n    expect(JSON.stringify(saved)).not.toContain("sk-deepseek-test");`,
    "secret separation final save",
  );
  text = once(
    text,
    `    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());\n    const saved = vi.mocked(cmd.modelConfigSave).mock.calls[0][0];\n    expect(saved.providers.map((provider) => provider.route)).toEqual(["empty-ai", "second-ai"]);`,
    `    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());\n    expect(cmd.modelCredentialDescribe).toHaveBeenCalledWith(["SPERO_AI_API_KEY"]);\n    expect(cmd.modelCredentialUnset).toHaveBeenCalledWith("SPERO_AI_API_KEY");\n    expect(vi.mocked(cmd.modelCredentialUnset).mock.invocationCallOrder[0]).toBeLessThan(\n      vi.mocked(cmd.modelConfigSave).mock.invocationCallOrder[0],\n    );\n    const saved = vi.mocked(cmd.modelConfigSave).mock.calls[0][0];\n    expect(saved.providers.map((provider) => provider.route)).toEqual(["empty-ai", "second-ai"]);`,
    "managed credential removal assertion",
  );
  text = once(
    text,
    `  it("keeps a failed provider save inside the dialog with an actionable inline error", async () => {`,
    `  it("preserves custom and read-only launch credential references when removing providers", async () => {\n    const user = userEvent.setup();\n    const custom = { ...config.providers[0], apiKeyEnv: "SHARED_API_KEY" };\n    loadWith({ ...config, defaultProvider: null, defaultModel: null, providers: [custom] });\n    const view = render(createElement(ModelsView));\n    await waitFor(() => expect(screen.getByText("Spero AI")).toBeInTheDocument());\n    await user.click(screen.getByRole("button", { name: "Remove provider" }));\n    await user.click(screen.getByRole("button", { name: "Remove", exact: true }));\n    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());\n    expect(cmd.modelCredentialDescribe).not.toHaveBeenCalled();\n    expect(cmd.modelCredentialUnset).not.toHaveBeenCalled();\n\n    view.unmount();\n    vi.clearAllMocks();\n    vi.spyOn(cmd, "modelCatalogLoad").mockResolvedValue(catalog);\n    vi.spyOn(cmd, "modelCatalogRefresh").mockResolvedValue(catalog);\n    vi.spyOn(cmd, "modelRemoteCacheGet").mockResolvedValue(null);\n    vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);\n    vi.spyOn(cmd, "modelCredentialDescribe").mockResolvedValue({\n      SPERO_AI_API_KEY: { configured: true, source: "env", writable: false },\n    });\n    vi.spyOn(cmd, "modelCredentialUnset").mockResolvedValue({ configured: true, source: "env", writable: false });\n    vi.spyOn(cmd, "modelEnvStatus").mockResolvedValue({ SPERO_AI_API_KEY: true });\n    loadWith({ ...config, providers: [config.providers[0]] });\n    render(createElement(ModelsView));\n    await waitFor(() => expect(screen.getByText("Spero AI")).toBeInTheDocument());\n    await user.click(screen.getByRole("button", { name: "Remove provider" }));\n    await user.click(screen.getByRole("button", { name: "Remove", exact: true }));\n    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());\n    expect(cmd.modelCredentialDescribe).toHaveBeenCalledWith(["SPERO_AI_API_KEY"]);\n    expect(cmd.modelCredentialUnset).not.toHaveBeenCalled();\n  });\n\n  it("keeps provider deletion retryable when owned credential cleanup fails", async () => {\n    loadWith({ ...config, providers: [config.providers[0]] });\n    vi.mocked(cmd.modelCredentialUnset)\n      .mockRejectedValueOnce("Credential store busy")\n      .mockResolvedValue({ configured: false, source: null, writable: true });\n    const user = userEvent.setup();\n    render(createElement(ModelsView));\n    await waitFor(() => expect(screen.getByText("Spero AI")).toBeInTheDocument());\n\n    await user.click(screen.getByRole("button", { name: "Remove provider" }));\n    const confirmation = screen.getByTestId("provider-remove-confirm-0");\n    await user.click(within(confirmation).getByRole("button", { name: "Remove", exact: true }));\n    await waitFor(() => expect(cmd.modelCredentialUnset).toHaveBeenCalledTimes(1));\n    expect(cmd.modelConfigSave).not.toHaveBeenCalled();\n    expect(screen.getByTestId("provider-remove-confirm-0")).toBeInTheDocument();\n    expect(useAppStore.getState().toasts.at(-1)?.message).toContain("Credential store busy");\n\n    await user.click(within(screen.getByTestId("provider-remove-confirm-0")).getByRole("button", { name: "Remove", exact: true }));\n    await waitFor(() => expect(cmd.modelCredentialUnset).toHaveBeenCalledTimes(2));\n    await waitFor(() => expect(cmd.modelConfigSave).toHaveBeenCalledOnce());\n    expect(screen.queryByText("Spero AI")).not.toBeInTheDocument();\n  });\n\n  it("keeps a failed provider save inside the dialog with an actionable inline error", async () => {`,
    "removal ownership tests",
  );
  return text;
});

await edit("src/features/models/ProviderDialog.edit.test.tsx", (text) => {
  text = once(
    text,
    `  it("keeps the primary path focused and only enables save for real changes", async () => {`,
    `  it("keeps an existing credential reference when edit saves with a blank write-only key", async () => {\n    const user = userEvent.setup();\n    const onSubmit = vi.fn().mockResolvedValue(undefined);\n    render(\n      <ProviderDialog\n        state={{ mode: "edit", index: 0, provider }}\n        catalog={catalog}\n        onClose={vi.fn()}\n        onSubmit={onSubmit}\n      />,\n    );\n    const dialog = screen.getByRole("dialog", { name: "Edit provider" });\n    expect(within(dialog).getByLabelText("API Key")).toHaveValue("");\n    const displayName = within(dialog).getByRole("textbox", { name: "Display Name" });\n    await user.clear(displayName);\n    await user.type(displayName, "DeepSeek Production");\n    await user.click(within(dialog).getByRole("button", { name: "Save provider" }));\n    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());\n    const [saved, originalRoute, credential] = onSubmit.mock.calls[0];\n    expect(originalRoute).toBe("deepseek");\n    expect(saved.apiKeyEnv).toBe("DEEPSEEK_API_KEY");\n    expect(credential).toBeNull();\n  });\n\n  it("keeps the primary path focused and only enables save for real changes", async () => {`,
    "blank edit credential test",
  );
  return text;
});

await edit("src-tauri/src/model_credentials.rs", (text) => {
  text = once(
    text,
    `    #[test]\n    fn flat_pre_release_document_is_upgraded_on_write() {`,
    `    #[test]\n    fn managed_credential_lifecycle_set_replace_and_unset() {\n        let dir = temp_dir("credentials-lifecycle");\n        let path = dir.join(CREDENTIALS_FILENAME);\n        let name = "DSH_PRO_MAX_LIFECYCLE_KEY";\n\n        let initial = offline_describe_one(name, &path).expect("initial describe");\n        assert!(!initial.configured);\n        assert!(initial.writable);\n\n        mutate_credential_ref_at(&path, name, Some("secret-one")).expect("set first");\n        let stored = offline_describe_one(name, &path).expect("stored describe");\n        assert!(stored.configured);\n        assert_eq!(stored.source.as_deref(), Some("file"));\n        assert!(stored.writable);\n\n        mutate_credential_ref_at(&path, name, Some("secret-two")).expect("replace");\n        assert_eq!(\n            file_ref_value(&path, name).expect("read replacement").as_deref(),\n            Some("secret-two")\n        );\n\n        mutate_credential_ref_at(&path, name, None).expect("unset");\n        let removed = offline_describe_one(name, &path).expect("removed describe");\n        assert!(!removed.configured);\n        assert!(removed.writable);\n        let _ = fs::remove_dir_all(dir);\n    }\n\n    #[test]\n    fn launch_environment_is_read_only_and_shadows_managed_file() {\n        let dir = temp_dir("credentials-env-shadow");\n        let path = dir.join(CREDENTIALS_FILENAME);\n        let stamp = SystemTime::now()\n            .duration_since(UNIX_EPOCH)\n            .expect("clock")\n            .as_nanos();\n        let name = format!("DSH_PRO_MAX_LIFECYCLE_ENV_{stamp}");\n        mutate_credential_ref_at(&path, &name, Some("managed-secret")).expect("seed managed");\n        std::env::set_var(&name, "launch-secret");\n\n        let described = offline_describe_one(&name, &path).expect("describe env");\n        assert!(described.configured);\n        assert_eq!(described.source.as_deref(), Some("env"));\n        assert!(!described.writable);\n        let error = mutate_credential_ref_at(&path, &name, Some("replacement"))\n            .expect_err("launch env must reject writes");\n        assert!(error.contains("read-only"));\n        assert_eq!(\n            file_ref_value(&path, &name).expect("managed remains").as_deref(),\n            Some("managed-secret")\n        );\n\n        std::env::remove_var(&name);\n        let _ = fs::remove_dir_all(dir);\n    }\n\n    #[test]\n    fn flat_pre_release_document_is_upgraded_on_write() {`,
    "credential lifecycle rust tests",
  );
  return text;
});

await edit("src-tauri/src/model_credential_resolver.rs", (text) => {
  text = once(
    text,
    `pub(crate) fn resolve(raw: &str) -> Result<Option<String>, String> {\n    let name = raw.trim();\n    if !valid_ref(name) {\n        return Err(\n            "Credential reference must be a POSIX-style environment variable name".to_string(),\n        );\n    }\n    if let Ok(value) = std::env::var(name) {\n        if !value.is_empty() {\n            return Ok(Some(value));\n        }\n    }\n    let home = dsh_dir()?;\n    if let Some(value) = file_value(&home.join(".credentials.yaml"), name)? {\n        return Ok(Some(value));\n    }\n    if let Ok(cwd) = std::env::current_dir() {\n        if let Some(value) = dotenv_value(&cwd.join(".env"), name) {\n            return Ok(Some(value));\n        }\n    }\n    if let Some(value) = dotenv_value(&home.join(".env"), name) {\n        return Ok(Some(value));\n    }\n    Ok(None)\n}`,
    `fn resolve_from_sources(\n    raw: &str,\n    credentials: &Path,\n    project_env: Option<&Path>,\n    user_env: &Path,\n) -> Result<Option<String>, String> {\n    let name = raw.trim();\n    if !valid_ref(name) {\n        return Err(\n            "Credential reference must be a POSIX-style environment variable name".to_string(),\n        );\n    }\n    if let Ok(value) = std::env::var(name) {\n        if !value.is_empty() {\n            return Ok(Some(value));\n        }\n    }\n    if let Some(value) = file_value(credentials, name)? {\n        return Ok(Some(value));\n    }\n    if let Some(path) = project_env {\n        if let Some(value) = dotenv_value(path, name) {\n            return Ok(Some(value));\n        }\n    }\n    if let Some(value) = dotenv_value(user_env, name) {\n        return Ok(Some(value));\n    }\n    Ok(None)\n}\n\npub(crate) fn resolve(raw: &str) -> Result<Option<String>, String> {\n    let home = dsh_dir()?;\n    let project_env = std::env::current_dir().ok().map(|cwd| cwd.join(".env"));\n    resolve_from_sources(\n        raw,\n        &home.join(".credentials.yaml"),\n        project_env.as_deref(),\n        &home.join(".env"),\n    )\n}`,
    "resolver source helper",
  );
  text = once(
    text,
    `    #[test]\n    fn dotenv_scan_skips_unrelated_non_assignment_lines() {`,
    `    #[test]\n    fn managed_updates_reach_the_next_resolution_and_preserve_precedence() {\n        let dir = temp_dir("lifecycle");\n        let credentials = dir.join(".credentials.yaml");\n        let project_env = dir.join("project.env");\n        let user_env = dir.join("user.env");\n        let name = "DSH_PRO_MAX_RESOLVER_LIFECYCLE_KEY";\n        fs::write(&project_env, format!("{name}=project-secret\\n")).expect("project env");\n        fs::write(&user_env, format!("{name}=user-secret\\n")).expect("user env");\n\n        let write_managed = |value: &str| {\n            fs::write(\n                &credentials,\n                format!("version: 1\\nrefs:\\n  {name}: {value}\\n"),\n            )\n            .expect("managed credentials");\n            #[cfg(unix)]\n            {\n                use std::os::unix::fs::PermissionsExt;\n                fs::set_permissions(&credentials, fs::Permissions::from_mode(0o600))\n                    .expect("chmod");\n            }\n        };\n\n        write_managed("managed-one");\n        assert_eq!(\n            resolve_from_sources(name, &credentials, Some(&project_env), &user_env)\n                .expect("first resolve")\n                .as_deref(),\n            Some("managed-one")\n        );\n        write_managed("managed-two");\n        assert_eq!(\n            resolve_from_sources(name, &credentials, Some(&project_env), &user_env)\n                .expect("hot resolve")\n                .as_deref(),\n            Some("managed-two")\n        );\n\n        fs::remove_file(&credentials).expect("remove managed");\n        assert_eq!(\n            resolve_from_sources(name, &credentials, Some(&project_env), &user_env)\n                .expect("project fallback")\n                .as_deref(),\n            Some("project-secret")\n        );\n        fs::remove_file(&project_env).expect("remove project env");\n        assert_eq!(\n            resolve_from_sources(name, &credentials, Some(&project_env), &user_env)\n                .expect("user fallback")\n                .as_deref(),\n            Some("user-secret")\n        );\n        let _ = fs::remove_dir_all(dir);\n    }\n\n    #[test]\n    fn dotenv_scan_skips_unrelated_non_assignment_lines() {`,
    "resolver lifecycle test",
  );
  return text;
});

await edit("e2e/capture-models-add-provider.mjs", (text) => {
  text = text.replace("set API key env", "set write-only API key");
  text = once(
    text,
    `      window.__auditSavedConfigs = [];\n      let currentModelConfig = structuredClone(modelConfig);`,
    `      window.__auditSavedConfigs = [];\n      window.__auditCredentialWrites = [];\n      let currentModelConfig = structuredClone(modelConfig);`,
    "add provider credential writes state",
  );
  text = once(
    text,
    `        model_credential_set: () => ({ configured: true, source: "file", writable: true }),`,
    `        model_credential_set: ({ name, value }) => {\n          window.__auditCredentialWrites.push({ name, value });\n          return { configured: true, source: "file", writable: true };\n        },`,
    "add provider credential set tracking",
  );
  text = once(
    text,
    `    await envInput.fill("DEEPSEEK_API_KEY");`,
    `    await envInput.fill("sk-deepseek-lifecycle");`,
    "add provider secret input",
  );
  text = once(
    text,
    `    const saved = await page.evaluate(() => window.__auditSavedConfigs[0]);\n    assert.equal(saved.providers.length, 2);`,
    `    const lifecycle = await page.evaluate(() => ({\n      saved: window.__auditSavedConfigs[0],\n      writes: window.__auditCredentialWrites,\n    }));\n    const saved = lifecycle.saved;\n    assert.deepEqual(lifecycle.writes, [{ name: "DEEPSEEK_API_KEY", value: "sk-deepseek-lifecycle" }]);\n    assert.equal(JSON.stringify(saved).includes("sk-deepseek-lifecycle"), false);\n    assert.equal(saved.providers.length, 2);`,
    "add provider credential assertions",
  );
  return text;
});

await edit("e2e/capture-models-remove-provider.mjs", (text) => {
  text = once(
    text,
    `      window.__auditSavedConfigs = [];\n      window.__auditSavePending = false;`,
    `      window.__auditSavedConfigs = [];\n      window.__auditCredentialUnsets = [];\n      window.__auditOperationOrder = [];\n      window.__auditSavePending = false;`,
    "remove provider lifecycle state",
  );
  text = once(
    text,
    `            currentModelConfig = structuredClone(config);\n            window.__auditSavedConfigs.push(structuredClone(config));`,
    `            currentModelConfig = structuredClone(config);\n            window.__auditSavedConfigs.push(structuredClone(config));\n            window.__auditOperationOrder.push("settings-save");`,
    "remove provider save order",
  );
  text = once(
    text,
    `        model_credential_describe: ({ names }) => Object.fromEntries(names.map((name) => [name, { configured: true, source: "file", writable: true }])),\n        model_remote_cache_get: () => null,`,
    `        model_credential_describe: ({ names }) => Object.fromEntries(names.map((name) => [name, { configured: true, source: "file", writable: true }])),\n        model_credential_unset: ({ name }) => {\n          window.__auditCredentialUnsets.push(name);\n          window.__auditOperationOrder.push(\`credential-unset:${"${name}"}\`);\n          return { configured: false, source: null, writable: true };\n        },\n        model_remote_cache_get: () => null,`,
    "remove provider unset mock",
  );
  text = once(
    text,
    `    const saved = await page.evaluate(() => window.__auditSavedConfigs.at(-1));\n    assert.deepEqual(saved.providers.map((provider) => provider.route), ["deepseek"]);`,
    `    const lifecycle = await page.evaluate(() => ({\n      saved: window.__auditSavedConfigs.at(-1),\n      unsets: window.__auditCredentialUnsets,\n      order: window.__auditOperationOrder,\n    }));\n    const saved = lifecycle.saved;\n    assert.deepEqual(lifecycle.unsets, ["SPERO_AI_API_KEY"]);\n    assert.deepEqual(lifecycle.order.slice(0, 2), ["credential-unset:SPERO_AI_API_KEY", "settings-save"]);\n    assert.deepEqual(saved.providers.map((provider) => provider.route), ["deepseek"]);`,
    "remove provider lifecycle assertions",
  );
  return text;
});

await unlink(join(root, "scripts", "tmp-credential-lifecycle-acceptance.mjs"));
await unlink(join(root, ".github", "workflows", "tmp-credential-lifecycle-acceptance.yml"));
console.log("credential lifecycle acceptance patch applied and temporary files removed");
