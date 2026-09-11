// Models -> Edit provider -> Advanced settings -> Headers editor UI audit.
// First-pass audit records duplicate header casing and partial JSON-import behavior.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5217;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-provider-headers");

const provider = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [{ id: "deepseek-chat", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }],
  headers: { "X-Title": "original" },
  timeoutMs: null,
  reasoning: null,
  extra: null,
};
const modelConfig = { defaultProvider: "deepseek", defaultModel: "deepseek-chat", defaultReasoningEffort: null, providers: [provider] };
const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 1,
  entries: [{ id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] }],
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
        model_remote_cache_get: () => ({ models: ["deepseek-chat"], fetchedAt: Math.floor(Date.now() / 1000) }),
        model_remote_list_with_headers: () => ["deepseek-chat"],
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
    const edit = page.locator('[data-route="deepseek"]').getByRole("button", { name: "Edit provider" });
    await edit.click();
    const dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(700);
    const advancedButton = dialog.getByRole("button", { name: "Advanced settings" });
    await advancedButton.click();
    const advanced = dialog.getByTestId("provider-advanced");
    const editor = advanced.getByTestId("headers-editor");
    await editor.waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(OUT_DIR, "models-provider-headers-before.png"), fullPage: true });

    // Existing behavior: a case-only duplicate remains as a second visible row and a second persisted key.
    await editor.getByRole("button", { name: "Add header" }).click();
    const names = editor.getByLabel("Header name");
    const values = editor.getByLabel("Header value");
    assert.equal(await names.count(), 2);
    await names.nth(1).fill("x-title");
    await values.nth(1).fill("duplicate");
    await page.screenshot({ path: resolve(OUT_DIR, "models-provider-headers-duplicate.png"), fullPage: true });

    // Existing behavior: non-string JSON values are silently skipped while valid siblings are applied.
    await editor.getByRole("button", { name: "Import JSON" }).click();
    await editor.getByLabel("Headers JSON").fill(JSON.stringify({ "X-Client-Name": "audit", Retries: 3, Authorization: "Bearer literal-secret" }));
    await editor.getByRole("button", { name: "Apply" }).click();
    await editor.getByRole("alert").waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(OUT_DIR, "models-provider-headers-json.png"), fullPage: true });

    // Provider Advanced is a focused overlay; collapse it before using the dialog footer.
    await advancedButton.click();
    await advanced.waitFor({ state: "detached" });
    const save = dialog.getByRole("button", { name: "Save provider" });
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__auditSavedConfigs.length === 1);
    const saved = await page.evaluate(() => window.__auditSavedConfigs[0]);
    const savedProvider = saved.providers.find((item) => item.route === "deepseek");
    assert.deepEqual(savedProvider.headers, { "X-Title": "original", "x-title": "duplicate", "X-Client-Name": "audit" });
    assert.equal(Object.prototype.hasOwnProperty.call(savedProvider.headers, "Retries"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(savedProvider.headers, "Authorization"), false);
    assert.equal(failures.length, 0, failures.join("\n"));
    await page.screenshot({ path: resolve(OUT_DIR, "models-provider-headers-saved.png"), fullPage: true });

    console.log("audit-current: duplicate-case-keys=persisted; non-string-json=silently-skipped; reserved=visible-ignored");
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-provider-headers.webm");
    if (recorded !== stable) renameSync(recorded, stable);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((error) => { console.error(String(error?.stack ?? error)); process.exit(1); });
