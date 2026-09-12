// Add provider UI audit capture.
// Scope: Models -> Add provider -> pick DeepSeek -> set API key env -> select model -> save -> verify persisted provider.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5194;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-add-provider");

const initialProvider = {
  route: "spero-ai",
  displayName: "Spero AI",
  baseURL: "https://proxy.example.com/v1",
  api: "openai-responses",
  apiKeyEnv: "SPERO_AI_API_KEY",
  models: [{ id: "glm-5.2", name: "GLM 5.2", contextWindow: 131072, maxTokens: 32768, input: ["text"], reasoningEfforts: { low: "low", medium: "medium", high: "high", max: "max" }, extra: null }],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

const modelConfig = {
  defaultProvider: "spero-ai",
  defaultModel: "glm-5.2",
  defaultReasoningEffort: "high",
  providers: [initialProvider],
};

const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 2,
  entries: [
    { id: "glm-5.2", name: "GLM 5.2", family: "openai", context: 131072, maxTokens: 32768, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high", "max"], capabilities: ["text", "reasoning", "tools"] },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "openai", context: 131072, maxTokens: 16384, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
    { id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
  ],
};

const mock = {
  config: { minimize_to_tray_on_close: false, language: "en", dsh_admin_cap_domain: "", dsh_use_cap_domain: "", dsh_extra_allowed_logins: "", market_catalog_url: "" },
  dshStatus: {
    nodeAvailable: false, dshInstalled: false, dshVersion: null, supportedVersion: "0.1.1-rc.2", dshCompatible: false, dshVersionAboveSupported: false,
    pluginsInstalled: false, dshRunning: false, tailscaleInstalled: false, tailscaleOnline: false, hostname: null, localUrl: null, url: null,
    remoteUrlAccess: null, magicDnsEnabled: false, serveConfigured: false, autostartEnabled: false, error: null,
    readyTimeline: ["node", "install", "start", "ready"].map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
  },
};

async function launchBrowser() {
  const attempts = [{ channel: "chrome" }, { channel: "msedge" }, {}];
  const failures = [];
  for (const opts of attempts) {
    try {
      return await chromium.launch({ headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [], ...opts });
    } catch (error) {
      failures.push(`${opts.channel ?? "bundled chromium"}: ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }
  throw new Error(`no browser available for UI capture\n${failures.join("\n")}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await createServer({ root: ROOT, logLevel: "error", server: { host: "127.0.0.1", port: PORT, strictPort: true } });
  await server.listen();
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 960 } } });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ config, dshStatus, modelConfig, modelCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      window.__auditSavedConfigs = [];
      let currentModelConfig = structuredClone(modelConfig);
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => config,
        autostart_is_enabled: () => false,
        get_updater_config_health: () => ({ configured: true, message: "ready" }),
        check_update: () => ({ currentVersion: "0.4.0", availableVersion: null, hasUpdate: false, releaseNotes: null, message: null }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) => (remote ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] : ["node", "install", "start", "ready"]).map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
        model_config_load: () => structuredClone(currentModelConfig),
        model_config_save: ({ config }) => {
          currentModelConfig = structuredClone(config);
          window.__auditSavedConfigs.push(structuredClone(config));
          return new Promise((resolve) => setTimeout(() => resolve(null), 500));
        },
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({ ...modelCatalog, fetchedAt: Math.floor(Date.now() / 1000) }),
        model_credential_describe: ({ names }) => Object.fromEntries(names.map((name) => [name, { configured: true, source: "file", writable: true }])),
        model_credential_set: () => ({ configured: true, source: "file", writable: true }),
        model_credential_unset: () => ({ configured: false, source: null, writable: true }),
        model_remote_cache_get: () => null,
        model_remote_list_with_headers: () => new Promise((resolve) => setTimeout(() => resolve(["deepseek-v4-pro", "deepseek-chat"]), 450)),
        model_test_connection: () => null,
        "plugin:app|version": () => "0.4.0",
        "plugin:notification|is_permission_granted": () => true,
      };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: (callback) => { const id = nextId++; callbacks.set(id, callback); return id; },
        unregisterCallback: (id) => callbacks.delete(id),
        runCallback: (id, data) => callbacks.get(id)?.(data),
        callbacks,
        invoke: (command, args) => {
          if (command === "plugin:event|listen") return Promise.resolve(nextId++);
          if (command === "plugin:event|unlisten") return Promise.resolve(null);
          const handler = handlers[command];
          if (!handler) return Promise.reject(new Error(`capture mock: unhandled command "${command}"`));
          return Promise.resolve(handler(args));
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => callbacks.delete(id) };
    }, { ...mock, modelConfig, modelCatalog });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();
    await page.getByRole("button", { name: "Add provider" }).first().waitFor({ state: "visible" });
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Add provider" }).first().click();

    const dialog = page.getByRole("dialog", { name: "Add provider" });
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(1200);

    const service = dialog.getByTestId("preset-input");
    const saveButton = dialog.getByRole("button", { name: "Save provider" });
    assert.equal(await saveButton.isDisabled(), true);
    assert.equal(await dialog.getByRole("button", { name: "Test connection" }).count(), 0);
    assert.equal(await dialog.getByRole("button", { name: "Close" }).count(), 0);

    await service.fill("deepseek");
    await page.waitForTimeout(700);
    const picker = dialog.getByRole("listbox", { name: "Choose a service or custom endpoint" });
    const deepseek = picker.getByRole("option", { name: /DeepSeek deepseek/i });
    await deepseek.click();

    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "API Key");
    assert.equal(await service.inputValue(), "DeepSeek");
    assert.equal(await dialog.getByLabel("Display Name").count(), 0);
    assert.equal(await saveButton.isDisabled(), true);
    await page.waitForTimeout(900);

    const envInput = dialog.getByLabel("API Key");
    await envInput.fill("DEEPSEEK_API_KEY");
    assert.equal(await saveButton.isDisabled(), true);
    await page.waitForTimeout(1100);

    const modelList = dialog.getByRole("list", { name: "Models from this service" });
    const modelCheckbox = modelList.getByRole("checkbox", { name: "deepseek-v4-pro" });
    await modelCheckbox.waitFor({ state: "visible" });
    await modelCheckbox.check();
    assert.equal(await saveButton.isEnabled(), true);
    await page.waitForTimeout(900);

    await saveButton.click();
    await page.getByRole("button", { name: "Saving…" }).waitFor({ state: "visible" });
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.__auditSavedConfigs.length === 1);
    await page.getByText("DeepSeek").first().waitFor({ state: "visible" });
    await page.waitForTimeout(1400);

    const saved = await page.evaluate(() => window.__auditSavedConfigs[0]);
    assert.equal(saved.providers.length, 2);
    const added = saved.providers.find((provider) => provider.route === "deepseek");
    assert.ok(added, "DeepSeek provider was not saved");
    assert.equal(added.apiKeyEnv, "DEEPSEEK_API_KEY");
    assert.deepEqual(added.models.map((model) => model.id), ["deepseek-v4-pro"]);
    assert.equal(saved.defaultProvider, "spero-ai");
    assert.equal(saved.defaultModel, "glm-5.2");
    assert.equal(failures.length, 0, failures.join("\n"));

    await page.screenshot({ path: resolve(OUT_DIR, "models-add-provider.png"), fullPage: true });
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-add-provider.webm");
    if (recorded !== stable) renameSync(recorded, stable);
    console.log(`capture: ${stable}`);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
