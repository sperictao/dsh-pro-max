// Fetch list UI audit capture.
// Scope: Models -> Add provider -> DeepSeek -> inspect pre-credential Fetch list state -> add credential -> automatic discovery -> manual Fetch list refresh.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-fetch-list");

const initialProvider = {
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
  defaultReasoningEffort: "high",
  providers: [initialProvider],
};

const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 2,
  entries: [
    { id: "glm-5.2", name: "GLM 5.2", family: "openai", context: 131072, maxTokens: 32768, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high", "max"], capabilities: ["text", "reasoning", "tools"] },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", family: "openai", context: 131072, maxTokens: 16384, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "openai", context: 131072, maxTokens: 16384, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] },
    { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro 0813", family: "openai", context: 131072, maxTokens: 16384, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] },
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 720 }, recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 720 } } });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ config, dshStatus, modelConfig, modelCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      let currentModelConfig = structuredClone(modelConfig);
      let remoteListCount = 0;
      window.__auditSavedConfigs = [];
      window.__auditCalls = [];
      window.__auditRemoteListCount = 0;
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => config,
        autostart_is_enabled: () => false,
        get_updater_config_health: () => ({ configured: true, message: "ready" }),
        check_update: () => ({ currentVersion: "0.4.0", availableVersion: null, hasUpdate: false, releaseNotes: null, message: null }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) => (remote ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] : ["node", "install", "start", "ready"]).map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
        model_config_load: () => structuredClone(currentModelConfig),
        model_config_save: ({ config }) => { currentModelConfig = structuredClone(config); window.__auditSavedConfigs.push(structuredClone(config)); return null; },
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({ ...modelCatalog, fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        model_remote_list_with_headers: ({ baseUrl }) => new Promise((resolve) => {
          remoteListCount += 1;
          window.__auditRemoteListCount = remoteListCount;
          const models = remoteListCount === 1
            ? ["deepseek-v4-flash", "deepseek-v4-pro"]
            : ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-pro-0813"];
          setTimeout(() => resolve(baseUrl.includes("api.deepseek.com") ? models : []), 700);
        }),
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
          window.__auditCalls.push({ command, args: args == null ? null : structuredClone(args) });
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
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Add provider" }).first().click();

    const dialog = page.getByRole("dialog", { name: "Add provider" });
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(650);

    const service = dialog.getByTestId("preset-input");
    await service.fill("deepseek");
    await dialog.getByRole("option", { name: /DeepSeek deepseek/i }).click();
    await page.waitForTimeout(800);

    const fetchButton = dialog.getByRole("button", { name: "Fetch list" });
    const modelList = dialog.getByRole("list", { name: "Models from this service" });
    assert.equal(await fetchButton.isEnabled(), false, "Fetch list should remain disabled until a known provider has explicit credentials");
    assert.equal(await dialog.getByText("Enter a base URL to load models.", { exact: true }).count(), 0, "A preset base URL must not produce a missing-URL hint");
    assert.equal(await modelList.getByRole("checkbox", { name: "glm-5.2", exact: true }).count(), 0, "Known-provider fallback must not mix unrelated same-protocol catalog models");
    assert.equal(await modelList.getByRole("checkbox", { name: "deepseek-v4-pro", exact: true }).count(), 1, "DeepSeek preset models should remain available before live discovery");
    await page.screenshot({ path: resolve(OUT_DIR, "models-fetch-list-prerequisite.png"), fullPage: true });

    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(() => window.__auditRemoteListCount), 0, "No remote discovery should start before credentials are supplied");
    console.log("after: preCredentialEnabled=false; remoteCalls=0; misleadingHint=false; unrelatedCatalogModel=false");

    await dialog.getByLabel("API Key Env Var").fill("DEEPSEEK_API_KEY");
    await page.waitForFunction(() => window.__auditRemoteListCount === 1);
    await modelList.getByRole("checkbox", { name: "deepseek-v4-flash", exact: true }).waitFor({ state: "visible" });
    await modelList.getByRole("checkbox", { name: "deepseek-v4-pro", exact: true }).waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Fetch list" }).waitFor({ state: "visible" });
    assert.equal(await fetchButton.isEnabled(), true, "Fetch list should enable after credentialed discovery is ready");
    await page.waitForTimeout(650);

    await fetchButton.click();
    await dialog.getByRole("button", { name: "Loading models…" }).waitFor({ state: "visible" });
    await modelList.getByRole("checkbox", { name: "deepseek-v4-pro-0813", exact: true }).waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Fetch list" }).waitFor({ state: "visible" });
    await page.waitForTimeout(800);

    const calls = await page.evaluate(() => window.__auditCalls);
    const remoteCalls = calls.filter((call) => call.command === "model_remote_list_with_headers");
    assert.equal(remoteCalls.length, 2, "credentialed auto discovery plus one manual refresh should make two remote calls");
    assert.equal(calls.filter((call) => call.command === "model_config_save").length, 0, "Fetch list must not save model configuration");
    assert.equal(failures.length, 0, failures.join("\n"));

    await page.screenshot({ path: resolve(OUT_DIR, "models-fetch-list.png"), fullPage: true });
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-fetch-list.webm");
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