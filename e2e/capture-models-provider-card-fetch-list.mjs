// Models -> Provider card -> Fetch list UI audit capture.
// Scope: main-page quick discovery only; verify loading state, serialized cards,
// success/error feedback, recovery, and zero navigation/config writes/connection tests.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5208;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-provider-card-fetch-list");

const providers = [
  {
    route: "primary-api",
    displayName: "Primary API",
    baseURL: "https://primary.example.com/v1",
    api: "openai-responses",
    apiKeyEnv: "PRIMARY_API_KEY",
    models: [
      { id: "primary-model", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null },
    ],
    headers: { "X-Title": "dsh-pro-max" },
    timeoutMs: null,
    reasoning: null,
    extra: null,
  },
  {
    route: "backup-api",
    displayName: "Backup API",
    baseURL: "https://backup.example.com/v1",
    api: "openai-completions",
    apiKeyEnv: "BACKUP_API_KEY",
    models: [
      { id: "backup-model", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null },
    ],
    headers: null,
    timeoutMs: null,
    reasoning: null,
    extra: null,
  },
];

const modelConfig = {
  defaultProvider: "primary-api",
  defaultModel: "primary-model",
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
          throw new Error("provider-card Fetch list must not save model configuration");
        },
        model_catalog_load: () => structuredClone(modelCatalog),
        model_catalog_refresh: () => ({
          ...structuredClone(modelCatalog),
          fetchedAt: Math.floor(Date.now() / 1000),
        }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        model_remote_list_with_headers: ({ baseUrl }) =>
          new Promise((resolve, reject) => {
            setTimeout(() => {
              if (baseUrl.includes("backup.example.com")) {
                reject("503 Service Unavailable");
                return;
              }
              resolve(["alpha", "beta", "gamma"]);
            }, 1100);
          }),
        model_test_connection: () => {
          throw new Error("provider-card Fetch list must not test the connection");
        },
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

    const primaryRow = page.locator('[data-route="primary-api"]');
    const backupRow = page.locator('[data-route="backup-api"]');
    await primaryRow.waitFor({ state: "visible" });
    await backupRow.waitFor({ state: "visible" });
    await page.waitForTimeout(700);
    const startUrl = page.url();
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-card-fetch-list-before.png"),
      fullPage: true,
    });

    const primaryFetch = primaryRow.getByRole("button", { name: "Fetch list" });
    const backupFetch = backupRow.getByRole("button", { name: "Fetch list" });
    assert.equal(await primaryFetch.isEnabled(), true);
    assert.equal(await backupFetch.isEnabled(), true);

    await primaryFetch.click();
    await primaryRow.getByRole("button", { name: "Loading models…" }).waitFor({ state: "visible" });
    assert.equal(await primaryRow.getAttribute("aria-busy"), "true");
    assert.equal(
      await backupFetch.isDisabled(),
      true,
      "other Provider-card Fetch actions must stay disabled while discovery is active",
    );
    await page.waitForTimeout(650);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-card-fetch-list-loading.png"),
      fullPage: true,
    });

    await page.getByText("Primary API · Models from this service: 3 models", { exact: true })
      .waitFor({ state: "visible" });
    await primaryRow.getByRole("button", { name: "Fetch list" }).waitFor({ state: "visible" });
    assert.equal(await primaryRow.getAttribute("aria-busy"), "false");
    assert.equal(await backupFetch.isEnabled(), true);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(page.url(), startUrl);
    await page.waitForTimeout(800);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-card-fetch-list-success.png"),
      fullPage: true,
    });

    await backupFetch.click();
    await backupRow.getByRole("button", { name: "Loading models…" }).waitFor({ state: "visible" });
    assert.equal(await backupRow.getAttribute("aria-busy"), "true");
    assert.equal(await primaryRow.getByRole("button", { name: "Fetch list" }).isDisabled(), true);

    await page.getByText("Backup API · 503 Service Unavailable", { exact: true })
      .waitFor({ state: "visible" });
    await backupRow.getByRole("button", { name: "Fetch list" }).waitFor({ state: "visible" });
    assert.equal(await backupRow.getAttribute("aria-busy"), "false");
    assert.equal(await primaryRow.getByRole("button", { name: "Fetch list" }).isEnabled(), true);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(page.url(), startUrl);
    await page.waitForTimeout(900);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-card-fetch-list-error.png"),
      fullPage: true,
    });

    const calls = await page.evaluate(() => window.__auditCalls);
    const remoteCalls = calls.filter((call) => call.command === "model_remote_list_with_headers");
    assert.equal(remoteCalls.length, 2);
    assert.deepEqual(
      remoteCalls.map((call) => call.args.baseUrl),
      ["https://primary.example.com/v1", "https://backup.example.com/v1"],
    );
    assert.equal(calls.filter((call) => call.command === "model_config_save").length, 0);
    assert.equal(calls.filter((call) => call.command === "model_test_connection").length, 0);
    assert.equal(failures.length, 0, failures.join("\n"));

    console.log(
      `audit: remoteCalls=${remoteCalls.length}; navigation=${page.url() === startUrl ? "none" : "changed"}; dialogs=0; saves=0; tests=0`,
    );
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-provider-card-fetch-list.webm");
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
