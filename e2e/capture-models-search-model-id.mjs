// Models -> Edit provider -> ModelPanes -> Search model ID UI audit capture.
// Scope: search/filter feedback only; verify ID-only matching, live result count,
// empty-state Select all disabling, Escape recovery, virtual-list reset, and zero writes/tests/navigation.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5210;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-search-model-id");

const remoteModels = [
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-v4-pro",
  "deepseek-v4-pro-0813",
  "deepseek-v4-flash",
  "coder-lite",
];

const provider = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [
    {
      id: "deepseek-chat",
      name: null,
      contextWindow: null,
      maxTokens: null,
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
    { id: "deepseek-v4-pro", name: "DeepSeek Pro", family: "openai", context: 131072, maxTokens: 16384, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] },
    { id: "deepseek-v4-pro-0813", name: "DeepSeek Pro August", family: "openai", context: 131072, maxTokens: 16384, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] },
    { id: "deepseek-v4-flash", name: "Friendly Alias", family: "openai", context: 131072, maxTokens: 16384, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
    { id: "coder-lite", name: "Coder Lite", family: "openai", context: 32768, maxTokens: 4096, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
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

    await page.addInitScript(({ appConfig, dshStatus, modelConfig, modelCatalog, remoteModels }) => {
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
          throw new Error("Search model ID must not save model configuration");
        },
        model_catalog_load: () => structuredClone(modelCatalog),
        model_catalog_refresh: () => ({
          ...structuredClone(modelCatalog),
          fetchedAt: Math.floor(Date.now() / 1000),
        }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        model_remote_list_with_headers: () => new Promise((resolve) => setTimeout(() => resolve(remoteModels), 250)),
        model_test_connection: () => {
          throw new Error("Search model ID must not test the connection");
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
    }, { appConfig, dshStatus, modelConfig, modelCatalog, remoteModels });

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
    await list.getByRole("checkbox", { name: "deepseek-v4-pro-0813", exact: true }).waitFor({ state: "visible" });
    await page.waitForTimeout(650);

    const startUrl = page.url();
    const search = dialog.getByRole("searchbox", { name: "Search model ID…" });
    assert.equal(await search.getAttribute("type"), "search");
    assert.equal(await list.getAttribute("data-total-count"), String(remoteModels.length));
    await page.screenshot({
      path: resolve(OUT_DIR, "models-search-model-id-before.png"),
      fullPage: true,
    });

    await search.fill("PRO");
    await dialog.getByRole("status").waitFor({ state: "visible" });
    assert.equal(await dialog.getByRole("status").textContent(), "2 models");
    assert.equal(await list.getAttribute("data-total-count"), "2");
    assert.equal(await list.getByRole("checkbox", { name: "deepseek-v4-pro", exact: true }).count(), 1);
    assert.equal(await list.getByRole("checkbox", { name: "deepseek-v4-pro-0813", exact: true }).count(), 1);
    assert.equal(await list.getByRole("checkbox", { name: "deepseek-v4-flash", exact: true }).count(), 0);
    assert.equal(await dialog.getByRole("checkbox", { name: "Select all · 2 models" }).isEnabled(), true);
    await page.waitForTimeout(800);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-search-model-id-filtered.png"),
      fullPage: true,
    });

    await search.press("Escape");
    assert.equal(await search.inputValue(), "");
    assert.equal(await list.getAttribute("data-total-count"), String(remoteModels.length));
    assert.equal(await dialog.getByRole("status").count(), 0);
    assert.equal(await list.getByRole("checkbox", { name: "deepseek-chat", exact: true }).count(), 1);

    await search.fill("Friendly Alias");
    await dialog.getByText("No matching models", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await dialog.getByRole("status").textContent(), "0 models");
    assert.equal(await list.getAttribute("data-total-count"), "0");
    assert.equal(await dialog.getByRole("checkbox", { name: "Select all · 0 models" }).isDisabled(), true);
    assert.equal(await list.getByRole("checkbox").count(), 0);
    await page.waitForTimeout(800);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-search-model-id-empty.png"),
      fullPage: true,
    });

    await search.press("Escape");
    assert.equal(await search.inputValue(), "");
    assert.equal(await list.getAttribute("data-total-count"), String(remoteModels.length));
    assert.equal(await dialog.getByRole("status").count(), 0);
    assert.equal(await page.url(), startUrl);
    assert.equal(await dialog.isVisible(), true);
    await page.waitForTimeout(700);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-search-model-id-cleared.png"),
      fullPage: true,
    });

    const calls = await page.evaluate(() => window.__auditCalls);
    assert.equal(calls.filter((call) => call.command === "model_config_save").length, 0);
    assert.equal(calls.filter((call) => call.command === "model_test_connection").length, 0);
    assert.equal(failures.length, 0, failures.join("\n"));

    console.log(
      `audit: searchType=search; filtered=2; displayNameOnly=0; emptySelectAll=disabled; escape=restored; navigation=${page.url() === startUrl ? "none" : "changed"}; saves=0; tests=0`,
    );

    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-search-model-id.webm");
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
