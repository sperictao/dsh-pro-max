// Provider row -> Edit provider UI audit capture.
// Scope: open an existing known provider, inspect the untouched edit state,
// modify the common-path identity/credential fields, save, and verify persistence.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5200;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-edit-provider");

const spero = {
  route: "spero-ai",
  displayName: "Spero AI",
  baseURL: "https://proxy.example.com/v1",
  api: "openai-responses",
  apiKeyEnv: "SPERO_AI_API_KEY",
  models: [
    { id: "glm-5.2", name: "GLM 5.2", contextWindow: 131072, maxTokens: 32768, input: ["text"], reasoningEfforts: { low: "low", medium: "medium", high: "high", max: "max" }, extra: null },
  ],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

const deepseek = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [
    { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 65536, maxTokens: 8192, input: ["text"], reasoningEfforts: null, extra: null },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 65536, maxTokens: 8192, input: ["text"], reasoningEfforts: { low: "low", medium: "medium", high: "high" }, extra: null },
  ],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

const modelConfig = {
  defaultProvider: "spero-ai",
  defaultModel: "glm-5.2",
  defaultReasoningEffort: "max",
  providers: [spero, deepseek],
};

const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 2,
  entries: [
    { id: "glm-5.2", name: "GLM 5.2", family: "openai", context: 131072, maxTokens: 32768, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high", "max"], capabilities: ["text", "reasoning", "tools"] },
    { id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] },
  ],
};

const mock = {
  config: {
    minimize_to_tray_on_close: false,
    language: "en",
    dsh_admin_cap_domain: "",
    dsh_use_cap_domain: "",
    dsh_extra_allowed_logins: "",
    market_catalog_url: "",
  },
  dshStatus: {
    nodeAvailable: false,
    dshInstalled: false,
    dshVersion: null,
    supportedVersion: "0.1.1-rc.2",
    dshCompatible: false,
    dshVersionAboveSupported: false,
    pluginsInstalled: false,
    dshRunning: false,
    tailscaleInstalled: false,
    tailscaleOnline: false,
    hostname: null,
    localUrl: null,
    url: null,
    remoteUrlAccess: null,
    magicDnsEnabled: false,
    serveConfigured: false,
    autostartEnabled: false,
    error: null,
    readyTimeline: ["node", "install", "start", "ready"].map((id, index) => ({
      index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}`,
    })),
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } } });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ config, dshStatus, modelConfig, modelCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      let currentModelConfig = structuredClone(modelConfig);
      window.__auditSavedConfigs = [];
      window.__auditSavePending = false;
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => config,
        autostart_is_enabled: () => false,
        get_updater_config_health: () => ({ configured: true, message: "ready" }),
        check_update: () => ({ currentVersion: "0.4.0", availableVersion: null, hasUpdate: false, releaseNotes: null, message: null }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) => (remote ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] : ["node", "install", "start", "ready"]).map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
        model_config_load: () => structuredClone(currentModelConfig),
        model_config_save: ({ config }) => new Promise((resolve) => {
          window.__auditSavePending = true;
          setTimeout(() => {
            currentModelConfig = structuredClone(config);
            window.__auditSavedConfigs.push(structuredClone(config));
            window.__auditSavePending = false;
            resolve(null);
          }, 1200);
        }),
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({ ...modelCatalog, fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        model_remote_list: ({ baseUrl }) => baseUrl?.includes("deepseek") ? ["deepseek-chat", "deepseek-reasoner"] : ["glm-5.2"],
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
    await page.waitForFunction(() => document.querySelector('[data-testid="default-model-summary"]')?.textContent?.includes("Spero AI · glm-5.2"));

    const deepseekRow = page.locator('[data-route="deepseek"]');
    await deepseekRow.getByRole("button", { name: "Edit provider" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(850);

    const saveButton = dialog.getByRole("button", { name: "Save provider" });
    const closeCount = await dialog.getByRole("button", { name: "Close", exact: true }).count();
    const cancelCount = await dialog.getByRole("button", { name: "Cancel", exact: true }).count();
    const routeHintCount = await dialog.getByTestId("catalog-route-hint").count();
    const technicalSummaryCount = await dialog.getByText("deepseek · api.deepseek.com · openai-completions", { exact: true }).count();
    const saveEnabledBeforeChanges = await saveButton.isEnabled();
    console.log(`baseline: saveEnabledBeforeChanges=${saveEnabledBeforeChanges}; close=${closeCount}; cancel=${cancelCount}; technicalSummary=${technicalSummaryCount}; catalogHint=${routeHintCount}`);

    assert.equal(saveEnabledBeforeChanges, true);
    assert.equal(closeCount, 1);
    assert.equal(cancelCount, 1);
    assert.equal(routeHintCount, 1);
    assert.equal(technicalSummaryCount, 1);
    await page.screenshot({ path: resolve(OUT_DIR, "models-edit-provider-open.png"), fullPage: true });

    const displayName = dialog.getByRole("textbox", { name: "Display Name" });
    const apiKeyEnv = dialog.getByRole("textbox", { name: "API Key Env Var" });
    assert.equal(await displayName.inputValue(), "DeepSeek");
    assert.equal(await apiKeyEnv.inputValue(), "DEEPSEEK_API_KEY");
    await displayName.fill("DeepSeek Production");
    await apiKeyEnv.fill("DEEPSEEK_PROD_API_KEY");
    assert.equal(await saveButton.isEnabled(), true);
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(OUT_DIR, "models-edit-provider-edited.png"), fullPage: true });

    await saveButton.click();
    await page.waitForFunction(() => window.__auditSavePending === true);
    await page.waitForTimeout(300);
    assert.equal(await dialog.getAttribute("aria-busy"), "true");
    assert.equal(await dialog.getByRole("button", { name: "Saving…" }).isDisabled(), true);

    await page.waitForFunction(() => window.__auditSavedConfigs.length === 1);
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector('[data-route="deepseek"]')?.textContent?.includes("DeepSeek Production"));
    await page.waitForTimeout(800);

    const saved = await page.evaluate(() => window.__auditSavedConfigs.at(-1));
    const edited = saved.providers.find((provider) => provider.route === "deepseek");
    assert.ok(edited);
    assert.equal(edited.displayName, "DeepSeek Production");
    assert.equal(edited.apiKeyEnv, "DEEPSEEK_PROD_API_KEY");
    assert.equal(edited.baseURL, "https://api.deepseek.com/v1");
    assert.equal(edited.api, "openai-completions");
    assert.deepEqual(edited.models.map((model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);
    assert.equal(saved.defaultProvider, "spero-ai");
    assert.equal(saved.defaultModel, "glm-5.2");
    assert.equal(saved.defaultReasoningEffort, "max");
    const genericToast = page.getByText("Model configuration saved — changes take effect immediately", { exact: true });
    await genericToast.waitFor({ state: "visible" });
    console.log("baseline: saved edit preserved route/base/protocol/models/default; toast=generic");
    assert.equal(failures.length, 0, failures.join("\n"));

    await page.screenshot({ path: resolve(OUT_DIR, "models-edit-provider.png"), fullPage: true });
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-edit-provider.webm");
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
