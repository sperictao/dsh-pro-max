// E2E 冒烟（playwright-core + vite dev server）：
// 验证壳渲染/导航，以及 Provider Studio 的关键配置闭环，无报错 toast、无页面异常。
// Tauri IPC 用 addInitScript 注入的 __TAURI_INTERNALS__ mock 替身——命令清单必须与
// src/shared/commands.ts 对齐；出现未 mock 命令即失败（防止启动链路静默漂移）。
// 浏览器优先系统 Chrome → Edge → playwright 自带 Chromium（需自行 install）。
import { createServer } from "vite";
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5188;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_VERSION = "0.4.0";

async function startVite() {
  const server = await createServer({
    root: ROOT,
    logLevel: "error",
    // 显式 IPv4：默认 localhost 在 macOS 可能绑 ::1，与 goto 的 127.0.0.1 不一致
    server: { host: "127.0.0.1", port: PORT, strictPort: true },
  });
  await server.listen();
  return server;
}

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
    } catch (e) {
      failures.push(`${opts.channel ?? "bundled chromium"}: ${String(e.message).split("\n")[0]}`);
    }
  }
  throw new Error(
    `no browser available for E2E smoke (install Google Chrome, or pnpm dlx playwright@^1 install chromium)\n${failures.join("\n")}`,
  );
}

