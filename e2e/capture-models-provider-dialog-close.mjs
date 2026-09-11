// Models -> Edit provider -> ProviderDialog close UI audit capture.
// Scope: pristine Cancel, dirty Cancel/Escape/backdrop protection, nested Advanced Escape,
// explicit Discard, and opener focus restoration. Close actions must not add save/test/fetch side effects.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5215;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-provider-dialog-close");

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

const modelConfig = {
  defaultProvider: "deepseek",
  defaultModel: "deepseek-chat",
  defaultReasoningEffort: null,
  providers: [provider],
};

const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 1,
  entries: [{ id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] }],
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
        check_update: () => ({ currentVersion: "0.4.0", availableVersion: null, hasUpdate: false, releaseNotes: null, message: null }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) =>
          (remote ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"] : ["node", "install", "start", "ready"]).map((id, index) => ({
            index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}`,
          })),
        model_config_load: () => structuredClone(modelConfig),
        model_config_save: () => { throw new Error("Provider dialog close audit must not save model configuration"); },
        model_catalog_load: () => structuredClone(modelCatalog),
        model_catalog_refresh: () => ({ ...structuredClone(modelCatalog), fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        // Edit provider performs its normal debounced stale-while-revalidate discovery.
        // The audit records that expected baseline and then forbids close actions from adding calls.
        model_remote_list_with_headers: () => ["deepseek-chat"],
        model_test_connection: () => { throw new Error("Provider dialog close audit must not test the connection"); },
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
          try {
            return Promise.resolve(handler(args));
          } catch (error) {
            return Promise.reject(error);
          }
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => callbacks.delete(id) };
    }, { appConfig, dshStatus, modelConfig, modelCatalog });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();
    const editButton = page.getByRole("button", { name: "Edit provider" });
    await editButton.waitFor({ state: "visible" });
    const startUrl = page.url();

    // Pristine state closes directly and restores focus to the opener.
    await editButton.click();
    let dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(OUT_DIR, "models-provider-dialog-close-pristine.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Edit provider");

    // Reopen and allow the normal 600ms discovery cycle to settle before measuring side effects.
    await editButton.click();
    dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(750);
    const sideEffectBaseline = await page.evaluate(() => ({
      saves: window.__auditCalls.filter((call) => call.command === "model_config_save").length,
      tests: window.__auditCalls.filter((call) => call.command === "model_test_connection").length,
      fetches: window.__auditCalls.filter((call) => call.command === "model_remote_list_with_headers").length,
    }));
    assert.equal(sideEffectBaseline.saves, 0);
    assert.equal(sideEffectBaseline.tests, 0);

    // Make a real edit; every dismissal path must protect it.
    const displayName = dialog.getByRole("textbox", { name: "Display Name" });
    await displayName.fill("DeepSeek Production");
    assert.equal(await dialog.getByRole("button", { name: "Save provider" }).isEnabled(), true);
    await page.screenshot({ path: resolve(OUT_DIR, "models-provider-dialog-close-dirty.png"), fullPage: true });

    // Dirty footer Cancel asks before discarding and focuses the safe choice.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    const confirmation = dialog.getByTestId("provider-discard-confirm");
    await confirmation.waitFor({ state: "visible" });
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await displayName.inputValue(), "DeepSeek Production");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Cancel");
    await page.screenshot({ path: resolve(OUT_DIR, "models-provider-dialog-close-cancel-confirm.png"), fullPage: true });

    // Escape from the discard prompt means keep editing, not close.
    await page.keyboard.press("Escape");
    await confirmation.waitFor({ state: "hidden" });
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await displayName.inputValue(), "DeepSeek Production");

    // Advanced is a nested layer: its first Escape closes only Advanced.
    await dialog.getByRole("button", { name: "Advanced settings" }).click();
    const advanced = dialog.getByTestId("provider-advanced");
    await advanced.waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(OUT_DIR, "models-provider-dialog-close-advanced.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await advanced.waitFor({ state: "hidden" });
    assert.equal(await dialog.getByTestId("provider-discard-confirm").count(), 0);
    assert.equal(await dialog.isVisible(), true);

    // Backdrop dismissal is protected exactly like Cancel/Escape.
    await dialog.click({ position: { x: 20, y: 20 } });
    const backdropConfirmation = dialog.getByTestId("provider-discard-confirm");
    await backdropConfirmation.waitFor({ state: "visible" });
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await displayName.inputValue(), "DeepSeek Production");
    await page.screenshot({ path: resolve(OUT_DIR, "models-provider-dialog-close-backdrop-confirm.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await backdropConfirmation.waitFor({ state: "hidden" });

    // Parent Escape now requests discard; only explicit Discard closes the dialog.
    await displayName.focus();
    await page.keyboard.press("Escape");
    const escapeConfirmation = dialog.getByTestId("provider-discard-confirm");
    await escapeConfirmation.waitFor({ state: "visible" });
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("button", { name: "Discard" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Edit provider");
    assert.equal(page.url(), startUrl);
    await page.screenshot({ path: resolve(OUT_DIR, "models-provider-dialog-close-discarded.png"), fullPage: true });

    const calls = await page.evaluate(() => window.__auditCalls);
    assert.equal(calls.filter((call) => call.command === "model_config_save").length, sideEffectBaseline.saves);
    assert.equal(calls.filter((call) => call.command === "model_test_connection").length, sideEffectBaseline.tests);
    assert.equal(calls.filter((call) => call.command === "model_remote_list_with_headers").length, sideEffectBaseline.fetches);
    assert.equal(failures.length, 0, failures.join("\n"));

    console.log(`audit: pristine=direct-close; dirty=protected; advanced=escape-layered; backdrop=protected; discard=explicit; focus=restored; saveDelta=0; testDelta=0; fetchDelta=0; discoveryBaseline=${sideEffectBaseline.fetches}`);

    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-provider-dialog-close.webm");
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
