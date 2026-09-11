// Provider row -> Remove provider UI audit capture.
// Scope: remove the current default provider, inspect confirmation and in-flight feedback,
// then verify the persisted provider list and automatic default fallback.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5201;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-remove-provider");

const spero = {
  route: "spero-ai",
  displayName: "Spero AI",
  baseURL: "https://proxy.example.com/v1",
  api: "openai-responses",
  apiKeyEnv: "SPERO_AI_API_KEY",
  models: [
    { id: "glm-5.2", name: "GLM 5.2", contextWindow: 131072, maxTokens: 32768, input: ["text"], reasoningEfforts: { low: "low", medium: "medium", high: "high", max: "max" }, extra: null },
  ],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

const deepseek = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [
    { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 65536, maxTokens: 8192, input: ["text"], reasoningEfforts: null, extra: null },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 65536, maxTokens: 8192, input: ["text"], reasoningEfforts: { low: "low", medium: "medium", high: "high" }, extra: null },
  ],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};

const modelConfig = {
  defaultProvider: "spero-ai",
  defaultModel: "glm-5.2",
  defaultReasoningEffort: "max",
  providers: [spero, deepseek],
};

const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 2,
  entries: [
    { id: "glm-5.2", name: "GLM 5.2", family: "openai", context: 131072, maxTokens: 32768, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high", "max"], capabilities: ["text", "reasoning", "tools"] },
    { id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] },
  ],
};

const mock = {
  config: {
    minimize_to_tray_on_close: false,
    language: "en",
    dsh_admin_cap_domain: "",
    dsh_use_cap_domain: "",
    dsh_extra_allowed_logins: "",
    market_catalog_url: "",
  },
  dshStatus: {
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
      index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}`,
    })),
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 820 }, recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 820 } } });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ config, dshStatus, modelConfig, modelCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      let currentModelConfig = structuredClone(modelConfig);
      window.__auditSavedConfigs = [];
      window.__auditSavePending = false;
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => config,
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
          }, 1400);
        }),
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({ ...modelCatalog, fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        model_test_connection: () => null,
        model_remote_list: () => ["mock-model"],
        model_remote_list_with_headers: () => ["mock-model"],
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
    }, { ...mock, modelConfig, modelCatalog });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();
    const summary = page.getByTestId("default-model-summary");
    await summary.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('[data-testid="default-model-summary"]')?.textContent?.includes("Spero AI · glm-5.2"));
    await page.waitForTimeout(850);

    const speroRow = page.locator('[data-route="spero-ai"]');
    const deepseekRow = page.locator('[data-route="deepseek"]');
    const remove = speroRow.getByRole("button", { name: "Remove provider" });
    await remove.waitFor({ state: "visible" });
    assert.equal(await remove.isEnabled(), true);
    assert.equal(await speroRow.getByText("default", { exact: true }).count(), 1);
    await page.screenshot({ path: resolve(OUT_DIR, "models-remove-provider-before.png"), fullPage: true });

    await remove.click();
    await page.waitForTimeout(500);

    const confirm = speroRow.getByRole("button", { name: "Delete?" });
    await confirm.waitFor({ state: "visible" });
    const cancelCount = await speroRow.getByRole("button", { name: /Cancel/i }).count();
    const namedWarning = await speroRow.getByText(/Spero AI/i).count();
    const fallbackWarning = await speroRow.getByText(/DeepSeek|default/i).count();
    console.log(`baseline: confirm=${JSON.stringify((await confirm.textContent())?.trim())}; cancel=${cancelCount}; namedWarning=${namedWarning}; fallbackWarning=${fallbackWarning}`);
    await page.screenshot({ path: resolve(OUT_DIR, "models-remove-provider-armed.png"), fullPage: true });

    await confirm.click();
    await page.waitForFunction(() => window.__auditSavePending === true);
    await page.waitForTimeout(350);

    const pendingDeleteLabel = await speroRow.getByText(/Deleting/i).count();
    const pendingRemoveIcon = await speroRow.getByRole("button", { name: "Remove provider" }).count();
    const pendingBusy = await speroRow.getAttribute("aria-busy");
    const pendingSummary = (await summary.textContent())?.trim();
    const toastDuringSave = await page.getByText("Model configuration saved — changes take effect immediately", { exact: true }).count();
    console.log(`baseline: pendingDeletingLabel=${pendingDeleteLabel}; pendingRemoveIcon=${pendingRemoveIcon}; rowAriaBusy=${pendingBusy}; summary=${JSON.stringify(pendingSummary)}; toastDuringSave=${toastDuringSave}`);
    assert.equal(pendingBusy, "true");
    assert.equal(pendingSummary, "Spero AI · glm-5.2");
    assert.equal(toastDuringSave, 0);
    await page.screenshot({ path: resolve(OUT_DIR, "models-remove-provider-pending.png"), fullPage: true });

    await page.waitForFunction(() => window.__auditSavedConfigs.length === 1);
    await page.waitForFunction(() => document.querySelector('[data-testid="default-model-summary"]')?.textContent?.includes("DeepSeek · deepseek-chat"));
    await page.waitForTimeout(850);

    const saved = await page.evaluate(() => window.__auditSavedConfigs.at(-1));
    assert.deepEqual(saved.providers.map((provider) => provider.route), ["deepseek"]);
    assert.equal(saved.defaultProvider, "deepseek");
    assert.equal(saved.defaultModel, "deepseek-chat");
    assert.equal(saved.defaultReasoningEffort, null);
    assert.equal(await speroRow.count(), 0);
    assert.equal(await deepseekRow.getByText("default", { exact: true }).count(), 1);
    const genericToast = await page.getByText("Model configuration saved — changes take effect immediately", { exact: true }).count();
    const targetedToast = await page.getByText(/Removed|Deleted|DeepSeek.*default/i).count();
    console.log(`baseline: savedFallback=deepseek/deepseek-chat; reasoningReset=true; genericToast=${genericToast}; targetedToast=${targetedToast}`);
    assert.equal(failures.length, 0, failures.join("\n"));

    await page.screenshot({ path: resolve(OUT_DIR, "models-remove-provider.png"), fullPage: true });
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-remove-provider.webm");
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
