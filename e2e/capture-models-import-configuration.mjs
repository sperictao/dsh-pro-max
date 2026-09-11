// Import configuration UI audit capture.
// Scope: open Models, scan local provider declarations, review safe defaults and
// literal-key handling, import selected entries, and verify the main view refreshes.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5193;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-import-configuration");

const importGroups = [
  {
    source: "claude-code",
    entries: [{ key: "claude-code:anthropic", route: "anthropic", name: "Anthropic", baseURL: "https://api.anthropic.com", api: "anthropic-messages", apiKeyEnv: "ANTHROPIC_API_KEY", credential: "env", models: ["claude-sonnet-4-5"] }],
  },
  {
    source: "codex",
    entries: [{ key: "codex:openai", route: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1", api: "openai-responses", apiKeyEnv: null, credential: "literal", models: ["gpt-5.6"] }],
  },
  {
    source: "opencode",
    entries: [{ key: "opencode:deepseek", route: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", api: "openai-completions", apiKeyEnv: "DEEPSEEK_API_KEY", credential: "env", models: ["deepseek-chat"] }],
  },
  { source: "pi", entries: [] },
  {
    source: "cc-switch",
    entries: [{ key: "cc-switch:local", route: "local-proxy", name: "Local Proxy", baseURL: "http://127.0.0.1:8317/v1", api: "openai-completions", apiKeyEnv: null, credential: "none", models: ["local-model"] }],
  },
];

const initialProviders = [
  {
    route: "spero-ai", displayName: "Spero AI", baseURL: "https://proxy.example.com/v1", api: "openai-responses", apiKeyEnv: "SPERO_AI_API_KEY",
    models: [{ id: "glm-5.2", name: "GLM 5.2", contextWindow: 131072, maxTokens: 32768, input: ["text"], reasoningEfforts: { low: "low", medium: "medium", high: "high", max: "max" }, extra: null }],
    headers: null, timeoutMs: null, reasoning: null, extra: null,
  },
];

const importedProviders = [
  ...initialProviders,
  {
    route: "anthropic", displayName: "Anthropic", baseURL: "https://api.anthropic.com", api: "anthropic-messages", apiKeyEnv: "ANTHROPIC_API_KEY",
    models: [{ id: "claude-sonnet-4-5", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }],
    headers: null, timeoutMs: null, reasoning: null, extra: null,
  },
  {
    route: "deepseek", displayName: "DeepSeek", baseURL: "https://api.deepseek.com/v1", api: "openai-completions", apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [{ id: "deepseek-chat", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }],
    headers: null, timeoutMs: null, reasoning: null, extra: null,
  },
  {
    route: "local-proxy", displayName: "Local Proxy", baseURL: "http://127.0.0.1:8317/v1", api: "openai-completions", apiKeyEnv: null,
    models: [{ id: "local-model", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }],
    headers: null, timeoutMs: null, reasoning: null, extra: null,
  },
];

const mock = {
  config: { minimize_to_tray_on_close: false, language: "en", dsh_admin_cap_domain: "", dsh_use_cap_domain: "", dsh_extra_allowed_logins: "", market_catalog_url: "" },
  dshStatus: {
    nodeAvailable: false, dshInstalled: false, dshVersion: null, supportedVersion: "0.1.1-rc.2", dshCompatible: false, dshVersionAboveSupported: false,
    pluginsInstalled: false, dshRunning: false, tailscaleInstalled: false, tailscaleOnline: false, hostname: null, localUrl: null, url: null,
    remoteUrlAccess: null, magicDnsEnabled: false, serveConfigured: false, autostartEnabled: false, error: null,
    readyTimeline: ["node", "install", "start", "ready"].map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
  },
  modelConfig: { defaultProvider: "spero-ai", defaultModel: "glm-5.2", defaultReasoningEffort: "high", providers: initialProviders },
  modelCatalog: {
    fetchedAt: Math.floor(Date.now() / 1000), providerCount: 1,
    entries: [{ id: "glm-5.2", name: "GLM 5.2", family: "openai", context: 131072, maxTokens: 32768, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high", "max"], capabilities: ["text", "reasoning", "tools"] }],
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 960 } } });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ config, dshStatus, modelConfig, modelCatalog, importGroups, importedProviders }) => {
      let nextId = 1;
      const callbacks = new Map();
      window.__auditImportKeys = [];
      let currentModelConfig = structuredClone(modelConfig);
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => config,
        autostart_is_enabled: () => false,
        get_updater_config_health: () => ({ configured: true, message: "ready" }),
        check_update: () => ({ currentVersion: "0.4.0", availableVersion: null, hasUpdate: false, releaseNotes: null, message: null }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) => (remote ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] : ["node", "install", "start", "ready"]).map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
        model_config_load: () => structuredClone(currentModelConfig),
        model_config_save: ({ config }) => { currentModelConfig = structuredClone(config); return null; },
        model_config_import_scan: () => new Promise((resolve) => setTimeout(() => resolve(structuredClone(importGroups)), 700)),
        model_config_import_run: ({ keys }) => new Promise((resolve) => setTimeout(() => {
          window.__auditImportKeys = [...keys];
          currentModelConfig = { ...currentModelConfig, providers: structuredClone(importedProviders) };
          resolve({ imported: keys.length, skipped: 0, failed: 0, literal: keys.includes("codex:openai") ? 1 : 0 });
        }, 900)),
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({ ...modelCatalog, fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
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
    }, { ...mock, importGroups, importedProviders });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();
    await page.getByRole("button", { name: "Import configuration" }).waitFor({ state: "visible" });
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Import configuration" }).click();

    const dialog = page.getByRole("dialog", { name: "Import provider configuration" });
    await dialog.waitFor({ state: "visible" });
    await page.getByText("Scanning…").waitFor({ state: "visible" });
    await page.getByText("Providers found: 4").waitFor({ state: "visible" });
    await page.waitForTimeout(1500);

    assert.equal(await dialog.getByRole("checkbox", { name: "claude-code:anthropic" }).isChecked(), true);
    assert.equal(await dialog.getByRole("checkbox", { name: "opencode:deepseek" }).isChecked(), true);
    assert.equal(await dialog.getByRole("checkbox", { name: "cc-switch:local" }).isChecked(), true);
    assert.equal(await dialog.getByRole("checkbox", { name: "codex:openai" }).isChecked(), false);
    assert.equal(await dialog.getByText("Pi", { exact: true }).count(), 0);
    await dialog.getByText("Literal key — not imported").waitFor({ state: "visible" });
    assert.equal(await dialog.getByText(/selected entries carry literal keys/).count(), 0);

    const importButton = dialog.getByRole("button", { name: "Import selected (3)" });
    await importButton.click();
    await page.getByRole("button", { name: "Importing…" }).waitFor({ state: "visible" });
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("Anthropic").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__auditImportKeys.length === 3);
    await page.waitForTimeout(1500);

    const keys = await page.evaluate(() => window.__auditImportKeys);
    assert.deepEqual(new Set(keys), new Set(["claude-code:anthropic", "opencode:deepseek", "cc-switch:local"]));
    assert.equal(failures.length, 0, failures.join("\n"));

    await page.screenshot({ path: resolve(OUT_DIR, "models-import-configuration.png"), fullPage: true });
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-import-configuration.webm");
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
