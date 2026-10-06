#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
// 这是可被另一项目测试进程复用的驱动，只加载自动化库，避免再初始化一份测试运行器。
import { chromium } from "playwright";
import {
  labReadingUrl,
  openLabReadingPage,
  installedTutorial,
  activateLabPage,
} from "./lib/lab-startup-pages.mjs";
import { labProxy } from "./lab-network.mjs";
import {
  browserRoot,
  defaultDesktopRoot,
  checkConnectedEnvironment,
  buildConnectedProjects,
  runtimeEnvironment,
  treeHashes,
  sourceRevision,
  CONNECTOR_VERSION,
} from "./lib/connected-lab-environment.mjs";
import { startConnectedReadingServer } from "./lib/connected-lab-reading.mjs";
import { installManualDesktopCommands } from "./lib/connected-lab-terminal.mjs";
import { startConnectedCliWorker } from "./lib/connected-lab-cli.mjs";

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(check, timeout, message, signal) {
  const deadline = Date.now() + timeout;
  do {
    signal?.throwIfAborted();
    if (await check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(message);
}
async function bounded(promise, timeout, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

// 以本轮当前子进程为准：明确停机可重开浏览器，存活进程的就绪失败不能被跳过。
export async function verifyDesktopRegistrationIfRunning(child, verify) {
  if (child === undefined) return { ready: false, reason: "desktop-stopped" };
  if (child.exitCode !== null || child.signalCode !== null || child.spawnError)
    throw new Error("本轮 Desktop 子进程已退出，不能交付来源就绪");
  return verify(child);
}

/**
 * 手工入口可见；程序调用默认后台。所有资料、Native 注册与进程都归本会话。
 * 不自动配对/接管，不改生产包，不触碰系统键鼠或日常浏览器注册。
 */
export async function startConnectedLab({
  desktopRoot = defaultDesktopRoot,
  extensionDir = path.join(browserRoot, ".output/chrome-mv3"),
  headless = true,
  readingUrl,
  startupPage = headless ? "workspace" : "tutorial",
  navigationTimeout = 20000,
  outputDir,
  onStatus = console.log,
  signal,
  beforeClose,
} = {}) {
  signal?.throwIfAborted();
  readingUrl = labReadingUrl({ headless, readingUrl });
  if (!["tutorial", "workspace"].includes(startupPage))
    throw new Error("启动页只能是 tutorial 或 workspace");
  const checked = checkConnectedEnvironment({ desktopRoot, extensionDir });
  const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));
  const { _electron } = desktopRequire("playwright");
  const { startFocusMonitor } = desktopRequire("./tests/helpers/macos-focus-monitor.cjs");
  const { registerIsolatedHost } = desktopRequire("./scripts/lmcp/register-host.cjs");
  const { unregisterNativeHost } = desktopRequire(
    "./electron/services/lmcp/native-registration.cjs",
  );
  const { buildNativeHost } = desktopRequire("./scripts/lmcp/build-host.cjs");
  const { verifyDesktopHandoff, waitRegisteredOrigin } = desktopRequire(
    "./scripts/accept-connected.cjs",
  );
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-lab-"));
  const profileDir = path.join(ownedRoot, "desktop");
  const browserProfile = path.join(profileDir, "browser-profile/chrome");
  const copiedExtension = path.join(ownedRoot, "extension");
  const id = randomUUID();
  const evidence = {
    format: "leximeet.connected-lab/1",
    id,
    startedAt: new Date().toISOString(),
    headless,
    ready: false,
    versions: {
      browser: checked.browserVersion,
      desktop: checked.desktopVersion,
      contract: checked.contractVersion,
      digest: checked.contractDigest,
    },
    platform: checked.platform,
    ownedRoot,
    profileDir,
    browserProfile,
    manifestUnchanged: null,
    productionBytesUnchanged: null,
    java: checked.java,
    nativePanel: false,
    processes: { launcher: process.pid, desktop: [], browser: [] },
    cleanupErrors: [],
    testScenarioPassed: null,
  };
  const record = () => {
    if (!outputDir) return;
    const file = path.join(outputDir, "connected-lab.json"),
      temporary = `${file}.${id}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  };
  let sourceHashes, nativeBundle, env;
  try {
    if (outputDir) fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    sourceHashes = treeHashes(extensionDir);
    fs.cpSync(extensionDir, copiedExtension, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    if (JSON.stringify(treeHashes(copiedExtension)) !== JSON.stringify(sourceHashes))
      throw new Error("生产扩展副本不一致");
    evidence.sourceHashes = sourceHashes;
    evidence.manifestUnchanged = true;
    evidence.productionBytesUnchanged = true;
    evidence.sourceRevisions = {
      browser: sourceRevision(browserRoot),
      desktop: sourceRevision(desktopRoot),
      core: sourceRevision(path.join(desktopRoot, "core-java")),
    };
    const fingerprint = (file) =>
      createHash("sha256")
        .update(fs.readFileSync(path.join(desktopRoot, file)))
        .digest("hex");
    evidence.desktopSourceHashes = {
      "package.json": fingerprint("package.json"),
      "core-java/target/leximeet-core.jar": fingerprint(
        "core-java/target/leximeet-core.jar",
      ),
      ...Object.fromEntries(
        ["electron", "frontend/dist", "resources/lmcp"].flatMap((directory) =>
          Object.entries(treeHashes(path.join(desktopRoot, directory))).map(
            ([file, hash]) => [`${directory}/${file}`, hash],
          ),
        ),
      ),
    };
    nativeBundle = buildNativeHost({
      projectDir: desktopRoot,
      outputDir: path.join(ownedRoot, "native-host"),
    });
    evidence.nativeHost = {
      runtime: "electron-run-as-node",
      files: nativeBundle.files,
    };
    // 环境装配也属于初始化：失败须撤回已创建的本轮目录。
    env = runtimeEnvironment({
      desktopRoot,
      profileDir,
      headless,
      java: checked.java,
    });
  } catch (error) {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
    throw error;
  }
  let desktop,
    desktopPage,
    desktopChild,
    context,
    worker,
    browserCdp,
    browserPid,
    reading,
    workspace,
    tutorial,
    server,
    registration,
    focusMonitor;
  let closing,
    stopReason = "normal",
    startingDesktop = false,
    desktopReadinessDeadline,
    onBrowserClosed;
  let releaseStartup;
  const startupFinished = new Promise((resolve) => {
    releaseStartup = resolve;
  });
  let resolveClosed, rejectClosed;
  const closed = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => {});
  const logs = [];
  let logBytes = 0;
  const append = (origin, bytes) => {
    const line = `[${origin}] ${String(bytes).trimEnd()}\n`;
    logs.push(line);
    logBytes += line.length;
    while (logBytes > 1024 * 1024 && logs.length > 1) logBytes -= logs.shift().length;
  };
  function assertBytes() {
    try {
      evidence.manifestUnchanged = null;
      const copiedHashes = treeHashes(copiedExtension);
      const currentHashes = treeHashes(extensionDir);
      evidence.manifestUnchanged =
        copiedHashes["manifest.json"] === sourceHashes["manifest.json"] &&
        currentHashes["manifest.json"] === sourceHashes["manifest.json"];
      if (
        JSON.stringify(copiedHashes) !== JSON.stringify(sourceHashes) ||
        JSON.stringify(currentHashes) !== JSON.stringify(sourceHashes)
      )
        throw new Error("本轮运行期间生产扩展或独占副本改变");
      for (const [file, hash] of Object.entries(evidence.desktopSourceHashes))
        if (
          createHash("sha256")
            .update(fs.readFileSync(path.join(desktopRoot, file)))
            .digest("hex") !== hash
        )
          throw new Error(`本轮 Desktop / Core 构建改变：${file}`);
      for (const item of nativeBundle.files) {
        const source =
          item.path === "host/main.cjs"
            ? "electron/native-host/main.cjs"
            : `electron/${item.path}`;
        if (
          createHash("sha256")
            .update(fs.readFileSync(path.join(desktopRoot, source)))
            .digest("hex") !== item.sha256
        )
          throw new Error(`本轮 Native Host 来源改变：${source}`);
      }
      evidence.productionBytesUnchanged = true;
      evidence.bytesVerifiedAt = new Date().toISOString();
    } catch (error) {
      evidence.productionBytesUnchanged = false;
      throw error;
    }
  }
  async function stopBrowser() {
    const current = context,
      pid = browserPid;
    if (!current) return;
    const errors = [];
    try {
      await bounded(current.close(), 20000, "本轮 Chromium 退出超时");
      if (pid) await until(() => !alive(pid), 5000, "本轮 Chromium PID 仍然存在");
    } catch (error) {
      errors.push(error);
      // Playwright 在 POSIX 为浏览器创建独立组；只能结束实际核对过的本轮 PID。
      if (pid)
        try {
          process.platform === "win32"
            ? process.kill(pid, "SIGKILL")
            : process.kill(-pid, "SIGKILL");
          await until(() => !alive(pid), 5000, "本轮 Chromium 强制退出超时");
        } catch (failure) {
          if (failure.code !== "ESRCH") errors.push(failure);
        }
    } finally {
      context = undefined;
      browserCdp = undefined;
      browserPid = undefined;
      evidence.browserStoppedAt = new Date().toISOString();
      record();
    }
    if (errors.length) throw new AggregateError(errors, "本轮 Chromium 清理失败");
  }
  async function stopDesktop() {
    const current = desktop,
      child = desktopChild;
    if (!current) return;
    const errors = [];
    try {
      await bounded(current.close(), 20000, "本轮 Desktop 退出超时");
      await until(() => !alive(child.pid), 5000, "本轮 Desktop PID 仍然存在");
      if (process.platform !== "win32") {
        await until(
          () => {
            try {
              process.kill(-child.pid, 0);
              return false;
            } catch (error) {
              if (error.code === "ESRCH") return true;
              throw error;
            }
          },
          2000,
          "本轮 Desktop 进程组仍有残留",
        );
      }
    } catch (error) {
      errors.push(error);
      // 退出失败只清理本次 Playwright 创建的组，保留失败证据。
      try {
        process.platform === "win32"
          ? child.kill("SIGKILL")
          : process.kill(-child.pid, "SIGKILL");
      } catch (failure) {
        if (failure.code !== "ESRCH") errors.push(failure);
      }
    } finally {
      desktop = undefined;
      desktopPage = undefined;
      desktopChild = undefined;
      evidence.desktopStoppedAt = new Date().toISOString();
      record();
    }
    if (errors.length) throw new AggregateError(errors, "本轮 Desktop 清理失败");
  }
  function assertDesktopStartActive() {
    signal?.throwIfAborted();
    if (closing)
      throw Object.assign(new Error("本轮会话正在结束，取消 Desktop 重启"), {
        code: "LAB_CLOSING",
      });
  }
  // 真实角色、可见性与 inert 都通过后才算页面就绪，不替用户处理邀请。
  async function waitDesktopUiReady() {
    await until(
      async () => {
        assertDesktopStartActive();
        const snapshot = await desktopPage.evaluate(async () => {
          const runtime = await window.leximeet.runtime();
          if (!runtime.coreConnected || !document.querySelector(".status-state i.ready"))
            return null;
          const { guide } = await window.leximeet.desktopState();
          return guide && typeof guide === "object" ? { runtime, guide } : null;
        });
        if (!snapshot) return false;
        const guide = snapshot.guide;
        if (guide.active && !guide.finishedAt) {
          const card = guide.started
            ? desktopPage.locator('.guide-coach[role="dialog"]')
            : desktopPage.getByRole("dialog", {
                name: "欢迎使用词遇",
                exact: true,
              });
          if ((await card.count()) !== 1 || !(await card.isVisible())) return false;
          if (
            await card.evaluate((node) =>
              Boolean(node.closest('[inert], [aria-hidden="true"]')),
            )
          )
            return false;
          const skip = card.getByRole("button", {
            name: "跳过教学",
            exact: true,
          });
          if (!(await skip.isVisible()) || !(await skip.isEnabled())) return false;
        } else if (await desktopPage.locator(".guide-invitation, .guide-overlay").count())
          return false;
        evidence.desktopRuntime = {
          profile: snapshot.runtime.profile,
          coreConnected: snapshot.runtime.coreConnected,
          connectorProtocolVersion: snapshot.runtime.connectorProtocolVersion,
        };
        evidence.desktopUiReady = {
          guide:
            guide.active && !guide.finishedAt
              ? guide.started
                ? "teaching"
                : "invitation"
              : "inactive",
          accessible: true,
        };
        evidence.desktopUiReadyAt = new Date().toISOString();
        return true;
      },
      Math.max(1, desktopReadinessDeadline - Date.now()),
      "Desktop 资料与可交互教学界面尚未就绪",
      signal,
    );
  }
  async function startDesktop() {
    assertDesktopStartActive();
    if (desktop || startingDesktop) throw new Error("Desktop 已运行或正在启动");
    startingDesktop = true;
    try {
      desktop = await _electron.launch({
        executablePath: checked.executable,
        args: [desktopRoot, "--env=prod"],
        cwd: desktopRoot,
        env,
        timeout: 60000,
      });
      desktopChild = desktop.process();
      evidence.processes.desktop.push(desktopChild.pid);
      focusMonitor?.track(desktopChild.pid);
      desktopChild.stdout?.on("data", (value) => append("desktop.stdout", value));
      desktopChild.stderr?.on("data", (value) => append("desktop.stderr", value));
      // spawn 已返回时先保存本轮 PID，再检查关闭，清理才能接管新进程。
      assertDesktopStartActive();
      await until(
        () => {
          assertDesktopStartActive();
          return desktop
            .windows()
            .some((page) => /\/frontend\/dist\/index\.html(?:$|[?#])/.test(page.url()));
        },
        60000,
        "Desktop 主页面尚未就绪",
        signal,
      );
      desktopPage = desktop
        .windows()
        .find((page) => /\/frontend\/dist\/index\.html(?:$|[?#])/.test(page.url()));
      desktopPage.on("pageerror", (error) => append("desktop.pageerror", error.message));
      assertDesktopStartActive();
      const runtime = await desktopPage.evaluate(() => window.leximeet.runtime());
      // 先保留实际观察值；旧协议被拒时也能明确看到 observed rc.4。
      evidence.desktopRuntime = {
        profile: runtime.profile,
        coreConnected: runtime.coreConnected,
        connectorProtocolVersion: runtime.connectorProtocolVersion,
      };
      record();
      if (
        fs.realpathSync(runtime.dataDir) !== fs.realpathSync(profileDir) ||
        runtime.profile !== (headless ? "test" : "demo")
      )
        throw new Error("Desktop 未使用本轮隔离资料");
      if (runtime.connectorProtocolVersion !== `lmcp/${CONNECTOR_VERSION}`)
        throw new Error("Desktop 实际运行协议不是 rc.6；请等待桌面端候选更新后重新构建");
      // Core 就绪与两端启动后的最后核验合用原 60 秒截止时间。
      desktopReadinessDeadline = Date.now() + 60000;
      await waitDesktopUiReady();
      assertDesktopStartActive();
      const descriptor = path.join(profileDir, "native-messaging/lmcp-uds.json");
      await until(
        () => fs.existsSync(descriptor),
        15000,
        "Desktop 私有 Native 通道未就绪",
        signal,
      );
      const descriptorStat = fs.lstatSync(descriptor);
      if (
        !descriptorStat.isFile() ||
        descriptorStat.isSymbolicLink() ||
        descriptorStat.mode & 0o077
      )
        throw new Error("Desktop Native descriptor 权限不安全");
      // 仅留下本轮实例身份；私有descriptor令牌不进入验收记录或浏览器。
      const { instanceId } = desktopRequire(
        "./electron/services/lmcp/private-files.cjs",
      ).readPrivateJson(descriptor);
      evidence.desktopGateway = { instanceId };
      if (registration && evidence.extensionId)
        evidence.registrationReady = await waitRegisteredOrigin(
          profileDir,
          desktopChild,
          evidence.extensionId,
          instanceId,
          {
            timeoutMs: Math.max(1, desktopReadinessDeadline - Date.now()),
            active: assertDesktopStartActive,
          },
        );
      if (headless) {
        const background = await desktop.evaluate(() =>
          globalThis.__leximeetTestBackground.snapshot(),
        );
        if (!background.active || !background.audioMuted || background.violations.length)
          throw new Error("Desktop 后台保护未生效");
        const windows = await desktop.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused(),
            focusable: window.isFocusable(),
          })),
        );
        if (
          !windows.length ||
          windows.some((window) => window.visible || window.focused || window.focusable)
        )
          throw new Error("自动回归不得显示或聚焦 Desktop 窗口");
        evidence.desktopBackground = { ...background, windows };
      }
      record();
      return desktopPage;
    } finally {
      startingDesktop = false;
    }
  }
  async function launchBrowser() {
    fs.mkdirSync(browserProfile, { recursive: true, mode: 0o700 });
    fs.chmodSync(browserProfile, 0o700);
    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
    const proxy = readingUrl === "local" ? null : await labProxy();
    context = await chromium.launchPersistentContext(browserProfile, {
      channel: "chromium",
      headless,
      viewport: null,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      env,
      ...(proxy ? { proxy } : {}),
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        `--disable-extensions-except=${copiedExtension}`,
        `--load-extension=${copiedExtension}`,
        "--enable-unsafe-extension-debugging",
        "--window-size=1440,1000",
        "--no-first-run",
        "--disable-sync",
        "--disable-background-networking",
      ],
    });
    browserCdp = await context.browser().newBrowserCDPSession();
    const version = await browserCdp.send("Browser.getVersion");
    if (version.userAgent.includes("HeadlessChrome/") !== headless)
      throw new Error("真实 Chromium 运行方式与请求不一致");
    browserPid = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo.find(
      (item) => item.type === "browser",
    )?.id;
    if (!browserPid) throw new Error("无法核对本轮 Chromium PID");
    evidence.processes.browser.push(browserPid);
    focusMonitor?.track(browserPid);
    evidence.chromium = version.product;
    worker =
      context
        .serviceWorkers()
        .find((candidate) => candidate.url().startsWith("chrome-extension://")) ||
      (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    await until(
      () => worker.evaluate(() => chrome.action.onClicked.hasListeners()),
      15000,
      "生产扩展后台未就绪",
      signal,
    );
    const extensionId = new URL(worker.url()).hostname;
    evidence.extensionId = extensionId;
    if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("真实扩展 ID 无效");
    // 配对前只登记本次 profile 的来源；授权码仍必须通过实际产品 UI 确认。
    registration = registerIsolatedHost({
      profileRoot: profileDir,
      browserDataDir: browserProfile,
      extensionId,
      electronExecutable: checked.executable,
      hostScript: nativeBundle.hostScript,
    });
    evidence.registration = {
      isolated: registration.isolated,
      hostName: registration.hostName,
      manifestPath: registration.manifestPath,
    };
    // 本轮明确停机后仍允许浏览器重开以验证失联封存；不拉起Desktop或沿用旧ready。
    // 有当前活进程时，真实来源核验及原截止时间继续严格执行。
    evidence.registrationReady = await verifyDesktopRegistrationIfRunning(
      desktopChild,
      (child) =>
        waitRegisteredOrigin(
          profileDir,
          child,
          extensionId,
          evidence.desktopGateway.instanceId,
          {
            timeoutMs: Math.max(1, desktopReadinessDeadline - Date.now()),
            active: assertDesktopStartActive,
          },
        ),
    );
    record();
    const firstInstall = evidence.processes.browser.length === 1;
    if (firstInstall)
      tutorial = await installedTutorial({ context, extensionId, signal });
    else
      tutorial = context
        .pages()
        .find((page) => page.url() === `chrome-extension://${extensionId}/tutorial.html`);
    for (const page of context.pages())
      if (page.url() === "about:blank") await page.close();
    workspace = await context.newPage();
    await workspace.goto(`chrome-extension://${extensionId}/options.html#/settings`);
    // 最后一次 Desktop 就绪核验先完成，外网文档不能消耗它原有的 60 秒预算。
    // 同一轮浏览器断线重启时 Desktop 可能已停止，不强迫重新等待它。
    if (firstInstall) await waitDesktopUiReady();
    const opened = await openLabReadingPage({
      context,
      readingUrl,
      localUrl: server.localUrl,
      navigationTimeout,
      signal,
      onStatus,
    });
    reading = opened.reading;
    evidence.readingUrl = opened.url;
    evidence.requestedReadingUrl = opened.requestedUrl;
    evidence.readingFallback = opened.fallback;
    evidence.localUrl = server.localUrl;
    // 首装必须交付真实教学页；同一资料重启后不重置进度或补造教学。
    evidence.startupUrl = await activateLabPage({
      tutorial,
      workspace,
      startupPage: tutorial ? startupPage : "workspace",
    });
    // 外站导航后只读一次真实状态；不重开等待预算，也不强迫 Desktop 已停的浏览器重启恢复。
    if (firstInstall)
      evidence.desktopHandoffRendered = await verifyDesktopHandoff(desktopPage, {
        active: assertDesktopStartActive,
      });
    onBrowserClosed = () => {
      stopReason = "browser-closed";
      void close().catch(() => {});
    };
    context.once("close", onBrowserClosed);
    return extensionId;
  }
  function close() {
    if (closing) return closing;
    closing = (async () => {
      const errors = [];
      const run = async (operation) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error.message);
        }
      };
      // 人工终端先停收输入并等待在途命令，避免 restart 与清理竞争。
      const manualDrain = run(() => beforeClose?.());
      await startupFinished;
      await manualDrain;
      await run(stopBrowser);
      await run(stopDesktop);
      if (registration)
        await run(async () =>
          unregisterNativeHost({ ...registration, profileRoot: profileDir }),
        );
      await run(() => server?.close() || Promise.resolve());
      await run(async () => assertBytes());
      if (focusMonitor)
        await run(async () => {
          evidence.focus = await focusMonitor.stop();
          if (!evidence.focus.complete || evidence.focus.violations.length)
            throw new Error("后台自动化激活了本轮窗口或焦点监测不完整");
        });
      evidence.ready = false;
      evidence.stoppedAt = new Date().toISOString();
      evidence.stopReason = stopReason;
      evidence.cleanupErrors = errors;
      if (!errors.length) fs.rmSync(ownedRoot, { recursive: true, force: true });
      else evidence.retainedRoot = ownedRoot;
      evidence.profileRemoved = !fs.existsSync(ownedRoot);
      if (outputDir)
        fs.writeFileSync(path.join(outputDir, "desktop.log"), logs.join(""), {
          mode: 0o600,
        });
      record();
      signal?.removeEventListener("abort", onAbort);
      if (errors.length)
        throw new AggregateError(
          errors.map((message) => new Error(message)),
          "双端隔离环境清理失败，保留本轮资料供检查",
        );
      onStatus("词遇双端隔离验收环境已关闭，本轮临时资料和 Native 注册已清理。");
    })();
    closing.then(resolveClosed, rejectClosed);
    return closing;
  }
  const onAbort = () => {
    stopReason = "cancelled";
    void close().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    focusMonitor = headless ? await startFocusMonitor({ root: desktopRoot }) : undefined;
    signal?.throwIfAborted();
    server = await startConnectedReadingServer();
    await startDesktop();
    const extensionId = await launchBrowser();
    signal?.throwIfAborted();
    // 首次教学和连接均由用户选择；启动器不跳过教学或代替用户确认邀请。
    evidence.ready = true;
    record();
    releaseStartup();
    onStatus(
      `词遇双端隔离环境已启动\n运行方式：${headless ? "无界面自动化" : "可见人工验收"}\n扩展 ID：${extensionId}\n阅读页：${evidence.readingUrl}\n临时资料：${ownedRoot}\n在 Desktop「设置 → 插件连接」或插件「账号与桌面端」点击连接，再在浏览器独立弹窗点击「确认连接」。\n仅注册本轮隔离 Chromium；不合并或上传独立资料。关闭浏览器或 Ctrl+C 结束并清理。`,
    );
    return {
      id,
      ownedRoot,
      profileDir,
      browserProfile,
      copiedExtension,
      extensionId,
      headless,
      evidence,
      saveEvidence: record,
      closed,
      close,
      get desktop() {
        return desktop;
      },
      get desktopPage() {
        return desktopPage;
      },
      get context() {
        return context;
      },
      get worker() {
        return worker;
      },
      get workspace() {
        return workspace;
      },
      get reading() {
        return reading;
      },
      url: evidence.readingUrl,
      localUrl: server.localUrl,
      async stopDesktop() {
        await stopDesktop();
      },
      async restartBrowser() {
        assertBytes();
        const previousId = evidence.extensionId;
        context.removeListener("close", onBrowserClosed);
        await stopBrowser();
        const nextId = await launchBrowser();
        if (nextId !== previousId) throw new Error("同一生产副本重启后的扩展身份改变");
        return context;
      },
      async restartDesktop() {
        assertBytes();
        await stopDesktop();
        return startDesktop();
      },
      async openPanel(page = reading) {
        await page.bringToFront();
        const targets = (
          await browserCdp.send("Target.getTargets", {
            filter: [{ type: "tab", exclude: false }],
          })
        ).targetInfos.filter((target) => target.url === page.url());
        if (targets.length !== 1) throw new Error("侧栏动作必须指向本轮唯一阅读标签");
        await browserCdp.send("Extensions.triggerAction", {
          id: extensionId,
          targetId: targets[0].targetId,
        });
        const url = `chrome-extension://${extensionId}/sidepanel.html`;
        await until(
          () => context.pages().some((candidate) => candidate.url() === url),
          15000,
          "真实侧栏没有打开",
        );
        const panel = context.pages().find((candidate) => candidate.url() === url);
        const contexts = await panel.evaluate(() =>
          chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }),
        );
        if (!contexts.some((item) => item.documentUrl === url))
          throw new Error("连接验收需要真实 SIDE_PANEL，不能用普通标签替代");
        evidence.nativePanel = true;
        record();
        return panel;
      },
    };
  } catch (error) {
    evidence.error = error.message;
    record();
    releaseStartup();
    await close();
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2),
    flags = new Set(["--headless", "--no-build", "--check", "--help"]);
  if (args.some((arg) => !flags.has(arg)) || new Set(args).size !== args.length)
    throw new Error("支持 --headless、--no-build、--check、--help");
  if (args.includes("--help")) {
    console.log(
      "词遇双端隔离验收：npm run lab:connected\n默认构建并启动可见 Desktop + Chromium；--no-build 复用已构建候选；--headless 后台运行；--check 仅检查候选。\n需要 Node.js 24+、JDK 21、两个项目依赖与 Playwright Chromium。当前本地 Native Host 仅完成 macOS。\n不会自动配对、合并资料或改日常浏览器配置；Ctrl+C 等待本轮进程与资料清理。",
    );
    return;
  }
  if (args.includes("--check")) {
    console.log(JSON.stringify(checkConnectedEnvironment(), null, 2));
    console.log("仅候选声明与工具检查通过；尚未启动或验证真实连接。");
    return;
  }
  const controller = new AbortController();
  const stop = (name) => {
    process.exitCode = name === "SIGINT" ? 130 : 143;
    controller.abort(new Error("双端启动或运行已取消"));
  };
  const onInt = () => stop("SIGINT"),
    onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let session, terminalCommands;
  try {
    if (!args.includes("--no-build"))
      await buildConnectedProjects({ signal: controller.signal });
    const outputDir = path.join(browserRoot, "test-results/connected-lab", randomUUID());
    // Electron 的自动化库会自行处理 SIGINT 并直接退出所在进程。
    // 会话放入独立 worker，由 CLI 主线程持有信号，完整清理后才结束程序。
    session = await startConnectedCliWorker({
      entrypoint: new URL(import.meta.url),
      options: {
        headless: args.includes("--headless"),
        readingUrl: process.env.LEXIMEET_LAB_URL || undefined,
        outputDir,
      },
      signal: controller.signal,
    });
    console.log(`本轮记录：${path.join(outputDir, "connected-lab.json")}`);
    terminalCommands = installManualDesktopCommands({
      session,
      headless: session.headless,
      signal: controller.signal,
      onInterrupt: () => stop("SIGINT"),
    });
    await session.closed;
  } catch (error) {
    if (error !== controller.signal.reason) throw error;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    try {
      await terminalCommands?.close();
    } finally {
      await session?.close();
    }
  }
}
// worker 只接收命名操作，不向主线程返回页面、凭据或任意执行能力。
async function runCliWorker() {
  const controller = new AbortController();
  let session,
    pending = Promise.resolve(),
    commandRunning = false,
    failure;
  parentPort.on("message", (message) => {
    if (message?.type === "cancel") {
      controller.abort(new Error("双端启动或运行已取消"));
      return;
    }
    if (message?.type !== "command" || !Number.isSafeInteger(message.id)) return;
    const reply = (error) =>
      parentPort.postMessage({
        type: "response",
        id: message.id,
        ...(error
          ? {
              error: error.message,
              ...(controller.signal.aborted || error.code === "LAB_CLOSING"
                ? { errorCode: "LAB_CLOSING" }
                : {}),
            }
          : {}),
      });
    if (
      !session ||
      controller.signal.aborted ||
      commandRunning ||
      !["stop", "restart"].includes(message.action)
    ) {
      reply(new Error("本轮会话正在启动、操作或结束，不能排队重启"));
      return;
    }
    commandRunning = true;
    pending = (async () => {
      try {
        if (message.action === "stop") await session.stopDesktop();
        else await session.restartDesktop();
        reply();
      } catch (error) {
        reply(error);
      } finally {
        commandRunning = false;
      }
    })();
  });
  try {
    session = await startConnectedLab({
      ...workerData.options,
      signal: controller.signal,
      onStatus: (message) => parentPort.postMessage({ type: "status", message }),
      beforeClose: () => pending,
    });
    parentPort.postMessage({ type: "ready" });
    await session.closed;
  } catch (error) {
    if (error !== controller.signal.reason) failure = error;
  } finally {
    try {
      await session?.close();
    } catch (error) {
      failure ||= error;
    }
    parentPort.postMessage({
      type: "closed",
      ...(failure ? { error: failure.message } : {}),
    });
    parentPort.close();
  }
}
if (!isMainThread && workerData?.kind === "leximeet.connected-cli/1") {
  void runCliWorker();
} else if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
