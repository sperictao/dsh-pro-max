// Models -> Provider card -> Test connection UI audit capture.
// Scope: main-page quick action only; verify testing state, serialized cards, success/error feedback, recovery, and zero navigation/config writes/model discovery.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5207;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-provider-card-test-connection");

const providers = [
  {
    route: "openai",
    displayName: "OpenAI",
    baseURL: null,
    api: null,
    apiKeyEnv: "OPENAI_API_KEY",
    models: [],
    headers: null,
    timeoutMs: null,
    reasoning: null,
    extra: null,
  },
  {
    route: "deepseek",
    displayName: "DeepSeek",
    baseURL: null,
    api: null,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [],
    headers: null,
    timeoutMs: null,
    reasoning: null,
    extra: null,
  },
];
const modelConfig = {
  defaultProvider: "openai",
  defaultModel: "gpt-5.4",
  defaultReasoningEffort: null,
  providers,
};
const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 2,
  entries: [],
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
        check_update: () => ({
          currentVersion: "0.4.0",
          availableVersion: null,
          hasUpdate: false,
          releaseNotes: null,
          message: null,
        }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) =>
          (remote
            ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"]
            : ["node", "install", "start", "ready"]
          ).map((id, index) => ({
            index,
            id,
            state: "pending",
            detail: null,
            problem: null,
            solution: null,
            titleKey: `step.${id}`,
          })),
        model_config_load: () => structuredClone(modelConfig),
        model_config_save: () => {
          throw new Error("provider-card connection test must not save model configuration");
        },
        model_catalog_load: () => structuredClone(modelCatalog),
        model_catalog_refresh: () => ({
          ...structuredClone(modelCatalog),
          fetchedAt: Math.floor(Date.now() / 1000),
        }),
        model_credential_describe: ({ names }) => Object.fromEntries(names.map((name) => [name, { configured: true, source: "file", writable: true }])),
        model_credential_set: () => ({ configured: true, source: "file", writable: true }),
        model_credential_unset: () => ({ configured: false, source: null, writable: true }),
        model_remote_cache_get: () => null,
        model_remote_list_with_headers: () => {
          throw new Error("provider-card connection test must not fetch model list");
        },
        model_test_connection: ({ apiKeyEnv }) =>
          new Promise((resolve, reject) => {
            setTimeout(() => {
              if (apiKeyEnv === "DEEPSEEK_API_KEY") reject("401 Unauthorized");
              else resolve(null);
            }, 1100);
          }),
        "plugin:app|version": () => "0.4.0",
        "plugin:notification|is_permission_granted": () => true,
      };
      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback: (callback) => {
          const id = nextId++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id) => callbacks.delete(id),
        runCallback: (id, data) => callbacks.get(id)?.(data),
        callbacks,
        invoke: (command, args) => {
          window.__auditCalls.push({ command, args: args == null ? null : structuredClone(args) });
          if (command === "plugin:event|listen") return Promise.resolve(nextId++);
          if (command === "plugin:event|unlisten") return Promise.resolve(null);
          const handler = handlers[command];
          if (!handler) return Promise.reject(new Error(`capture mock: unhandled command "${command}"`));
          return Promise.resolve(handler(args));
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event, id) => callbacks.delete(id),
      };
    }, { appConfig, dshStatus, modelConfig, modelCatalog });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();

    const openaiRow = page.locator('[data-route="openai"]');
    const deepseekRow = page.locator('[data-route="deepseek"]');
    await openaiRow.waitFor({ state: "visible" });
    await deepseekRow.waitFor({ state: "visible" });
    await page.waitForTimeout(700);
    const startUrl = page.url();
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-card-test-connection-before.png"),
      fullPage: true,
    });

    const openaiTest = openaiRow.getByRole("button", { name: "Test connection" });
    const deepseekTest = deepseekRow.getByRole("button", { name: "Test connection" });
    assert.equal(await openaiTest.isEnabled(), true);
    assert.equal(await deepseekTest.isEnabled(), true);

    await openaiTest.click();
    await openaiRow.getByRole("button", { name: "Testing…" }).waitFor({ state: "visible" });
    assert.equal(await openaiRow.getAttribute("aria-busy"), "true");
    assert.equal(await deepseekTest.isDisabled(), true, "other provider tests must stay disabled while one card test is active");
    await page.waitForTimeout(650);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-card-test-connection-testing.png"),
      fullPage: true,
    });

    await page.getByText("OpenAI · Connection successful", { exact: true }).waitFor({ state: "visible" });
    await openaiRow.getByRole("button", { name: "Test connection" }).waitFor({ state: "visible" });
    assert.equal(await openaiRow.getAttribute("aria-busy"), "false");
    assert.equal(await deepseekTest.isEnabled(), true);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(page.url(), startUrl);
    await page.waitForTimeout(800);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-card-test-connection-success.png"),
      fullPage: true,
    });

    await deepseekTest.click();
    await deepseekRow.getByRole("button", { name: "Testing…" }).waitFor({ state: "visible" });
    assert.equal(await deepseekRow.getAttribute("aria-busy"), "true");
    assert.equal(await openaiRow.getByRole("button", { name: "Test connection" }).isDisabled(), true);

    await page.getByText("DeepSeek · 401 Unauthorized", { exact: true }).waitFor({ state: "visible" });
    await deepseekRow.getByRole("button", { name: "Test connection" }).waitFor({ state: "visible" });
    assert.equal(await deepseekRow.getAttribute("aria-busy"), "false");
    assert.equal(await openaiRow.getByRole("button", { name: "Test connection" }).isEnabled(), true);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(page.url(), startUrl);
    await page.waitForTimeout(900);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-card-test-connection-error.png"),
      fullPage: true,
    });

    const calls = await page.evaluate(() => window.__auditCalls);
    const testCalls = calls.filter((call) => call.command === "model_test_connection");
    assert.equal(testCalls.length, 2);
    assert.deepEqual(testCalls.map((call) => call.args.apiKeyEnv), ["OPENAI_API_KEY", "DEEPSEEK_API_KEY"]);
    assert.equal(calls.filter((call) => call.command === "model_config_save").length, 0);
    assert.equal(calls.filter((call) => call.command === "model_remote_list_with_headers").length, 0);
    assert.equal(failures.length, 0, failures.join("\n"));

    console.log(`audit: testCalls=${testCalls.length}; navigation=${page.url() === startUrl ? "none" : "changed"}; dialogs=0`);
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-provider-card-test-connection.webm");
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
