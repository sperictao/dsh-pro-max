// Models -> Add provider -> Service picker search/keyboard UI audit capture.
// Scope: filtered search, neutral Enter, ArrowDown active option, Escape closes only popup,
// then keyboard selection of the filtered provider. No save/test/navigation is allowed.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5214;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-service-picker");

const provider = {
  route: "spero-ai",
  displayName: "Spero AI",
  baseURL: "https://proxy.example.com/v1",
  api: "openai-responses",
  apiKeyEnv: "SPERO_AI_API_KEY",
  models: [{ id: "glm-5.2", name: "GLM 5.2", contextWindow: 131072, maxTokens: 32768, input: ["text"], reasoningEfforts: null, extra: null }],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

const modelConfig = {
  defaultProvider: "spero-ai",
  defaultModel: "glm-5.2",
  defaultReasoningEffort: null,
  providers: [provider],
};

const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 1,
  entries: [{ id: "glm-5.2", name: "GLM 5.2", family: "openai", context: 131072, maxTokens: 32768, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] }],
};

const appConfig = {
  minimize_to_tray_on_close: false,
  language: "en",
  dsh_admin_cap_domain: "",
  dsh_use_cap_domain: "",
  dsh_extra_allowed_logins: "",
  market_catalog_url: "",
};

const dshStatus = {
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
    index,
    id,
    state: "pending",
    detail: null,
    problem: null,
    solution: null,
    titleKey: `step.${id}`,
  })),
};

async function launchBrowser() {
  const attempts = [{ channel: "chrome" }, { channel: "msedge" }, {}];
  const failures = [];
  for (const opts of attempts) {
    try {
      return await chromium.launch({
        headless: true,
        args: process.platform === "linux" ? ["--no-sandbox"] : [],
        ...opts,
      });
    } catch (error) {
      failures.push(`${opts.channel ?? "bundled chromium"}: ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }
  throw new Error(`no browser available for UI capture\n${failures.join("\n")}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await createServer({
    root: ROOT,
    logLevel: "error",
    server: { host: "127.0.0.1", port: PORT, strictPort: true },
  });
  await server.listen();
  const browser = await launchBrowser();

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 760 },
      recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 760 } },
    });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ appConfig, dshStatus, modelConfig, modelCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      window.__auditCalls = [];
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => appConfig,
        autostart_is_enabled: () => false,
        get_updater_config_health: () => ({ configured: true, message: "ready" }),
        check_update: () => ({ currentVersion: "0.4.0", availableVersion: null, hasUpdate: false, releaseNotes: null, message: null }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) =>
          (remote ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] : ["node", "install", "start", "ready"]).map((id, index) => ({
            index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}`,
          })),
        model_config_load: () => structuredClone(modelConfig),
        model_config_save: () => { throw new Error("Service picker audit must not save model configuration"); },
        model_catalog_load: () => structuredClone(modelCatalog),
        model_catalog_refresh: () => ({ ...structuredClone(modelCatalog), fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        model_remote_list_with_headers: () => [],
        model_test_connection: () => { throw new Error("Service picker audit must not test the connection"); },
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
    await page.getByRole("button", { name: "Add provider" }).first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Add provider" }).first().click();

    const dialog = page.getByRole("dialog", { name: "Add provider" });
    await dialog.waitFor({ state: "visible" });
    const service = dialog.getByRole("combobox", { name: "Service" });
    const startUrl = page.url();

    await service.click();
    let picker = dialog.getByRole("listbox", { name: "Choose a service or custom endpoint" });
    await picker.waitFor({ state: "visible" });
    assert.equal(await service.getAttribute("aria-expanded"), "true");
    assert.equal(await service.getAttribute("aria-controls"), "provider-preset-options");
    assert.equal(await service.getAttribute("aria-activedescendant"), null);
    assert.equal(await picker.getByRole("option", { name: /Custom endpoint/i }).getAttribute("aria-selected"), "false");
    await page.screenshot({ path: resolve(OUT_DIR, "models-service-picker-open.png"), fullPage: true });

    await service.fill("deepseek");
    picker = dialog.getByRole("listbox", { name: "Choose a service or custom endpoint" });
    const custom = picker.getByRole("option", { name: /Custom endpoint/i });
    const deepseek = picker.getByRole("option", { name: /DeepSeek deepseek/i });
    await deepseek.waitFor({ state: "visible" });
    assert.equal(await custom.getAttribute("aria-selected"), "false");
    assert.equal(await deepseek.getAttribute("aria-selected"), "false");
    assert.equal(await service.getAttribute("aria-activedescendant"), null);
    await page.screenshot({ path: resolve(OUT_DIR, "models-service-picker-filtered.png"), fullPage: true });

    await service.press("Enter");
    assert.equal(await service.inputValue(), "deepseek");
    assert.equal(await dialog.getByLabel("API Key Env Var").count(), 0);
    assert.equal(await dialog.getByRole("listbox").count(), 1);

    await service.press("ArrowDown");
    assert.equal(await deepseek.getAttribute("aria-selected"), "true");
    assert.equal(await service.getAttribute("aria-activedescendant"), "provider-preset-deepseek");
    await page.screenshot({ path: resolve(OUT_DIR, "models-service-picker-highlighted.png"), fullPage: true });

    await service.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await dialog.getByRole("listbox").count(), 0);
    assert.equal(await service.getAttribute("aria-expanded"), "false");
    assert.equal(await service.getAttribute("aria-activedescendant"), null);
    assert.equal(page.url(), startUrl);
    await page.screenshot({ path: resolve(OUT_DIR, "models-service-picker-escape.png"), fullPage: true });

    await service.press("ArrowDown");
    picker = dialog.getByRole("listbox", { name: "Choose a service or custom endpoint" });
    await picker.waitFor({ state: "visible" });
    const reopenedDeepseek = picker.getByRole("option", { name: /DeepSeek deepseek/i });
    assert.equal(await reopenedDeepseek.getAttribute("aria-selected"), "true");
    await service.press("Enter");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "API Key Env Var");
    assert.equal(await service.inputValue(), "DeepSeek");
    assert.equal(await dialog.getByRole("listbox").count(), 0);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(page.url(), startUrl);
    await page.screenshot({ path: resolve(OUT_DIR, "models-service-picker-selected.png"), fullPage: true });

    const calls = await page.evaluate(() => window.__auditCalls);
    assert.equal(calls.filter((call) => call.command === "model_config_save").length, 0);
    assert.equal(calls.filter((call) => call.command === "model_test_connection").length, 0);
    assert.equal(calls.filter((call) => call.command === "model_remote_list_with_headers").length, 0);
    assert.equal(failures.length, 0, failures.join("\n"));

    console.log("audit: neutralEnter=no-op; arrowDown=DeepSeek; escape=picker-only; selected=DeepSeek; navigation=none; saves=0; tests=0; remoteFetch=0");

    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-service-picker.webm");
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
