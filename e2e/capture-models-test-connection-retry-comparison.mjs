// Neutral A/B capture for ProviderDialog connection-test stale-result recovery.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = process.env.AUDIT_LABEL || "capture";
const PORT = Number(process.env.AUDIT_PORT || 5245);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-test-connection-retry-comparison", LABEL);

const provider = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [{ id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 65536, maxTokens: 8192, input: ["text"], reasoningEfforts: null, extra: null }],
  headers: null,
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
  nodeAvailable: false, dshInstalled: false, dshVersion: null, supportedVersion: "0.1.1-rc.2", dshCompatible: false,
  dshVersionAboveSupported: false, pluginsInstalled: false, dshRunning: false, tailscaleInstalled: false, tailscaleOnline: false,
  hostname: null, localUrl: null, url: null, remoteUrlAccess: null, magicDnsEnabled: false, serveConfigured: false, autostartEnabled: false, error: null,
  readyTimeline: ["node", "install", "start", "ready"].map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
};

async function launchBrowser() {
  const failures = [];
  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 760 }, recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 760 } } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.addInitScript(({ appConfig, dshStatus, modelConfig, modelCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      window.__auditTestAttempts = 0;
      window.__auditFirstSettled = false;
      window.__auditTestCalls = [];
      window.__auditSaveCalls = 0;
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => appConfig,
        autostart_is_enabled: () => false,
        get_updater_config_health: () => ({ configured: true, message: "ready" }),
        check_update: () => ({ currentVersion: "0.4.0", availableVersion: null, hasUpdate: false, releaseNotes: null, message: null }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) => (remote ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] : ["node", "install", "start", "ready"]).map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
        model_config_load: () => structuredClone(modelConfig),
        model_config_save: () => { window.__auditSaveCalls += 1; return null; },
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({ ...modelCatalog, fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        model_remote_list_with_headers: () => ["deepseek-chat"],
        model_test_connection: (args) => new Promise((resolveTest, rejectTest) => {
          window.__auditTestAttempts += 1;
          const attempt = window.__auditTestAttempts;
          window.__auditTestCalls.push(structuredClone(args));
          setTimeout(() => {
            if (attempt === 1) {
              window.__auditFirstSettled = true;
              rejectTest("HTTP 401 Unauthorized: old credential");
              return;
            }
            resolveTest(null);
          }, attempt === 1 ? 1800 : 850);
        }),
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
    await page.waitForFunction(() => document.querySelector('[data-testid="default-model-summary"]')?.textContent?.includes("DeepSeek · deepseek-chat"));

    const providerRow = page.locator('[data-route="deepseek"]');
    await providerRow.getByRole("button", { name: "Edit provider" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });

    await dialog.getByRole("button", { name: "Test connection" }).click();
    await dialog.getByRole("button", { name: "Testing…" }).waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__auditTestAttempts === 1);

    const apiKey = dialog.getByRole("textbox", { name: "API Key Env Var" });
    await apiKey.fill("DEEPSEEK_ROTATED_KEY");
    await page.waitForTimeout(300);

    const retryReadyAfterEdit = await dialog.getByRole("button", { name: "Test connection" }).isEnabled().catch(() => false);
    console.log(`${LABEL}: retry-ready-after-edit=${retryReadyAfterEdit}`);
    await page.screenshot({ path: resolve(OUT_DIR, `models-test-connection-${LABEL}-after-edit.png`), fullPage: true });

    await page.waitForFunction(() => window.__auditFirstSettled === true);
    await page.waitForTimeout(250);
    const staleResultCount = await dialog.locator('[data-testid="provider-test-result"]').filter({ hasText: "old credential" }).count();
    console.log(`${LABEL}: stale-result-after-edit=${staleResultCount}`);
    await page.screenshot({ path: resolve(OUT_DIR, `models-test-connection-${LABEL}-old-request-settled.png`), fullPage: true });

    const retry = dialog.getByRole("button", { name: "Test connection" });
    await retry.waitFor({ state: "visible" });
    await retry.click();
    await dialog.getByRole("button", { name: "Testing…" }).waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__auditTestAttempts === 2);
    await dialog.getByText("Connection successful", { exact: true }).waitFor({ state: "visible" });

    const calls = await page.evaluate(() => window.__auditTestCalls);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].apiKeyEnv, "DEEPSEEK_API_KEY");
    assert.equal(calls[1].apiKeyEnv, "DEEPSEEK_ROTATED_KEY");
    assert.equal(await page.evaluate(() => window.__auditSaveCalls), 0);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
    console.log(`${LABEL}: retry-success=true`);

    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(OUT_DIR, `models-test-connection-${LABEL}-success.png`), fullPage: true });
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, `models-test-connection-retry-${LABEL}.webm`);
    if (recorded !== stable) renameSync(recorded, stable);
    console.log(`capture: ${stable}`);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((error) => { console.error(String(error?.stack ?? error)); process.exit(1); });
