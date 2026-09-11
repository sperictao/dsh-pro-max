// Models -> Edit provider -> Model settings -> Remove model UI audit capture.
// Scope: removing one selected model and persisting the provider only.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5206;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-remove-model");
const MODEL_ID = "deepseek-reasoner";

const deepseek = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [
    { id: "deepseek-chat", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null },
    { id: MODEL_ID, name: "Reasoner Preview", contextWindow: 131072, maxTokens: 32768, input: ["text", "image"], reasoningEfforts: { high: "high" }, extra: null },
  ],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};
const modelConfig = {
  defaultProvider: "deepseek",
  defaultModel: "deepseek-chat",
  defaultReasoningEffort: null,
  providers: [deepseek],
};
const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 1,
  entries: [
    { id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
    { id: MODEL_ID, name: "DeepSeek Reasoner", family: "openai", context: 65536, maxTokens: 8192, input: ["text", "image"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning", "vision", "pdf"] },
  ],
};
const appConfig = { minimize_to_tray_on_close: false, language: "en", dsh_admin_cap_domain: "", dsh_use_cap_domain: "", dsh_extra_allowed_logins: "", market_catalog_url: "" };
const dshStatus = {
  nodeAvailable: false, dshInstalled: false, dshVersion: null, supportedVersion: "0.1.1-rc.2",
  dshCompatible: false, dshVersionAboveSupported: false, pluginsInstalled: false, dshRunning: false,
  tailscaleInstalled: false, tailscaleOnline: false, hostname: null, localUrl: null, url: null,
  remoteUrlAccess: null, magicDnsEnabled: false, serveConfigured: false, autostartEnabled: false,
  error: null,
  readyTimeline: ["node", "install", "start", "ready"].map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
};

async function launchBrowser() {
  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
    try {
      return await chromium.launch({ headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [], ...opts });
    } catch {}
  }
  throw new Error("no browser available for UI capture");
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

    await page.addInitScript(({ appConfig, dshStatus, modelConfig, modelCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      let currentModelConfig = structuredClone(modelConfig);
      window.__auditSavedConfigs = [];
      window.__auditSavePending = false;
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => appConfig,
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
          }, 900);
        }),
        model_catalog_load: () => structuredClone(modelCatalog),
        model_catalog_refresh: () => ({ ...structuredClone(modelCatalog), fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => ({ models: ["deepseek-chat", "deepseek-reasoner"], fetchedAt: Math.floor(Date.now() / 1000) }),
        model_remote_list_with_headers: () => ["deepseek-chat", "deepseek-reasoner"],
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
    }, { appConfig, dshStatus, modelConfig, modelCatalog });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="default-model-summary"]')?.textContent?.includes("DeepSeek · deepseek-chat"));

    const providerRow = page.locator('[data-route="deepseek"]');
    await providerRow.getByRole("button", { name: "Edit provider" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(700);

    const settings = dialog.getByRole("list", { name: "Model settings" });
    const row = settings.locator(`[data-model-id="${MODEL_ID}"]`);
    await row.scrollIntoViewIfNeeded();
    const remove = row.getByRole("button", { name: "Remove model" });
    const save = dialog.getByRole("button", { name: "Save provider" });
    assert.equal(await save.isEnabled(), false);
    assert.equal(await settings.locator("[data-model-id]").count(), 2);
    await page.screenshot({ path: resolve(OUT_DIR, "models-remove-model-before.png"), fullPage: true });

    const removeText = (await remove.textContent())?.trim() ?? "";
    const removeTitle = await remove.getAttribute("title");
    const removeClass = await remove.getAttribute("class") ?? "";
    const destructive = removeClass.includes("text-destructive");
    assert.equal(removeTitle, "Remove model");
    assert.equal(destructive, true);
    console.log(`before: removeText=${JSON.stringify(removeText)}; removeTitle=${JSON.stringify(removeTitle)}; destructive=${destructive}; modelCount=${await settings.locator("[data-model-id]").count()}`);

    await remove.click();
    await row.waitFor({ state: "detached" });
    const candidate = dialog.getByRole("checkbox", { name: MODEL_ID });
    assert.equal(await candidate.isChecked(), false);
    assert.equal(await settings.locator("[data-model-id]").count(), 1);
    assert.equal(await save.isEnabled(), true);
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(OUT_DIR, "models-remove-model-removed.png"), fullPage: true });
    console.log(`after-remove: rowVisible=${await row.isVisible().catch(() => false)}; candidateChecked=${await candidate.isChecked()}; saveEnabled=${await save.isEnabled()}`);

    await save.click();
    await page.waitForFunction(() => window.__auditSavePending === true);
    await page.waitForFunction(() => window.__auditSavedConfigs.length === 1);
    await dialog.waitFor({ state: "detached" });
    await page.waitForTimeout(700);

    const saved = await page.evaluate(() => window.__auditSavedConfigs.at(-1));
    const savedProvider = saved.providers.find((provider) => provider.route === "deepseek");
    assert.ok(savedProvider);
    assert.equal(savedProvider.models.some((model) => model.id === MODEL_ID), false);
    assert.equal(savedProvider.models.some((model) => model.id === "deepseek-chat"), true);
    assert.equal(saved.defaultProvider, "deepseek");
    assert.equal(saved.defaultModel, "deepseek-chat");
    await page.getByText("Model configuration saved — changes take effect immediately", { exact: true }).waitFor({ state: "visible" });
    assert.equal(failures.length, 0, failures.join("\n"));

    await page.screenshot({ path: resolve(OUT_DIR, "models-remove-model.png"), fullPage: true });
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-remove-model.webm");
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
