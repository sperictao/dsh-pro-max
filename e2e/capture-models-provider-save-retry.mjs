// ProviderDialog save failure -> repair -> retry UI audit capture.
// Scope: verify saving lock, persistent draft, visible contextual error, stale-error retirement, and successful retry.
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5219;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-provider-save-retry");

const deepseek = {
  route: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  api: "openai-completions",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  models: [
    {
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      contextWindow: 65536,
      maxTokens: 8192,
      input: ["text"],
      reasoningEfforts: null,
      extra: null,
    },
    {
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner",
      contextWindow: 65536,
      maxTokens: 8192,
      input: ["text"],
      reasoningEfforts: { low: "low", medium: "medium", high: "high" },
      extra: null,
    },
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
    {
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      family: "openai",
      context: 65536,
      maxTokens: 8192,
      input: ["text"],
      reasoning: false,
      reasoningLevels: [],
      capabilities: ["text"],
    },
    {
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner",
      family: "openai",
      context: 65536,
      maxTokens: 8192,
      input: ["text"],
      reasoning: true,
      reasoningLevels: ["low", "medium", "high"],
      capabilities: ["text", "reasoning"],
    },
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
  const failures = [];
  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
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

    await page.addInitScript(({ appConfig, dshStatus, modelConfig, modelCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      let currentModelConfig = structuredClone(modelConfig);
      window.__auditSaveAttempts = 0;
      window.__auditSavePending = false;
      window.__auditSavedConfigs = [];

      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => appConfig,
        autostart_is_enabled: () => false,
        get_updater_config_health: () => ({ configured: true, message: "ready" }),
        check_update: () => ({
          currentVersion: "0.4.0",
          availableVersion: null,
          hasUpdate: false,
          releaseNotes: null,
          message: null,
        }),
        dsh_detect: () => dshStatus,
        dsh_step_schema: ({ remote } = {}) =>
          (remote
            ? ["node", "install", "plugins", "tailscale", "magicdns", "start", "serve", "verify"]
            : ["node", "install", "start", "ready"]
          ).map((id, index) => ({
            index,
            id,
            state: "pending",
            detail: null,
            problem: null,
            solution: null,
            titleKey: `step.${id}`,
          })),
        model_config_load: () => structuredClone(currentModelConfig),
        model_config_save: ({ config }) =>
          new Promise((resolveSave, rejectSave) => {
            window.__auditSaveAttempts += 1;
            const attempt = window.__auditSaveAttempts;
            window.__auditSavePending = true;
            setTimeout(() => {
              window.__auditSavePending = false;
              if (attempt === 1) {
                rejectSave("Failed to write settings.yaml");
                return;
              }
              currentModelConfig = structuredClone(config);
              window.__auditSavedConfigs.push(structuredClone(config));
              resolveSave(null);
            }, 1000);
          }),
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({
          ...modelCatalog,
          fetchedAt: Math.floor(Date.now() / 1000),
        }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
        model_remote_list_with_headers: () => ["deepseek-chat", "deepseek-reasoner"],
        model_test_connection: () => null,
        "plugin:app|version": () => "0.4.0",
        "plugin:notification|is_permission_granted": () => true,
      };

      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback: (callback) => {
          const id = nextId++;
          callbacks.set(id, callback);
          return id;
        },
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
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event, id) => callbacks.delete(id),
      };
    }, { appConfig, dshStatus, modelConfig, modelCatalog });

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Models" }).click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="default-model-summary"]')?.textContent?.includes("DeepSeek · deepseek-chat"),
    );

    const row = page.locator('[data-route="deepseek"]');
    await row.getByRole("button", { name: "Edit provider" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit provider" });
    await dialog.waitFor({ state: "visible" });

    const displayName = dialog.getByRole("textbox", { name: "Display Name" });
    const saveButton = dialog.getByRole("button", { name: "Save provider" });
    await displayName.fill("DeepSeek Recovery");
    await dialog.getByRole("button", { name: "Advanced settings" }).click();

    const body = dialog.locator("div.overflow-y-auto.p-5").first();
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const scrollBeforeFailure = await body.evaluate((element) => element.scrollTop);
    assert.ok(scrollBeforeFailure > 0, `expected a scrolled dialog body, got ${scrollBeforeFailure}`);
    await page.waitForTimeout(500);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-save-retry-before-failure.png"),
      fullPage: true,
    });

    await saveButton.click();
    await page.waitForFunction(() => window.__auditSavePending === true);
    assert.equal(await dialog.locator('[aria-busy="true"]').count(), 1);
    assert.equal(await dialog.getByRole("button", { name: "Saving…" }).isDisabled(), true);

    await page.waitForFunction(() => window.__auditSaveAttempts === 1 && window.__auditSavePending === false);
    const error = dialog.getByTestId("provider-submit-error");
    await error.waitFor({ state: "visible" });
    assert.match((await error.textContent()) ?? "", /Failed to write settings\.yaml/);
    assert.equal(await dialog.count(), 1, "dialog should remain open after a failed save");
    assert.equal(await displayName.inputValue(), "DeepSeek Recovery", "draft should survive save failure");
    assert.equal(await saveButton.isEnabled(), true, "save should recover after the rejected attempt");

    const errorVisibleInScrollViewport = await error.evaluate((element) => {
      const errorRect = element.getBoundingClientRect();
      const scrollRect = element.parentElement?.getBoundingClientRect();
      if (!scrollRect) return false;
      return errorRect.top >= scrollRect.top - 1 && errorRect.bottom <= scrollRect.bottom + 1;
    });
    assert.equal(errorVisibleInScrollViewport, true, "sticky save error should stay in the visible dialog viewport");
    assert.equal(
      await page.getByText("Failed to write settings.yaml", { exact: true }).count(),
      1,
      "save failure should have one contextual feedback surface, not a duplicate toast",
    );
    await page.waitForTimeout(700);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-save-retry-failed.png"),
      fullPage: true,
    });

    const timeout = dialog.getByRole("spinbutton", { name: "Request timeout (ms)" });
    await timeout.fill("45000");
    assert.equal(await dialog.getByTestId("provider-submit-error").count(), 0, "editing should retire the stale save error");
    assert.equal(await displayName.inputValue(), "DeepSeek Recovery");
    await page.waitForTimeout(600);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-save-retry-repaired.png"),
      fullPage: true,
    });

    await saveButton.click();
    await page.waitForFunction(() => window.__auditSavePending === true);
    assert.equal(await dialog.getByRole("button", { name: "Saving…" }).isDisabled(), true);
    await page.waitForFunction(() => window.__auditSaveAttempts === 2 && window.__auditSavedConfigs.length === 1);
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() =>
      document.querySelector('[data-route="deepseek"]')?.textContent?.includes("DeepSeek Recovery"),
    );

    const saved = await page.evaluate(() => window.__auditSavedConfigs.at(-1));
    const savedProvider = saved.providers.find((provider) => provider.route === "deepseek");
    assert.ok(savedProvider);
    assert.equal(savedProvider.displayName, "DeepSeek Recovery");
    assert.equal(savedProvider.timeoutMs, 45000);
    assert.equal(savedProvider.baseURL, "https://api.deepseek.com/v1");
    assert.equal(savedProvider.api, "openai-completions");
    assert.deepEqual(savedProvider.models.map((model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);
    assert.equal(saved.defaultProvider, "deepseek");
    assert.equal(saved.defaultModel, "deepseek-chat");
    await page.getByText("Model configuration saved — changes take effect immediately", { exact: true }).waitFor({ state: "visible" });

    assert.equal(failures.length, 0, failures.join("\n"));
    await page.waitForTimeout(700);
    await page.screenshot({
      path: resolve(OUT_DIR, "models-provider-save-retry-success.png"),
      fullPage: true,
    });

    await context.close();
    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-provider-save-retry.webm");
    if (recorded !== stable) renameSync(recorded, stable);
    console.log(`capture: ${stable}`);
    console.log("audit: failure visible + draft preserved + stale error cleared + retry persisted");
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
