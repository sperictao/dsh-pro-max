// Neutral A/B capture for ProviderDialog Base URL validation and repair.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = process.env.AUDIT_LABEL ?? "capture";
const port = Number(process.env.AUDIT_PORT ?? "5249");
const BASE = `http://127.0.0.1:${port}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-base-url-validation-comparison", label);

const provider = {
  route: "my-gateway",
  displayName: "My Gateway",
  baseURL: "https://gateway.example.com/v1",
  api: "openai-completions",
  apiKeyEnv: "MY_GATEWAY_KEY",
  models: [{ id: "my-model", name: "My Model", contextWindow: 128000, maxTokens: 16384, input: ["text"], reasoningEfforts: null, extra: null }],
  headers: null,
  timeoutMs: null,
  reasoning: null,
  extra: null,
};
const modelConfig = { defaultProvider: "my-gateway", defaultModel: "my-model", defaultReasoningEffort: null, providers: [provider] };
const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 1,
  entries: [{ id: "my-model", name: "My Model", family: "openai", context: 128000, maxTokens: 16384, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] }],
};
const appConfig = { minimize_to_tray_on_close: false, language: "en", dsh_admin_cap_domain: "", dsh_use_cap_domain: "", dsh_extra_allowed_logins: "", market_catalog_url: "" };
const dshStatus = {
  nodeAvailable: false, dshInstalled: false, dshVersion: null, supportedVersion: "0.1.1-rc.2", dshCompatible: false, dshVersionAboveSupported: false,
  pluginsInstalled: false, dshRunning: false, tailscaleInstalled: false, tailscaleOnline: false, hostname: null, localUrl: null, url: null,
  remoteUrlAccess: null, magicDnsEnabled: false, serveConfigured: false, autostartEnabled: false, error: null,
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
  const server = await createServer({ root: ROOT, logLevel: "error", server: { host: "127.0.0.1", port, strictPort: true } });
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
      let currentModelConfig = structuredClone(modelConfig);
      window.__auditTestCalls = [];
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
        model_config_save: ({ config }) => { currentModelConfig = structuredClone(config); window.__auditSavedConfigs.push(structuredClone(config)); return new Promise((resolve) => setTimeout(() => resolve(null), 300)); },
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({ ...modelCatalog, fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        model_remote_list_with_headers: () => ["my-model"],
        model_test_connection: (args) => { window.__auditTestCalls.push(structuredClone(args)); return new Promise((resolve) => setTimeout(() => resolve(null), 400)); },
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
    await page.waitForFunction(() => document.querySelector('[data-testid="default-model-summary"]')?.textContent?.includes("My Gateway · my-model"));
    await page.locator('[data-route="my-gateway"]').getByRole("button", { name: "Edit provider" }).click();

    const dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    const baseURL = dialog.getByRole("textbox", { name: "Base URL" });
    const testButton = dialog.getByRole("button", { name: "Test connection" });
    const saveButton = dialog.getByRole("button", { name: "Save provider" });
    await page.waitForTimeout(600);

    const invalidRaw = "gateway.example.com/v1/chat/completions";
    await baseURL.fill(invalidRaw);
    await baseURL.press("Tab");
    await dialog.getByRole("alert").waitFor({ state: "visible" });
    const invalidValuePreserved = (await baseURL.inputValue()) === invalidRaw;
    console.log(`${label}: invalid-value-preserved=${invalidValuePreserved}`);
    console.log(`${label}: validation-associated=${Boolean(await baseURL.getAttribute("aria-describedby"))}`);
    assert.equal(await testButton.isDisabled(), true);
    assert.equal(await saveButton.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__auditTestCalls.length), 0);
    assert.equal(await page.evaluate(() => window.__auditSavedConfigs.length), 0);
    await page.waitForTimeout(1100);

    // Replace in one edit so the A/B comparison does not transit through an empty value.
    await baseURL.fill("ftp://gateway.example.com/v2/chat/completions");
    await page.waitForTimeout(900);
    const invalidRepairErrorCount = await dialog.getByText("Enter a valid http:// or https:// URL.", { exact: true }).count();
    console.log(`${label}: error-visible-during-invalid-repair=${invalidRepairErrorCount}`);
    assert.equal(await testButton.isDisabled(), true);
    assert.equal(await saveButton.isDisabled(), true);

    await baseURL.fill("https://gateway.example.com/v2/chat/completions");
    await page.waitForTimeout(650);
    const validRepairErrorCount = await dialog.getByText("Enter a valid http:// or https:// URL.", { exact: true }).count();
    console.log(`${label}: error-after-valid-repair=${validRepairErrorCount}`);
    console.log(`${label}: test-ready-after-valid-repair=${await testButton.isEnabled()}`);
    console.log(`${label}: save-ready-after-valid-repair=${await saveButton.isEnabled()}`);
    assert.equal(await testButton.isEnabled(), true);
    assert.equal(await saveButton.isEnabled(), true);

    await baseURL.press("Tab");
    assert.equal(await baseURL.inputValue(), "https://gateway.example.com/v2");
    await page.waitForTimeout(650);
    await testButton.click();
    await dialog.getByText("Connection successful", { exact: true }).waitFor({ state: "visible" });
    await page.waitForTimeout(800);
    await saveButton.click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.__auditSavedConfigs.length === 1);
    const saved = await page.evaluate(() => window.__auditSavedConfigs[0]);
    assert.equal(saved.providers[0].baseURL, "https://gateway.example.com/v2");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
    await page.waitForTimeout(850);

    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, `models-base-url-validation-${label}.webm`);
    if (recorded !== stable) renameSync(recorded, stable);
    console.log(`capture: ${stable}`);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((error) => { console.error(String(error?.stack ?? error)); process.exit(1); });
