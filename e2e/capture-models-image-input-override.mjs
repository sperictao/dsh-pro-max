// Models -> Edit provider -> Model settings -> Advanced -> Image input override UI audit.
// Scope: expose inherited catalog capability, persist an explicit text-only override,
// then reset to catalog inheritance. No connection-test/navigation side effects are allowed.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5216;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-image-input-override");
const MODEL_ID = "deepseek-reasoner";

const deepseek = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [
    { id: "deepseek-chat", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null },
    { id: MODEL_ID, name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null },
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
  providers: [deepseek],
};

const modelCatalog = {
  fetchedAt: Math.floor(Date.now() / 1000),
  providerCount: 1,
  entries: [
    { id: "deepseek-chat", name: "DeepSeek Chat", family: "openai", context: 65536, maxTokens: 8192, input: ["text"], reasoning: false, reasoningLevels: [], capabilities: ["text"] },
    { id: MODEL_ID, name: "DeepSeek Reasoner", family: "openai", context: 65536, maxTokens: 8192, input: ["text", "image"], reasoning: true, reasoningLevels: ["low", "medium", "high"], capabilities: ["text", "reasoning", "vision"] },
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
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } },
    });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ appConfig, dshStatus, modelConfig, modelCatalog, MODEL_ID }) => {
      let nextId = 1;
      const callbacks = new Map();
      let currentModelConfig = structuredClone(modelConfig);
      window.__auditSavedConfigs = [];
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
        model_config_load: () => structuredClone(currentModelConfig),
        model_config_save: ({ config }) => {
          currentModelConfig = structuredClone(config);
          window.__auditSavedConfigs.push(structuredClone(config));
          return null;
        },
        model_catalog_load: () => structuredClone(modelCatalog),
        model_catalog_refresh: () => ({ ...structuredClone(modelCatalog), fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => ({ models: ["deepseek-chat", MODEL_ID], fetchedAt: Math.floor(Date.now() / 1000) }),
        model_remote_list_with_headers: () => ["deepseek-chat", MODEL_ID],
        model_test_connection: () => { throw new Error("Image input override audit must not test the connection"); },
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
    }, { appConfig, dshStatus, modelConfig, modelCatalog, MODEL_ID });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="default-model-summary"]')?.textContent?.includes("DeepSeek · deepseek-chat"));
    const startUrl = page.url();

    const editButton = page.locator('[data-route="deepseek"]').getByRole("button", { name: "Edit provider" });
    await editButton.click();
    let dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(700);

    let row = dialog.locator(`[data-model-id="${MODEL_ID}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.getByRole("button", { name: "Advanced" }).click();
    let panel = row.getByTestId("model-advanced");
    await panel.waitFor({ state: "visible" });
    let imageInput = panel.getByRole("combobox", { name: "Image input" });
    const save = dialog.getByRole("button", { name: "Save provider" });

    assert.equal(await imageInput.inputValue(), "inherit");
    assert.equal(await imageInput.locator('option[value="inherit"]').textContent(), "Follow catalog · Text and images");
    assert.equal(await save.isEnabled(), false);
    await page.screenshot({ path: resolve(OUT_DIR, "models-image-input-inherited.png"), fullPage: true });

    // Apply an explicit text-only override.
    await imageInput.selectOption("text");
    assert.equal(await imageInput.inputValue(), "text");
    assert.equal(await save.isEnabled(), true);
    await page.screenshot({ path: resolve(OUT_DIR, "models-image-input-text-only.png"), fullPage: true });
    await save.click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__auditSavedConfigs.length === 1);

    let saved = await page.evaluate(() => window.__auditSavedConfigs.at(-1));
    let savedModel = saved.providers.find((item) => item.route === "deepseek").models.find((item) => item.id === MODEL_ID);
    assert.deepEqual(savedModel.input, ["text"]);
    assert.equal(saved.defaultProvider, "deepseek");
    assert.equal(saved.defaultModel, "deepseek-chat");

    // Reopen to prove the explicit override persisted, while the reset target still exposes
    // the inherited catalog capability before the user clears the override.
    await editButton.click();
    dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(700);
    row = dialog.locator(`[data-model-id="${MODEL_ID}"]`);
    await row.getByRole("button", { name: "Advanced" }).click();
    panel = row.getByTestId("model-advanced");
    imageInput = panel.getByRole("combobox", { name: "Image input" });
    const resetSave = dialog.getByRole("button", { name: "Save provider" });

    assert.equal(await imageInput.inputValue(), "text");
    assert.equal(await imageInput.locator('option[value="inherit"]').textContent(), "Follow catalog · Text and images");
    assert.equal(await resetSave.isEnabled(), false);
    await page.screenshot({ path: resolve(OUT_DIR, "models-image-input-persisted.png"), fullPage: true });

    // Reset the override back to inheritance and persist null rather than a redundant explicit list.
    await imageInput.selectOption("inherit");
    assert.equal(await imageInput.inputValue(), "inherit");
    assert.equal(await resetSave.isEnabled(), true);
    await page.screenshot({ path: resolve(OUT_DIR, "models-image-input-reset.png"), fullPage: true });
    await resetSave.click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__auditSavedConfigs.length === 2);

    saved = await page.evaluate(() => window.__auditSavedConfigs.at(-1));
    savedModel = saved.providers.find((item) => item.route === "deepseek").models.find((item) => item.id === MODEL_ID);
    assert.equal(savedModel.input, null);
    assert.equal(page.url(), startUrl);

    const calls = await page.evaluate(() => window.__auditCalls);
    assert.equal(calls.filter((call) => call.command === "model_config_save").length, 2);
    assert.equal(calls.filter((call) => call.command === "model_test_connection").length, 0);
    assert.equal(failures.length, 0, failures.join("\n"));

    console.log("audit: inherited=text+image-visible; override=text-only-saved; persisted=yes; reset=inherit-null; saves=2; tests=0; navigation=none");

    await page.screenshot({ path: resolve(OUT_DIR, "models-image-input-final.png"), fullPage: true });
    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-image-input-override.webm");
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
