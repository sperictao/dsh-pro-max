// Models -> Edit provider -> ModelPanes -> fetch failure -> Retry UI audit capture.
// Scope: cached rows survive failure, Retry starts immediately, retry loading is clear,
// successful recovery replaces the remote rows, and no save/test/navigation occurs.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5213;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-fetch-retry");

const provider = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [
    {
      id: "deepseek-chat",
      name: "Pinned Chat",
      contextWindow: 64000,
      maxTokens: 8000,
      input: null,
      reasoningEfforts: null,
      extra: null,
    },
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
  providers: [provider],
};

const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 1,
  entries: [
    { id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "openai", context: 131072, maxTokens: 16384, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] },
  ],
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
      let remoteListCount = 0;
      const callbacks = new Map();
      window.__auditCalls = [];
      window.__auditRemoteListCount = 0;
      const cachedModels = ["deepseek-chat", "deepseek-reasoner"];
      const freshModels = ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro"];

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
        model_config_save: () => { throw new Error("Fetch retry audit must not save model configuration"); },
        model_catalog_load: () => structuredClone(modelCatalog),
        model_catalog_refresh: () => ({ ...structuredClone(modelCatalog), fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => ({ models: cachedModels, fetchedAt: 1 }),
        model_remote_list_with_headers: () => {
          remoteListCount += 1;
          window.__auditRemoteListCount = remoteListCount;
          if (remoteListCount === 1) {
            return new Promise((_, reject) => setTimeout(() => reject("503 Service Unavailable"), 650));
          }
          return new Promise((resolve) => setTimeout(() => resolve(freshModels), 850));
        },
        model_test_connection: () => { throw new Error("Fetch retry audit must not test the connection"); },
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

    const providerRow = page.locator('[data-route="deepseek"]');
    await providerRow.waitFor({ state: "visible" });
    await providerRow.getByRole("button", { name: "Edit provider" }).click();

    const dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    const list = dialog.getByRole("list", { name: "Models from this service" });
    const startUrl = page.url();

    await list.getByRole("checkbox", { name: "deepseek-chat", exact: true }).waitFor({ state: "visible" });
    assert.equal(await list.getByRole("checkbox", { name: "deepseek-chat", exact: true }).isChecked(), true);
    await page.waitForFunction(() => window.__auditRemoteListCount === 1);

    const alert = dialog.getByRole("alert");
    await alert.waitFor({ state: "visible" });
    assert.match((await alert.textContent()) ?? "", /503 Service Unavailable/);
    const retry = alert.getByRole("button", { name: "Retry" });
    assert.equal(await retry.isEnabled(), true);
    assert.equal(await list.getByRole("checkbox", { name: "deepseek-chat", exact: true }).count(), 1);
    assert.equal(await list.getByRole("checkbox", { name: "deepseek-reasoner", exact: true }).count(), 1);
    await page.waitForTimeout(650);
    await page.screenshot({ path: resolve(OUT_DIR, "models-fetch-retry-error.png"), fullPage: true });

    await retry.click();
    await page.waitForFunction(() => window.__auditRemoteListCount === 2, null, { timeout: 500 });
    const loading = dialog.getByRole("button", { name: "Loading models…" });
    await loading.waitFor({ state: "visible" });
    assert.equal(await loading.isDisabled(), true);
    assert.equal(await dialog.getByRole("alert").count(), 0);
    assert.equal(await list.getByRole("checkbox", { name: "deepseek-chat", exact: true }).count(), 1);
    await page.waitForTimeout(450);
    await page.screenshot({ path: resolve(OUT_DIR, "models-fetch-retry-loading.png"), fullPage: true });

    await list.getByRole("checkbox", { name: "deepseek-v4-pro", exact: true }).waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Fetch list" }).waitFor({ state: "visible" });
    assert.equal(await dialog.getByRole("alert").count(), 0);
    assert.equal(await list.getByRole("checkbox", { name: "deepseek-chat", exact: true }).isChecked(), true);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(page.url(), startUrl);
    await page.waitForTimeout(650);
    await page.screenshot({ path: resolve(OUT_DIR, "models-fetch-retry-recovered.png"), fullPage: true });

    const calls = await page.evaluate(() => window.__auditCalls);
    assert.equal(calls.filter((call) => call.command === "model_remote_list_with_headers").length, 2);
    assert.equal(calls.filter((call) => call.command === "model_config_save").length, 0);
    assert.equal(calls.filter((call) => call.command === "model_test_connection").length, 0);
    assert.equal(failures.length, 0, failures.join("\n"));

    console.log("audit: cachedRows=preserved; firstFetch=503; retry=immediate; retryLoading=visible; recovered=3 models; navigation=none; saves=0; tests=0");

    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-fetch-retry.webm");
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
