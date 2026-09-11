// Models 主界面 UI 审计录制：只覆盖 Home -> Models -> 主界面浏览，
// 不进入默认模型、Provider 编辑/测试/发现/删除等下一层功能。
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5190;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(ROOT, ".artifacts", "e2e", "models-main");

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
      index,
      id,
      state: "pending",
      detail: null,
      problem: null,
      solution: null,
      titleKey: `step.${id}`,
    })),
  },
  modelConfig: {
    defaultProvider: "spero-ai",
    defaultModel: "glm-5.2",
    defaultReasoningEffort: "max",
    providers: [
      {
        route: "spero-ai",
        displayName: "Spero AI",
        baseURL: "https://proxy.example.com/v1",
        api: "openai-responses",
        apiKeyEnv: "SPERO_AI_API_KEY",
        models: [
          {
            id: "glm-5.2",
            name: null,
            contextWindow: null,
            maxTokens: null,
            input: null,
            reasoningEfforts: null,
            extra: null,
          },
          {
            id: "kimi-for-coding",
            name: "Kimi for Coding",
            contextWindow: 262144,
            maxTokens: 32768,
            input: ["text", "image"],
            reasoningEfforts: { high: "high" },
            extra: null,
          },
        ],
        headers: null,
        timeoutMs: null,
        reasoning: null,
        extra: null,
      },
      {
        route: "custom-openai",
        displayName: "Custom OpenAI",
        baseURL: "https://api.example.com/v1",
        api: "openai-completions",
        apiKeyEnv: "CUSTOM_OPENAI_API_KEY",
        models: [{ id: "custom-model", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }],
        headers: null,
        timeoutMs: null,
        reasoning: null,
        extra: null,
      },
    ],
  },
  modelCatalog: {
    fetchedAt: Math.floor(Date.now() / 1000),
    providerCount: 2,
    entries: [
      {
        id: "glm-5.2",
        name: "GLM 5.2",
        family: "openai",
        context: 131072,
        maxTokens: 32768,
        input: ["text"],
        reasoning: true,
        reasoningLevels: ["low", "medium", "high", "max"],
        capabilities: ["text", "reasoning", "tools"],
      },
    ],
  },
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
      viewport: { width: 1440, height: 960 },
      recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 960 } },
    });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ config, dshStatus, modelConfig, modelCatalog }) => {
      let nextId = 1;
      const callbacks = new Map();
      const handlers = {
        get_resolved_language: () => "en",
        load_config: () => config,
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
        model_config_load: () => modelConfig,
        model_config_save: () => null,
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({ ...modelCatalog, fetchedAt: Math.floor(Date.now() / 1000) }),
        model_env_status: ({ names }) => Object.fromEntries(names.map((name) => [name, true])),
        model_remote_cache_get: () => null,
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
    }, mock);

    const video = page.video();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "DSH Pro Max" }).waitFor({ state: "visible" });
    await page.waitForTimeout(700);

    await page.getByRole("button", { name: "Models" }).click();
    const modelsView = page.locator("#models-view");
    await modelsView.waitFor({ state: "visible" });
    await page.getByTestId("default-model-summary").waitFor({ state: "visible" });
    await page.locator("#provider-row-0").waitFor({ state: "visible" });
    await page.getByTestId("catalog-status-line").waitFor({ state: "visible" });
    await page.waitForTimeout(1200);

    await modelsView.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "smooth" }));
    await page.waitForTimeout(1200);
    await modelsView.evaluate((element) => element.scrollTo({ top: 0, behavior: "smooth" }));
    await page.waitForTimeout(900);

    assert.equal(failures.length, 0, failures.join("\n"));
    await page.screenshot({ path: resolve(OUT_DIR, "models-main.png"), fullPage: true });
    await context.close();

    const recorded = await video.path();
    const stable = resolve(OUT_DIR, "models-main.webm");
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