// 与 Rust 命令返回结构对齐的替身数据
const MOCK = {
  config: {
    minimize_to_tray_on_close: false,
    language: "en",
    dsh_admin_cap_domain: "",
    dsh_use_cap_domain: "",
    dsh_extra_allowed_logins: "",
    market_catalog_url: "",
  },  dshStatus: {
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
    // 就绪时间轴由 Rust detect 推导（前端不再重推导步骤编排）；
    // 检测全灰时本地 4 步全 pending
    readyTimeline: ["node", "install", "start", "ready"].map((id, index) => ({
      index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}`,
    })),
  },
  marketCatalog: {
    generatedAt: "2026-08-30T13:32:12.579Z",
    total: 2,
    plugins: [
      {
        repositoryId: 1,
        fullName: "omdsh-dev/DSH-better-sidebar",
        name: "DSH-better-sidebar",
        description: "侧边栏底座",
        url: "https://github.com/omdsh-dev/DSH-better-sidebar",
        stars: 3120,
        category: "ui",
        language: "TypeScript",
        verified: true,
        installSpecifier: "npm:dsh-better-sidebar@latest",
        installExecutable: true,
      },
      {
        repositoryId: 2,
        fullName: "some/one",
        name: "one",
        description: "no candidate",
        url: "https://github.com/some/one",
        stars: 10,
        category: "ui",
        language: null,
        verified: false,
        installSpecifier: null,
        installExecutable: false,
      },
    ],
  },
  marketInstalled: [
    { name: "@dsh-external/dsh-auth-tailscale", spec: "file:/x.tgz", managed: true },
  ],
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
        models: [{ id: "glm-5.2", name: null, contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null, extra: null }],
        headers: null,
        timeoutMs: null,
        reasoning: null,
        extra: null,
      },
    ],
  },
  modelCatalog: {
    fetchedAt: Math.floor(Date.now() / 1000),
    providerCount: 1,
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

async function main() {
  const server = await startVite();
  const browser = await launchBrowser();
  const failures = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));

    await page.addInitScript(({ config, dshStatus, marketCatalog, marketInstalled, modelConfig, modelCatalog }) => {
      // 结构对齐 @tauri-apps/api/mocks.js 的 mockInternals：
      // 事件解绑路径依赖 __TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener 与回调注册表
      let nextId = 1;
      const callbacks = new Map();
      window.__e2eSavedConfigs = [];
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
            ? ["node","install","plugins","tailscale","magicdns","start","serve","verify"]
            : ["node","install","start","ready"]).map((id, index) => ({
            index, id, state: "pending", detail: null, problem: null, solution: null, titleKey: `step.${id}`,
          })),
        market_fetch: () => marketCatalog,
        market_snapshot: () => null,
        market_installed: () => marketInstalled,
        market_check_updates: () => [],
        model_config_load: () => modelConfig,
        model_config_save: ({ config }) => {
          window.__e2eSavedConfigs.push(structuredClone(config));
          return null;
        },
        model_catalog_load: () => modelCatalog,
        model_catalog_refresh: () => ({ ...modelCatalog, fetchedAt: Math.floor(Date.now() / 1000) }),
        model_credential_describe: ({ names }) => Object.fromEntries(
          names.map((name) => [name, { configured: true, source: "file", writable: true }]),
        ),
        model_credential_set: () => ({ configured: true, source: "file", writable: true }),
        model_credential_unset: () => ({ configured: false, source: null, writable: true }),
        model_remote_cache_get: () => null,
        model_test_connection: () => null,
        model_remote_list_with_headers: ({ baseUrl }) =>
          baseUrl.includes("e2e.example.com")
            ? Array.from({ length: 75 }, (_, index) => `e2e-model-${String(index).padStart(3, "0")}`)
            : ["glm-5.2", "glm-5.2-fast"],
        model_config_import_scan: () => [
          { source: "claude-code", entries: [] },
          { source: "codex", entries: [] },
          { source: "opencode", entries: [] },
          { source: "pi", entries: [] },
          { source: "cc-switch", entries: [] },
        ],
        model_config_import_run: () => ({ imported: 0, skipped: 0, failed: 0, literal: 0 }),
        "plugin:app|version": () => "0.4.0",
        "plugin:notification|is_permission_granted": () => true,
      };
      window.__e2eInvoked = [];
      window.__e2eCalls = [];
      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback: (cb) => {
          const id = nextId++;
          callbacks.set(id, cb);
          return id;
        },
        unregisterCallback: (id) => callbacks.delete(id),
        runCallback: (id, data) => callbacks.get(id)?.(data),
        callbacks,
        invoke: (cmd, args) => {
          window.__e2eInvoked.push(cmd);
          window.__e2eCalls.push({ cmd, args: args == null ? null : structuredClone(args) });
          if (cmd === "plugin:event|listen") return Promise.resolve(nextId++);
          if (cmd === "plugin:event|unlisten") return Promise.resolve(null);
          const h = handlers[cmd];
          if (!h) return Promise.reject(new Error(`e2e-mock: unhandled command "${cmd}"`));
          return Promise.resolve(h(args));
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event, id) => callbacks.delete(id),
      };
    }, MOCK);

    const step = async (name, fn) => {
      await fn();
      console.log(`  ✓ ${name}`);
    };
    const commandCount = (name) =>
      page.evaluate((command) => window.__e2eCalls.filter((call) => call.cmd === command).length, name);
    const commandCalls = (name) =>
      page.evaluate((command) => window.__e2eCalls.filter((call) => call.cmd === command), name);
    const savedConfigCount = () => page.evaluate(() => window.__e2eSavedConfigs.length);
    const lastSavedConfig = () => page.evaluate(() => window.__e2eSavedConfigs.at(-1));
    const waitForCommandCount = (name, count) =>
      page.waitForFunction(
        ({ command, minimum }) =>
          window.__e2eCalls.filter((call) => call.cmd === command).length >= minimum,
        { command: name, minimum: count },
        { timeout: 15_000 },
      );
    const waitForSavedConfigCount = (count) =>
      page.waitForFunction(
        (minimum) => window.__e2eSavedConfigs.length >= minimum,
        count,
        { timeout: 15_000 },
      );

    console.log("E2E smoke");
    await step("app boots: brand header renders", async () => {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await expectVisible(page.getByRole("button", { name: "DSH Pro Max" }));
    });

    await step("home: nav + dsh card render from detection", async () => {
      await expectVisible(page.getByRole("button", { name: "Home" }));
      await expectVisible(page.getByRole("button", { name: "Settings" }));
      await expectVisible(page.locator("#dsh-remote-access-row"));
      await expectVisible(page.getByText("Node.js not detected"));
    });

    await step("settings: default General section renders", async () => {
      await page.getByRole("button", { name: "Settings" }).click();
      await expectVisible(page.locator("#settings-view"));
      await expectVisible(page.locator("#section-general"));
      // 干净草稿无保存条；制造脏状态后出现，Discard 回滚后再次隐藏
      assert.equal(await page.locator("#settings-footer").count(), 0, "save bar should be hidden while clean");
      await page.locator("#toggle-tray").click();
      await expectVisible(page.locator("#settings-footer"));
      await page.locator("#btn-discard-config").click();
      assert.equal(await page.locator("#settings-footer").count(), 0, "save bar should hide after discard");
    });

    await step("settings: About shows app version", async () => {
      await page.getByRole("button", { name: "About" }).click();
      await expectVisible(page.locator("#section-about"));
      const version = await page.locator("#about-version").innerText();
      assert.match(version, new RegExp(`v${APP_VERSION}`), `about version mismatch: ${version}`);
    });

    await step("plugins: discover default tab, installed tab with managed badge", async () => {
      await page.getByRole("button", { name: "Plugins" }).click();
      await expectVisible(page.locator("#market-view"));
      // 默认落在发现页（二级导航：发现 / 已安装）
      await expectVisible(page.locator("#market-search"));
      await expectVisible(page.getByText("Manual install only"));
      await page.getByRole("button", { name: "Installed" }).click();
      await expectVisible(page.locator("#market-installed"));
      await expectVisible(page.getByText("managed by launcher"));
    });

    await step("models: provider studio loads readiness and catalog facts", async () => {
      await page.getByRole("button", { name: "Models" }).click();
      await expectVisible(page.locator("#models-view"));
      await expectVisible(page.getByTestId("default-model-summary"));
      await expectVisible(page.locator("#btn-change-default-model"));
      await expectVisible(page.locator("#provider-row-0"));

      const readiness = page.getByTestId("provider-readiness-0");
      await expectVisible(readiness);
      assert.equal(await readiness.getAttribute("data-readiness"), "ready");

      const catalogStatus = page.getByTestId("catalog-status-line");
      await expectVisible(catalogStatus);
      assert.equal(await catalogStatus.getAttribute("data-catalog-source"), "snapshot");
      assert.equal(await catalogStatus.getAttribute("data-provider-count"), "1");

      await page.locator("#btn-refresh-catalog").click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="catalog-status-line"]')?.dataset.catalogSource === "remote",
      );
    });

    await step("models: reasoning changes save immediately", async () => {
      const before = await savedConfigCount();
      const reasoning = page.getByLabel("Reasoning Effort");
      assert.equal(await reasoning.getAttribute("data-reasoning-capability"), "supported");
      await reasoning.selectOption("medium");
      await waitForSavedConfigCount(before + 1);

      const saved = await lastSavedConfig();
      assert.equal(saved.defaultProvider, "spero-ai");
      assert.equal(saved.defaultModel, "glm-5.2");
      assert.equal(saved.defaultReasoningEffort, "medium");
    });

    await step("models: connection test and model discovery stay separate", async () => {
      const row = page.locator("#provider-row-0");
      const testsBefore = await commandCount("model_test_connection");
      const discoveryBefore = await commandCount("model_remote_list_with_headers");

      await row.getByRole("button", { name: "Test connection" }).click();
      await waitForCommandCount("model_test_connection", testsBefore + 1);
      assert.equal(
        await commandCount("model_remote_list_with_headers"),
        discoveryBefore,
        "connection test must not call model discovery",
      );
      const testCall = (await commandCalls("model_test_connection")).at(-1);
      assert.deepEqual(testCall.args, {
        baseUrl: "https://proxy.example.com/v1",
        api: "openai-responses",
        apiKeyEnv: "SPERO_AI_API_KEY",
        headers: null,
        model: "glm-5.2",
        apiKey: null,
      });

      await row.getByRole("button", { name: "Fetch list" }).click();
      await waitForCommandCount("model_remote_list_with_headers", discoveryBefore + 1);
      assert.equal(
        await commandCount("model_test_connection"),
        testsBefore + 1,
        "model discovery must not run an inference test",
      );
    });

    await step("models: custom provider auto-discovers a virtualized full candidate set", async () => {
      await page.locator("#btn-add-provider").click();
      const dialog = page.locator("#provider-dialog");
      await expectVisible(dialog);
      const servicePicker = dialog.getByTestId("preset-input");
      await expectVisible(servicePicker);
      assert.equal(await dialog.getByTestId("model-panes").count(), 0, "model panes should stay hidden before service selection");

      await servicePicker.click();
      await dialog.getByRole("option", { name: /Custom endpoint/ }).click();
      await expectVisible(dialog.getByTestId("model-panes"));
      await dialog.getByLabel("Display Name").fill("E2E Gateway");
      await dialog.getByLabel("Route key").fill("e2e-gateway");
      await dialog.getByLabel("API Key").fill("sk-e2e-test");
      await dialog.getByLabel("Wire Protocol").selectOption("openai-responses");

      const discoveryBefore = await commandCount("model_remote_list_with_headers");
      await dialog.getByLabel("Base URL").fill("https://e2e.example.com/v1");
      await dialog.getByLabel("Base URL").press("Tab");
      await waitForCommandCount("model_remote_list_with_headers", discoveryBefore + 1);

      const candidates = dialog.getByRole("list", { name: "Models from this service" });
      await page.waitForFunction(
        () => document.querySelector('#provider-dialog ul[aria-label="Models from this service"]')?.dataset.totalCount === "75",
      );
      assert.equal(await candidates.getAttribute("data-total-count"), "75");
      assert.ok(
        Number(await candidates.getAttribute("data-rendered-count")) < 75,
        "large candidate list should render only a window",
      );
      assert.equal(
        await candidates.getByRole("checkbox", { name: "e2e-model-074" }).count(),
        0,
        "deep rows should start outside the DOM window",
      );

      await candidates.evaluate((list) => {
        list.scrollTop = list.scrollHeight;
        list.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await expectVisible(candidates.getByRole("checkbox", { name: "e2e-model-074" }));

      const dialogTest = dialog.getByRole("button", { name: "Test connection" });
      assert.equal(await dialogTest.isDisabled(), true, "connection test needs a selected model");
      await dialog.getByRole("checkbox", { name: "Select all" }).check();
      assert.equal(await dialogTest.isEnabled(), true, "selecting models should enable connection test");

      const testsBefore = await commandCount("model_test_connection");
      await dialogTest.click();
      await waitForCommandCount("model_test_connection", testsBefore + 1);
      const testCall = (await commandCalls("model_test_connection")).at(-1);
      assert.equal(testCall.args.baseUrl, "https://e2e.example.com/v1");
      assert.equal(testCall.args.api, "openai-responses");
      assert.equal(testCall.args.apiKeyEnv, null);
      assert.equal(testCall.args.apiKey, "sk-e2e-test");
      assert.equal(testCall.args.model, "e2e-model-000");

      const savesBefore = await savedConfigCount();
      await dialog.locator("#btn-save-provider").click();
      await waitForSavedConfigCount(savesBefore + 1);
      await dialog.waitFor({ state: "detached" });
      await expectVisible(page.locator("#provider-row-1"));

      const saved = await lastSavedConfig();
      const added = saved.providers.find((provider) => provider.route === "e2e-gateway");
      assert.ok(added, "saved custom provider missing");
      assert.equal(added.models.length, 75, "Select all must persist the full filtered candidate set");
      assert.equal(added.models[74].id, "e2e-model-074");
      assert.equal(added.apiKeyEnv, "E2E_GATEWAY_API_KEY");
      const credentialSet = (await commandCalls("model_credential_set")).at(-1);
      assert.deepEqual(credentialSet.args, { name: "E2E_GATEWAY_API_KEY", value: "sk-e2e-test" });
    });

    await step("models: default switch clears invalid reasoning and delete falls back", async () => {
      const row = page.locator("#provider-row-1");
      const makeDefaultBefore = await savedConfigCount();
      await row.getByRole("button", { name: "Make default" }).click();
      await waitForSavedConfigCount(makeDefaultBefore + 1);

      let saved = await lastSavedConfig();
      assert.equal(saved.defaultProvider, "e2e-gateway");
      assert.equal(saved.defaultModel, "e2e-model-000");
      assert.equal(saved.defaultReasoningEffort, null, "unsupported reasoning must be cleared atomically");
      assert.equal((await page.getByTestId("default-model-summary").innerText()).trim(), "E2E Gateway · e2e-model-000");

      const deleteBefore = await savedConfigCount();
      await row.getByRole("button", { name: "Remove provider" }).click();
      await expectVisible(page.locator("#btn-confirm-delete-1"));
      await page.locator("#btn-confirm-delete-1").click();
      await waitForSavedConfigCount(deleteBefore + 1);
      await page.locator("#provider-row-1").waitFor({ state: "detached" });

      saved = await lastSavedConfig();
      assert.equal(saved.providers.length, 1);
      assert.equal(saved.defaultProvider, "spero-ai");
      assert.equal(saved.defaultModel, "glm-5.2");
      assert.equal(saved.defaultReasoningEffort, null);
      assert.equal((await page.getByTestId("default-model-summary").innerText()).trim(), "Spero AI · glm-5.2");
      await expectVisible(page.locator("#badge-default-0"));
    });

    await step("navigation returns home", async () => {
      await page.getByRole("button", { name: "Home" }).click();
      await expectVisible(page.locator("#dsh-remote-access-row"));
      assert.equal(await page.locator("#settings-view").count(), 0, "settings view should unmount");
    });

    await step("keyboard shortcut Cmd/Ctrl+, opens settings", async () => {
      await page.keyboard.press("ControlOrMeta+,");
      await expectVisible(page.locator("#settings-view"));
    });

    await step("boot chain used only mocked commands, no error toasts", async () => {
      const invoked = await page.evaluate(() => window.__e2eInvoked);
      for (const expected of [
        "load_config",
        "get_updater_config_health",
        "check_update",
        "dsh_detect",
        "model_config_load",
        "model_catalog_load",
        "model_catalog_refresh",
        "model_credential_describe",
        "model_credential_set",
        "model_credential_unset",
        "model_test_connection",
        "model_remote_list_with_headers",
        "model_config_save",
      ]) {
        assert.ok(invoked.includes(expected), `expected command not invoked: ${expected}`);
      }
      assert.equal(await savedConfigCount(), 4, "test/fetch/catalog actions must not add hidden model-config saves");
      assert.equal(await page.locator("#toast-container .toast.error").count(), 0, "error toast appeared");
    });

    if (failures.length) throw new Error(failures.join("\n"));
    console.log("E2E smoke: all steps passed");
  } catch (e) {
    const dir = resolve(ROOT, ".artifacts", "e2e");
    try {
      mkdirSync(dir, { recursive: true });
      await browser?.context()?.pages()[0]?.screenshot({ path: resolve(dir, "smoke-failure.png"), fullPage: true });
      console.error(`screenshot: ${resolve(dir, "smoke-failure.png")}`);
    } catch { /* 截图失败不掩盖原始错误 */ }
    throw e;
  } finally {
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  }

  async function expectVisible(locator) {
    await locator.first().waitFor({ state: "visible", timeout: 15_000 });
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
