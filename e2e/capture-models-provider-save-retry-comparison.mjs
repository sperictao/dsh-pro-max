// A/B capture for #48. The same script runs against #47 and #48.
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = process.env.AUDIT_LABEL || "capture";
const PORT = Number(process.env.AUDIT_PORT || 5227);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-provider-save-retry-comparison", LABEL);

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

const modelConfig = { defaultProvider: "deepseek", defaultModel: "deepseek-chat", defaultReasoningEffort: null, providers: [deepseek] };
const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 1,
  entries: [
    { id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning"] },
  ],
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
  const server = await createServer({ root: ROOT, logLevel: "error", server: { host: "127.0.0.1", port: PORT, strictPort: true } });
  await server.listen();
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } } });
    const page = await context.newPage();
    await page.addInitScript(({ appConfig, dshStatus, modelConfig, modelCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      let currentModelConfig = structuredClone(modelConfig);
      window.__auditSaveAttempts = 0;
      window.__auditSavePending = false;
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => appConfig,
        autostart_is_enabled: () => false,
        get_updater_config_health: () => ({ configured: true, message: "ready" }),
        check_update: () => ({ currentVersion: "0.4.0", availableVersion: null, hasUpdate: false, releaseNotes: null, message: null }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) => (remote ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] : ["node", "install", "start", "ready"]).map((id, index) => ({ index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}` })),
        model_config_load: () => structuredClone(currentModelConfig),
        model_config_save: ({ config }) => new Promise((resolveSave, rejectSave) => {
          window.__auditSaveAttempts += 1;
          const attempt = window.__auditSaveAttempts;
          window.__auditSavePending = true;
          setTimeout(() => {
            window.__auditSavePending = false;
            if (attempt === 1) { rejectSave("Failed to write settings.yaml"); return; }
            currentModelConfig = structuredClone(config);
            resolveSave(null);
          }, 1100);
        }),
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({ ...modelCatalog, fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        model_remote_list_with_headers: () => ["deepseek-chat", "deepseek-reasoner"],
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
    await page.waitForTimeout(700);

    const displayName = dialog.getByRole("textbox", { name: "Display Name" });
    const saveButton = dialog.getByRole("button", { name: "Save provider" });
    await displayName.fill("DeepSeek Recovery");
    await page.waitForTimeout(600);

    await saveButton.click();
    await page.waitForFunction(() => window.__auditSavePending === true);
    await page.waitForFunction(() => window.__auditSaveAttempts === 1 && window.__auditSavePending === false);
    await page.getByText("Failed to write settings.yaml", { exact: true }).first().waitFor({ state: "visible" });
    await page.waitForTimeout(1800);
    console.log(`${LABEL}: failure-surfaces=${await page.getByText("Failed to write settings.yaml", { exact: true }).count()}`);

    await dialog.getByRole("button", { name: "Advanced settings" }).click();
    const timeout = dialog.getByRole("spinbutton", { name: "Request timeout (ms)" });
    await timeout.fill("45000");
    await page.waitForTimeout(1800);
    console.log(`${LABEL}: stale-failure-surfaces-after-edit=${await page.getByText("Failed to write settings.yaml", { exact: true }).count()}`);

    const geometry = await page.evaluate(() => {
      const overlay = document.querySelector("#provider-dialog");
      const card = overlay?.firstElementChild;
      const body = card?.children?.[1];
      const footer = card?.children?.[2];
      const button = document.querySelector("#btn-save-provider");
      const toRect = (element) => {
        if (!(element instanceof Element)) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      const buttonRect = button instanceof Element ? button.getBoundingClientRect() : null;
      const cx = buttonRect ? buttonRect.left + buttonRect.width / 2 : 0;
      const cy = buttonRect ? buttonRect.top + buttonRect.height / 2 : 0;
      const hit = buttonRect ? document.elementFromPoint(cx, cy) : null;
      const cardStyle = card instanceof Element ? getComputedStyle(card) : null;
      const bodyStyle = body instanceof Element ? getComputedStyle(body) : null;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        overlay: toRect(overlay),
        card: toRect(card),
        body: toRect(body),
        footer: toRect(footer),
        button: toRect(button),
        cardStyle: cardStyle ? { height: cardStyle.height, maxHeight: cardStyle.maxHeight, overflow: cardStyle.overflow, display: cardStyle.display } : null,
        bodyStyle: bodyStyle ? { height: bodyStyle.height, minHeight: bodyStyle.minHeight, overflowY: bodyStyle.overflowY, flex: bodyStyle.flex } : null,
        bodyScroll: body instanceof HTMLElement ? { clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, scrollTop: body.scrollTop } : null,
        hit: hit ? { tag: hit.tagName, id: hit.id, className: typeof hit.className === "string" ? hit.className : "" } : null,
      };
    });
    console.log(`${LABEL}: geometry=${JSON.stringify(geometry)}`);

    let retryBlocked = false;
    try {
      await saveButton.click({ timeout: 1500 });
    } catch {
      retryBlocked = true;
    }
    console.log(`${LABEL}: retry-click-blocked=${retryBlocked}`);

    if (!retryBlocked) {
      await page.waitForFunction(() => window.__auditSaveAttempts === 2 && window.__auditSavePending === false);
      await dialog.waitFor({ state: "detached" });
      await page.getByText("Model configuration saved — changes take effect immediately", { exact: true }).waitFor({ state: "visible" });
    }
    await page.waitForTimeout(1800);

    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, `models-provider-save-retry-${LABEL}.webm`);
    if (recorded !== stable) renameSync(recorded, stable);
    console.log(`capture: ${stable}`);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
main().catch((error) => { console.error(String(error?.stack ?? error)); process.exit(1); });
