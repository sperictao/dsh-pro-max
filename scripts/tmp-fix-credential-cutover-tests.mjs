import { readFileSync, writeFileSync, rmSync } from 'node:fs'

function replaceOnce(path, from, to) {
  const text = readFileSync(path, 'utf8')
  const first = text.indexOf(from)
  if (first < 0) throw new Error(`${path}: source snippet not found`)
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`${path}: source snippet is not unique`)
  writeFileSync(path, text.slice(0, first) + to + text.slice(first + from.length))
}

const models = 'src/features/models/ModelsView.test.tsx'
replaceOnce(models,
`  vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
  vi.spyOn(cmd, "modelEnvStatus").mockImplementation(async (names) =>`,
`  vi.spyOn(cmd, "modelConfigSave").mockResolvedValue(undefined);
  vi.spyOn(cmd, "modelCredentialSet").mockResolvedValue({ configured: true, source: "file", writable: true });
  vi.spyOn(cmd, "modelEnvStatus").mockImplementation(async (names) =>`)
replaceOnce(models,
`    expect(within(dialog).getByLabelText("API Key Env Var")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Route key")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("API Key Env Var"), "DEEPSEEK_API_KEY");`,
`    expect(within(dialog).getByLabelText("API Key")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Route key")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("API Key"), "sk-deepseek-test");`)
replaceOnce(models,
`    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(cmd.modelConfigSave).toHaveBeenCalledOnce();
    const saved = vi.mocked(cmd.modelConfigSave).mock.calls[0][0];
    expect(saved.providers).toHaveLength(1);
    expect(saved.providers[0].route).toMatch(/deepseek/i);
    expect(saved.defaultProvider).toBe(saved.providers[0].route);
    expect(saved.defaultModel).toBe("deepseek-v4-pro");`,
`    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(cmd.modelCredentialSet).toHaveBeenCalledWith("DEEPSEEK_API_KEY", "sk-deepseek-test");
    expect(cmd.modelConfigSave).toHaveBeenCalledTimes(2);
    const firstSaved = vi.mocked(cmd.modelConfigSave).mock.calls[0][0];
    expect(firstSaved.providers).toHaveLength(1);
    expect(firstSaved.providers[0].apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(firstSaved.defaultProvider).toBeNull();
    const saved = vi.mocked(cmd.modelConfigSave).mock.calls.at(-1)![0];
    expect(saved.providers[0].route).toMatch(/deepseek/i);
    expect(saved.defaultProvider).toBe(saved.providers[0].route);
    expect(saved.defaultModel).toBe("deepseek-v4-pro");`)
replaceOnce(models,
`  it("fetches provider models inside the edit dialog and invalidates stale discovery when the credential reference changes", async () => {`,
`  it("fetches provider models inside the edit dialog and invalidates stale discovery when the write-only key changes", async () => {`)
replaceOnce(models,
`    await user.clear(within(dialog).getByLabelText("API Key Env Var"));
    await user.type(within(dialog).getByLabelText("API Key Env Var"), "NEW_KEY");
    expect(within(dialog).getByRole("list", { name: "Models from this service" })).not.toHaveTextContent("kimi-k2");
    await user.click(within(dialog).getByRole("button", { name: "Fetch list" }));
    await waitFor(() => expect(remote).toHaveBeenCalledTimes(2));
    expect(remote.mock.calls[1][2]).toBe("NEW_KEY");
    expect(remote.mock.calls[1][3]).toEqual({ "X-Title": "my-app" });`,
`    await user.type(within(dialog).getByLabelText("API Key"), "sk-new-key");
    expect(within(dialog).getByRole("list", { name: "Models from this service" })).not.toHaveTextContent("kimi-k2");
    await waitFor(() => expect(remote).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(remote.mock.calls[1][2]).toBe("SPERO_AI_API_KEY");
    expect(remote.mock.calls[1][3]).toEqual({ "X-Title": "my-app" });
    expect(remote.mock.calls[1][4]).toBe("sk-new-key");`)
replaceOnce(models,
`  it("excludes a provider with a missing env from defaults while allowing an anonymous custom provider", async () => {`,
`  it("excludes a provider with a missing credential from defaults while allowing an anonymous custom provider", async () => {`)
replaceOnce(models,
`    expect(screen.getByTestId("provider-readiness-0")).toHaveTextContent("MISSING_OPENAI_KEY: Not set");`,
`    expect(screen.getByTestId("provider-readiness-0")).toHaveTextContent("API key is not configured");`)

replaceOnce('src/features/models/ProviderDialog.add.test.tsx',
`    await waitFor(() => expect(cmd.modelRemoteList).toHaveBeenCalledOnce(), { timeout: 2000 });
    await waitFor(() => expect(fetchList).toBeEnabled());
    await waitFor(() =>`,
`    await waitFor(() => expect(cmd.modelRemoteList).toHaveBeenCalledOnce(), { timeout: 2000 });
    await waitFor(() =>`)

replaceOnce('src/features/models/ProviderDialog.base-url-validation.test.tsx',
`      null,
      "my-model",
    );`,
`      null,
      "my-model",
      null,
    );`)

const picker = 'src/features/models/ProviderDialog.picker.test.tsx'
replaceOnce(picker,
`    expect(within(dialog).queryByLabelText("API Key Env Var")).not.toBeInTheDocument();`,
`    expect(within(dialog).queryByLabelText("API Key")).not.toBeInTheDocument();`)
replaceOnce(picker,
`    const apiKey = within(dialog).getByLabelText("API Key Env Var");`,
`    const apiKey = within(dialog).getByLabelText("API Key");`)

rmSync('scripts/tmp-fix-credential-cutover-tests.mjs')
rmSync('.github/workflows/tmp-fix-credential-cutover-tests.yml')
