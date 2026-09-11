// Models -> Catalog -> Refresh model catalog UI audit capture.
// Scope: manually refresh a healthy local catalog snapshot and verify clear pending/success feedback.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5202;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-refresh-catalog");

const spero = {
  route: "spero-ai",
  displayName: "Spero AI",
  baseURL: "https://proxy.example.com/v1",
  api: "openai-responses",
  apiKeyEnv: "SPERO_AI_API_KEY",
  models: [{ id: "glm-5.2", name: "GLM 5.2", contextWindow: 131072, maxTokens: 32768, input: ["text"], reasoningEfforts: { low: "low", medium: "medium", high: "high", max: "max" }, extra: null }],
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
  models: [{ id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 65536, maxTokens: 8192, input: ["text"], reasoningEfforts: null, extra: null }],
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
const snapshotCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 2,
  entries: [
    { id: "glm-5.2", name: "GLM 5.2", family: "openai", context: 131072, maxTokens: 32768, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high", "max"], capabilities: ["text", "reasoning", "tools"] },
    { id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] },
  ],
};
const refreshedCatalog = {
  fetchedAt: snapshotCatalog.fetchedAt + 120,
  providerCount: 3,
  entries: [
    ...snapshotCatalog.entries,
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", family: "anthropic", context: 200000, maxTokens: 32000, input: ["text", "image"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "vision", "reasoning"] },
  ],
};
const mock = {
  config: { minimize_to_tray_on_close: false, language: "en", dsh_admin_cap_domain: "", dsh_use_cap_domain: "", dsh_extra_allowed_logins: "", market_catalog_url: "" },
  dshStatus: {
    nodeAvailable: false, dshInstalled: false, dshVersion: null, supportedVersion: "0.1.1-rc.2", dshCompatible: false,
    dshVersionAboveSupported: false, pluginsInstalled: false, dshRunning: false, tailscaleInstalled: false,
    tailscaleOnline: false, hostname: null, localUrl: null, url: null, remoteUrlAccess: null, magicDnsEnabled: false,
    serveConfigured: false, autostartEnabled: false, error: null,
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 820 }, recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 820 } } });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ config, dshStatus, modelConfig, snapshotCatalog, refreshedCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      window.__auditCatalogRefreshPending = false;
      window.__auditCatalogRefreshCount = 0;
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => config,
        autostart_is_enabled: () => false,
        get_updater_config_health: () => ({ configured: true, message: "ready" }),
        check_update: () => ({ currentVersion: "0.4.0", availableVersion: null, hasUpdate: false, releaseNotes: null, message: null }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) => (remote ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] : ["node", "install", "start", "ready"]).map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
        model_config_load: () => structuredClone(modelConfig),
        model_catalog_load: () => structuredClone(snapshotCatalog),
        model_catalog_refresh: () => new Promise((resolve) => {
          window.__auditCatalogRefreshPending = true;
          window.__auditCatalogRefreshCount += 1;
          setTimeout(() => {
            window.__auditCatalogRefreshPending = false;
            resolve(structuredClone(refreshedCatalog));
          }, 1400);
        }),
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
    }, { ...mock, modelConfig, snapshotCatalog, refreshedCatalog });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();

    const catalogRegion = page.locator("#models-catalog");
    const status = page.getByTestId("catalog-status-line");
    const refresh = page.getByRole("button", { name: "Refresh model catalog" });
    await status.waitFor({ state: "visible" });
    await refresh.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('[data-testid="catalog-status-line"]')?.textContent?.includes("Local snapshot"));
    await page.waitForTimeout(850);

    assert.equal(await catalogRegion.getAttribute("aria-busy"), "false");
    assert.equal(await status.getAttribute("data-catalog-source"), "snapshot");
    assert.equal(await status.getAttribute("data-provider-count"), "2");
    assert.match((await status.textContent()) ?? "", /Local snapshot.*2 providers.*3 models/);
    await page.screenshot({ path: resolve(OUT_DIR, "models-refresh-catalog-before.png"), fullPage: true });

    await refresh.click();
    await page.waitForFunction(() => window.__auditCatalogRefreshPending === true);
    await page.waitForTimeout(400);

    const pendingButton = page.getByRole("button", { name: "Refreshing catalog…" });
    assert.equal(await pendingButton.isDisabled(), true);
    assert.equal(await catalogRegion.getAttribute("aria-busy"), "true");
    assert.equal((await status.textContent())?.trim(), "Refreshing catalog…");
    const successToastDuringRefresh = await page.getByText("Refresh model catalog · models.dev · 4 models", { exact: true }).count();
    assert.equal(successToastDuringRefresh, 0);
    console.log("after: catalog region is busy and the status line explicitly says Refreshing catalog…");
    await page.screenshot({ path: resolve(OUT_DIR, "models-refresh-catalog-pending.png"), fullPage: true });

    await page.waitForFunction(() => window.__auditCatalogRefreshPending === false && window.__auditCatalogRefreshCount === 1);
    await page.waitForFunction(() => document.querySelector('[data-testid="catalog-status-line"]')?.getAttribute("data-catalog-source") === "remote");
    await page.waitForTimeout(850);

    assert.equal(await catalogRegion.getAttribute("aria-busy"), "false");
    assert.equal(await status.getAttribute("data-provider-count"), "3");
    assert.match((await status.textContent()) ?? "", /models\.dev.*3 providers.*4 models/);
    const successToast = page.getByText("Refresh model catalog · models.dev · 4 models", { exact: true });
    await successToast.waitFor({ state: "visible" });
    console.log(`after: refreshedStatus=${JSON.stringify((await status.textContent())?.trim())}; successToast=visible`);
    assert.equal(failures.length, 0, failures.join("\n"));

    await page.screenshot({ path: resolve(OUT_DIR, "models-refresh-catalog.png"), fullPage: true });
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-refresh-catalog.webm");
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
