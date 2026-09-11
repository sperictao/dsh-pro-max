// Models -> Catalog -> failed refresh -> retry -> success UI audit capture.
// Scope: error recovery only; initial unavailable-state behavior is intentionally out of scope.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5203;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-catalog-retry");

const modelConfig = {
  defaultProvider: null,
  defaultModel: null,
  defaultReasoningEffort: null,
  providers: [],
};
const snapshotCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 2,
  entries: [
    { id: "glm-5.2", name: "GLM 5.2", family: "openai", context: 131072, capabilities: ["text", "reasoning"] },
    { id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, capabilities: ["text"] },
  ],
};
const recoveredCatalog = {
  fetchedAt: snapshotCatalog.fetchedAt + 120,
  providerCount: 3,
  entries: [
    ...snapshotCatalog.entries,
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", family: "anthropic", context: 200000, capabilities: ["text", "vision"] },
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
  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
    try {
      return await chromium.launch({ headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [], ...opts });
    } catch {}
  }
  throw new Error("no browser available for UI capture");
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

    await page.addInitScript(({ config, dshStatus, modelConfig, snapshotCatalog, recoveredCatalog }) => {
      let nextId = 1;
      let refreshCount = 0;
      const callbacks = new Map();
      window.__auditCatalogRetryPending = false;
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
        model_catalog_refresh: () => new Promise((resolve, reject) => {
          refreshCount += 1;
          window.__auditCatalogRefreshCount = refreshCount;
          window.__auditCatalogRetryPending = true;
          setTimeout(() => {
            window.__auditCatalogRetryPending = false;
            if (refreshCount === 1) reject("Failed to reach the model catalog");
            else resolve(structuredClone(recoveredCatalog));
          }, 1200);
        }),
        model_env_status: () => ({}),
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
    }, { ...mock, modelConfig, snapshotCatalog, recoveredCatalog });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();

    const status = page.getByTestId("catalog-status-line");
    const error = page.getByTestId("catalog-error");
    const initialRefresh = page.getByRole("button", { name: "Refresh model catalog" });
    await status.waitFor({ state: "visible" });
    await initialRefresh.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('[data-testid="catalog-status-line"]')?.textContent?.includes("Local snapshot"));
    await page.waitForTimeout(650);
    await page.screenshot({ path: resolve(OUT_DIR, "models-catalog-retry-before.png"), fullPage: true });

    await initialRefresh.click();
    await page.waitForFunction(() => window.__auditCatalogRetryPending === true && window.__auditCatalogRefreshCount === 1);
    await page.getByRole("button", { name: "Refreshing catalog…" }).waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__auditCatalogRetryPending === false);
    await error.waitFor({ state: "visible" });
    await page.waitForTimeout(650);

    assert.equal(await status.getAttribute("data-catalog-source"), "snapshot");
    assert.equal(await error.getAttribute("role"), "alert");
    assert.match((await error.textContent()) ?? "", /Failed to reach the model catalog/);
    const recoveryButton = page.getByRole("button", { name: "Retry" });
    assert.equal(await recoveryButton.getAttribute("aria-describedby"), "models-catalog-error");
    assert.equal(await page.getByText("Failed to reach the model catalog", { exact: true }).count(), 0);
    console.log("after: failed refresh stays contextual and exposes an explicit Retry action without a duplicate error toast");
    await page.screenshot({ path: resolve(OUT_DIR, "models-catalog-retry-error.png"), fullPage: true });

    await recoveryButton.click();
    await page.waitForFunction(() => window.__auditCatalogRetryPending === true && window.__auditCatalogRefreshCount === 2);
    await page.waitForTimeout(350);
    assert.equal(await error.count(), 0);
    assert.equal((await status.textContent())?.trim(), "Refreshing catalog…");
    assert.equal(await page.getByText("Failed to reach the model catalog", { exact: true }).count(), 0);
    console.log("after: retry starts from a clean busy state with no stale failure left on screen");
    await page.screenshot({ path: resolve(OUT_DIR, "models-catalog-retry-pending.png"), fullPage: true });

    await page.waitForFunction(() => window.__auditCatalogRetryPending === false);
    await page.waitForFunction(() => document.querySelector('[data-testid="catalog-status-line"]')?.getAttribute("data-catalog-source") === "remote");
    await page.waitForTimeout(700);
    assert.match((await status.textContent()) ?? "", /models\.dev.*3 providers.*3 models/);
    assert.equal(await error.count(), 0);
    await page.getByText("Refresh model catalog · models.dev · 3 models", { exact: true }).waitFor({ state: "visible" });
    assert.equal(failures.length, 0, failures.join("\n"));
    await page.screenshot({ path: resolve(OUT_DIR, "models-catalog-retry.png"), fullPage: true });

    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-catalog-retry.webm");
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
