// E2E 冒烟（playwright-core + vite dev server）：
// 验证壳渲染（品牌/导航/Home 卡片）与 Home ↔ Settings 导航，无报错 toast、无页面异常。
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
  },
};

async function main() {
  const server = await startVite();
  const browser = await launchBrowser();
  const failures = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));

    await page.addInitScript(({ config, dshStatus }) => {
      // 结构对齐 @tauri-apps/api/mocks.js 的 mockInternals：
      // 事件解绑路径依赖 __TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener 与回调注册表
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
        "plugin:app|version": () => "0.4.0",
        "plugin:notification|is_permission_granted": () => true,
      };
      window.__e2eInvoked = [];
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
        invoke: (cmd) => {
          window.__e2eInvoked.push(cmd);
          if (cmd === "plugin:event|listen") return Promise.resolve(nextId++);
          if (cmd === "plugin:event|unlisten") return Promise.resolve(null);
          const h = handlers[cmd];
          if (!h) return Promise.reject(new Error(`e2e-mock: unhandled command "${cmd}"`));
          return Promise.resolve(h());
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
      await expectVisible(page.getByRole("button", { name: "Save Settings" }));
    });

    await step("settings: About shows app version", async () => {
      await page.getByRole("button", { name: "About" }).click();
      await expectVisible(page.locator("#section-about"));
      const version = await page.locator("#about-version").innerText();
      assert.match(version, new RegExp(`v${APP_VERSION}`), `about version mismatch: ${version}`);
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
      for (const expected of ["load_config", "get_updater_config_health", "check_update", "dsh_detect"]) {
        assert.ok(invoked.includes(expected), `expected command not invoked: ${expected}`);
      }
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
