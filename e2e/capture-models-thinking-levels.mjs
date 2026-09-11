// Models -> Edit provider -> Model settings -> Advanced -> Thinking levels UI audit.
// Scope: inherited catalog reasoning, explicit per-model overrides, wire spelling, persistence,
// restoration to inheritance, and the resulting default-reasoning validation.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5218;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-thinking-levels");
const MODEL_ID = "deepseek-reasoner";

const provider = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [
    { id: MODEL_ID, name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null },
  ],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};
const modelConfig = {
  defaultProvider: "deepseek",
  defaultModel: MODEL_ID,
  defaultReasoningEffort: "medium",
  providers: [provider],
};
const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 1,
  entries: [
    {
      id: MODEL_ID,
      name: "DeepSeek Reasoner",
      family: "openai",
      context: 65536,
      maxTokens: 8192,
      input: ["text"],
      reasoning: true,
      reasoningLevels: ["low", "medium", "high"],
      capabilities: ["text", "reasoning"],
    },
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

async function settlePointer(page) {
  await page.mouse.move(20, 20);
  await page.waitForTimeout(150);
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
      window.__auditCalls = [];
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => appConfig,
        autostart_is_enabled: () => false,
        get_updater_config_health: () => ({ configured: true, message: "ready" }),
        check_update: () => ({ currentVersion: "0.4.0", availableVersion: null, hasUpdate: false, releaseNotes: null, message: null }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) => (remote ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] : ["node", "install", "start", "ready"]).map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
        model_config_load: () => structuredClone(currentModelConfig),
        model_config_save: ({ config }) => { currentModelConfig = structuredClone(config); window.__auditSavedConfigs.push(structuredClone(config)); return null; },
        model_catalog_load: () => structuredClone(modelCatalog),
        model_catalog_refresh: () => ({ ...structuredClone(modelCatalog), fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => ({ models: ["deepseek-reasoner"], fetchedAt: Math.floor(Date.now() / 1000) }),
        model_remote_list_with_headers: () => ["deepseek-reasoner"],
        model_test_connection: () => { throw new Error("Thinking levels audit must not test the connection"); },
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
          window.__auditCalls.push({ command, args: args == null ? null : structuredClone(args) });
          if (command === "plugin:event|listen") return Promise.resolve(nextId++);
          if (command === "plugin:event|unlisten") return Promise.resolve(null);
          const handler = handlers[command];
          if (!handler) return Promise.reject(new Error(`capture mock: unhandled command "${command}"`));
          try {
            return Promise.resolve(handler(args));
          } catch (error) {
            return Promise.reject(error);
          }
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => callbacks.delete(id) };
    }, { appConfig, dshStatus, modelConfig, modelCatalog });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();
    const startUrl = page.url();
    const providerRow = page.locator('[data-route="deepseek"]');
    await providerRow.getByRole("button", { name: "Edit provider" }).click();
    let dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(700);

    let row = dialog.locator(`[data-model-id="${MODEL_ID}"]`);
    await row.getByRole("button", { name: "Advanced" }).click();
    let panel = row.getByTestId("model-advanced");
    await panel.waitFor({ state: "visible" });
    let thinking = panel.getByRole("group", { name: "Thinking levels" });
    let buttons = thinking.getByRole("button");
    assert.deepEqual(await buttons.evaluateAll((items) => items.map((item) => item.getAttribute("aria-pressed"))), ["false", "false", "false", "false", "false", "false", "false"]);
    let inherit = panel.getByTestId("thinking-levels-inherit");
    await inherit.waitFor({ state: "visible" });
    assert.equal((await inherit.textContent())?.replace(/\s+/g, " ").trim(), "Follow catalog · Low, Medium, High");
    assert.equal(await thinking.getAttribute("aria-describedby"), await inherit.getAttribute("id"));
    assert.equal(await panel.getByRole("textbox", { name: /Wire spelling for/ }).count(), 0);
    await settlePointer(page);
    await page.screenshot({ path: resolve(OUT_DIR, "models-thinking-levels-inherited.png"), fullPage: true });

    // One explicit override intentionally replaces inherited catalog levels with a one-level map.
    const high = thinking.getByRole("button", { name: "high", exact: true });
    await high.click();
    assert.equal(await high.getAttribute("aria-pressed"), "true");
    assert.equal(await panel.getByTestId("thinking-levels-inherit").count(), 0);
    const highSpelling = panel.getByRole("textbox", { name: "Wire spelling for high" });
    await highSpelling.waitFor({ state: "visible" });
    assert.equal(await highSpelling.inputValue(), "high");
    await highSpelling.fill("reasoner-high");
    await settlePointer(page);
    await page.screenshot({ path: resolve(OUT_DIR, "models-thinking-levels-explicit.png"), fullPage: true });

    let save = dialog.getByRole("button", { name: "Save provider" });
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__auditSavedConfigs.length === 1);
    let saved = await page.evaluate(() => window.__auditSavedConfigs.at(-1));
    let savedModel = saved.providers.find((item) => item.route === "deepseek").models.find((item) => item.id === "deepseek-reasoner");
    assert.deepEqual(savedModel.reasoningEfforts, { high: "reasoner-high" });
    // The explicit model map supports only High. ModelsView therefore removes the now-invalid
    // global Medium default instead of persisting a default this model cannot honor.
    assert.equal(saved.defaultReasoningEffort, null);

    // Reopen, verify wire spelling persisted, then remove the only explicit level.
    await providerRow.getByRole("button", { name: "Edit provider" }).click();
    dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(700);
    row = dialog.locator(`[data-model-id="${MODEL_ID}"]`);
    await row.getByRole("button", { name: "Advanced" }).click();
    panel = row.getByTestId("model-advanced");
    thinking = panel.getByRole("group", { name: "Thinking levels" });
    const reopenedHigh = thinking.getByRole("button", { name: "high", exact: true });
    assert.equal(await reopenedHigh.getAttribute("aria-pressed"), "true");
    assert.equal(await panel.getByRole("textbox", { name: "Wire spelling for high" }).inputValue(), "reasoner-high");
    await reopenedHigh.click();
    assert.equal(await reopenedHigh.getAttribute("aria-pressed"), "false");
    assert.equal(await panel.getByRole("textbox", { name: /Wire spelling for/ }).count(), 0);
    inherit = panel.getByTestId("thinking-levels-inherit");
    await inherit.waitFor({ state: "visible" });
    assert.equal((await inherit.textContent())?.replace(/\s+/g, " ").trim(), "Follow catalog · Low, Medium, High");
    assert.equal(await thinking.getAttribute("aria-describedby"), await inherit.getAttribute("id"));
    await settlePointer(page);
    await page.screenshot({ path: resolve(OUT_DIR, "models-thinking-levels-restored.png"), fullPage: true });

    save = dialog.getByRole("button", { name: "Save provider" });
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__auditSavedConfigs.length === 2);
    saved = await page.evaluate(() => window.__auditSavedConfigs.at(-1));
    savedModel = saved.providers.find((item) => item.route === "deepseek").models.find((item) => item.id === "deepseek-reasoner");
    assert.equal(savedModel.reasoningEfforts, null);
    // Restoring inheritance does not guess the user's former global default; it remains unset.
    assert.equal(saved.defaultReasoningEffort, null);
    assert.equal(page.url(), startUrl);

    const calls = await page.evaluate(() => window.__auditCalls);
    assert.equal(calls.filter((call) => call.command === "model_config_save").length, 2);
    assert.equal(calls.filter((call) => call.command === "model_test_connection").length, 0);
    assert.equal(failures.length, 0, failures.join("\n"));
    console.log("audit: inherit-hint=Low/Medium/High; explicit-high=custom-wire; incompatible-global-default=cleared; remove-last=inherit-hint-restored; saves=2");

    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-thinking-levels.webm");
    if (recorded !== stable) renameSync(recorded, stable);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((error) => { console.error(String(error?.stack ?? error)); process.exit(1); });
