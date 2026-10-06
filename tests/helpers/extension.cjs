"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { createHash } = require("node:crypto");

// 字节清单覆盖 manifest 和全部生产脚本；测试不得追加站点权限或替换后台。
function hashes(directory, prefix = "") {
  return Object.fromEntries(
    fs
      .readdirSync(path.join(directory, prefix), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const name = path.join(prefix, entry.name);
        return entry.isDirectory()
          ? Object.entries(hashes(directory, name))
          : [
              [
                name,
                createHash("sha256")
                  .update(fs.readFileSync(path.join(directory, name)))
                  .digest("hex"),
              ],
            ];
      }),
  );
}
async function attach(testInfo, name, value) {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json",
  });
}

// 仅连接本例 Chromium 的回环 CDP；测正式 MV3 worker，而非测试进程的堆。
async function sampleWorkerHeap(profile, workerUrl) {
  const portFile = path.join(profile, "DevToolsActivePort");
  const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("本例 Chromium 调试端口无效");
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("无法读取本例 Chromium CDP 入口");
  const endpoint = (await response.json()).webSocketDebuggerUrl;
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("本例 Chromium CDP 连接超时"));
    }, 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
      { once: true },
    );
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    message.error
      ? call.reject(new Error(message.error.message))
      : call.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  try {
    const targets = (await send("Target.getTargets")).targetInfos;
    const workers = targets.filter(
      (target) => target.type === "service_worker" && target.url === workerUrl,
    );
    if (workers.length !== 1) throw new Error("本例正式 WXT worker 不唯一或尚未启动");
    const { sessionId } = await send("Target.attachToTarget", {
      targetId: workers[0].targetId,
      flatten: true,
    });
    let stopped = false;
    let failure;
    const samples = [];
    const loop = (async () => {
      while (!stopped) {
        try {
          const usage = await send("Runtime.getHeapUsage", {}, sessionId);
          samples.push({
            at: Date.now(),
            usedBytes: usage.usedSize,
            totalBytes: usage.totalSize,
            embedderBytes: usage.embedderHeapUsedSize,
          });
        } catch (error) {
          failure = error;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    return {
      async stop() {
        stopped = true;
        try {
          await loop;
          if (failure) throw failure;
          if (samples.length < 2) throw new Error("正式 WXT worker 内存采样不足");
          return {
            samples: samples.length,
            firstUsedBytes: samples[0].usedBytes,
            lastUsedBytes: samples.at(-1).usedBytes,
            peakUsedBytes: Math.max(...samples.map((sample) => sample.usedBytes)),
            peakTotalBytes: Math.max(...samples.map((sample) => sample.totalBytes)),
            peakEmbedderBytes: Math.max(...samples.map((sample) => sample.embedderBytes)),
          };
        } finally {
          socket.close();
        }
      },
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}

// 一个测试一个 HTTP 端口，只提供人工构造的阅读材料，不访问真实网站。
async function readingServer(html, { cacheControl = "no-store" } = {}) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": cacheControl,
    });
    response.end(typeof html === "function" ? html(request.url) : html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

/**
 * 真实 MV3 测试驱动。没有鼠标/键盘系统事件、日常 profile 或测试版 manifest。
 * CDP 只负责浏览器安装/action/故障注入；业务步骤由真实 UI 操作。
 * PW 的 other-target 开关是有版本约束的测试适配层，不进入扩展生产代码。
 */
async function launchExtension({
  chromium,
  expect,
  testInfo,
  headless = testInfo.project.use.headless ?? true,
  browserDataDir,
  manageTrace = true,
  workerMetrics = false,
  browserChannel = process.env.LEXIMEET_TEST_BROWSER || "chromium",
  enableBackForwardCache = false,
  buildDir = path.resolve(__dirname, "../../.output/chrome-mv3"),
}) {
  if (!["chromium", "chrome", "msedge"].includes(browserChannel))
    throw new Error(
      "验收浏览器仅支持 chromium、chrome 或 msedge；不存在时失败，不静默回退",
    );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-extension-"));
  const extension = path.join(root, "extension");
  const profile = browserDataDir || path.join(root, "chromium");
  let context;
  const errors = [],
    blocked = [];
  try {
    // 外部目录只能属于 Desktop test profile；不能把日常浏览器传入驱动。
    if (browserDataDir) {
      const marker = path.join(path.dirname(profile), "profile.json");
      if (
        path.basename(profile) !== "browser-sandbox" ||
        !fs.existsSync(marker) ||
        JSON.parse(fs.readFileSync(marker)).profile !== "test" ||
        (fs.existsSync(profile) && fs.readdirSync(profile).length)
      )
        throw new Error("浏览器 fixture 只接受 test profile 内空的 browser-sandbox 目录");
    }
    fs.cpSync(buildDir, extension, { recursive: true, errorOnExist: true });
    let sourceHashes = hashes(buildDir);
    expect(hashes(extension)).toEqual(sourceHashes);
    const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json")));
    expect(manifest.host_permissions).toEqual(["http://*/*", "https://*/*"]);
    expect(manifest.content_scripts).toEqual([
      {
        matches: ["http://*/*", "https://*/*"],
        all_frames: false,
        run_at: "document_idle",
        js: ["content-scripts/page.js"],
      },
    ]);
    let worker, cdp;
    async function openContext() {
      process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
      context = await chromium.launchPersistentContext(profile, {
        channel: browserChannel,
        headless,
        chromiumSandbox: true,
        // Playwright 默认关闭 BFCache；仅专项用例移除这一项，不改变其他测试环境。
        ignoreDefaultArgs: [
          ...(enableBackForwardCache ? ["--disable-back-forward-cache"] : []),
          // 正式 Chrome/Edge 用真实 CDP 安装；默认 --disable-extensions 会禁用安装后的扩展。
          ...(browserChannel !== "chromium" ? ["--disable-extensions"] : []),
        ],
        viewport: null,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        // 同一个 profile 重开后仍使用本例拥有的目录，避免历史 Chrome 下载偏好指向已清理的临时目录。
        downloadsPath: path.join(root, "downloads"),
        args: [
          "--window-size=1280,900",
          "--enable-unsafe-extension-debugging",
          // 容量测试显式开启一次性 profile 的回环随机端口；普通 UI 测试不开。
          ...(workerMetrics
            ? ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"]
            : []),
          ...(browserChannel === "chromium"
            ? [
                `--disable-extensions-except=${extension}`,
                `--load-extension=${extension}`,
              ]
            : []),
        ],
      });
      if (manageTrace)
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        });
      context.on("page", (page) =>
        page.on("pageerror", (error) => errors.push(error.message)),
      );
      await context.route(/^https?:/, (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === "127.0.0.1") return route.continue();
        blocked.push(url.origin);
        return route.abort("blockedbyclient");
      });
      cdp = await context.browser().newBrowserCDPSession();
      // 读取原生浏览器 UA；不依赖传给 launch 的配置，也不额外开启 automation UI。
      const version = await cdp.send("Browser.getVersion");
      const actualHeadless = version.userAgent.includes("HeadlessChrome/");
      expect(actualHeadless, "本例真实 Chromium 进程必须遵循配置的运行方式").toBe(
        headless,
      );
      if (browserChannel !== "chromium")
        await cdp.send("Extensions.loadUnpacked", { path: extension });
      worker =
        context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
      // Serviceworker 事件早于脚本初始化。只读等待正式 listener，不能注入替代 handler。
      await expect
        .poll(() => worker.evaluate(() => chrome.action.onClicked.hasListeners()))
        .toBe(true);
    }
    await openContext();
    const extensionId = new URL(worker.url()).host;
    // 首装事件先持久化引导再打开标签。等真实安装页就绪，避免它稍后抢走阅读页焦点。
    await expect
      .poll(() =>
        context
          .pages()
          .some(
            (page) => page.url() === `chrome-extension://${extensionId}/tutorial.html`,
          ),
      )
      .toBe(true);

    const evidence = {
      headless,
      nativePanel: false,
      manifestUnchanged: true,
      extensionId,
      chromium: context.browser().version(),
      distribution: browserChannel,
      sourceHashes,
    };
    const harness = {
      root,
      profile,
      headless,
      extensionId,
      context,
      worker,
      cdp,
      workerHeapSampler: workerMetrics
        ? () => sampleWorkerHeap(profile, worker.url())
        : undefined,
      async restart({ upgradeBuildDir } = {}) {
        // 正常关闭本例拥有的整个浏览器进程；保持本例 profile，不以页面 reload 冒充重启。
        const oldBrowser = (await cdp.send("SystemInfo.getProcessInfo")).processInfo.find(
          (item) => item.type === "browser",
        );
        expect(oldBrowser, "需确认本例拥有的原生浏览器进程").toBeDefined();
        if (manageTrace) {
          const trace = testInfo.outputPath("before-restart-trace.zip");
          await context.tracing.stop({ path: trace });
          await testInfo.attach("before-restart-trace", {
            path: trace,
            contentType: "application/zip",
          });
        }
        await context.close();
        await expect
          .poll(() => {
            try {
              process.kill(oldBrowser.id, 0);
              return true;
            } catch (error) {
              if (error.code === "ESRCH") return false;
              throw error;
            }
          })
          .toBe(false);
        if (upgradeBuildDir) {
          // 只替换本例已正常退出的专属扩展目录；两个候选都逐文件验证，不修改 manifest。
          const beforeHashes = sourceHashes,
            afterHashes = hashes(upgradeBuildDir),
            beforeVersion = JSON.parse(
              fs.readFileSync(path.join(extension, "manifest.json")),
            ).version,
            afterVersion = JSON.parse(
              fs.readFileSync(path.join(upgradeBuildDir, "manifest.json")),
            ).version;
          expect(
            afterHashes,
            "候选替换必须真实使用不同生产字节，不能只重开原包",
          ).not.toEqual(beforeHashes);
          fs.rmSync(extension, { recursive: true });
          fs.cpSync(upgradeBuildDir, extension, {
            recursive: true,
            errorOnExist: true,
          });
          expect(hashes(extension)).toEqual(afterHashes);
          sourceHashes = afterHashes;
          Object.assign(evidence, { sourceHashes: afterHashes });
          await attach(testInfo, "actual-current-format-upgrade", {
            beforeHashes,
            afterHashes,
            beforeVersion,
            afterVersion,
            candidateReplacement: true,
            softwareVersionUpgrade: beforeVersion !== afterVersion,
            byteChanged: JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes),
            profile,
            headless,
          });
        }
        await openContext();
        expect(new URL(worker.url()).host).toBe(extensionId);
        Object.assign(harness, { context, worker, cdp });
        const nextBrowser = (
          await cdp.send("SystemInfo.getProcessInfo")
        ).processInfo.find((item) => item.type === "browser");
        expect(nextBrowser.id).not.toBe(oldBrowser.id);
        await attach(testInfo, "actual-browser-restart", {
          beforePid: oldBrowser.id,
          afterPid: nextBrowser.id,
          sameOwnedProfile: true,
          headless,
          version: context.browser().version(),
        });
      },
      async openPanel(page) {
        await page.bringToFront();
        // page target 与 tab target 不同；同 URL 多标签必须由测试显式区分，不能任意取第一个。
        const targets = (
          await cdp.send("Target.getTargets", {
            filter: [{ type: "tab", exclude: false }],
          })
        ).targetInfos.filter((t) => t.url === page.url());
        expect(targets, "action 必须指向唯一真实阅读标签").toHaveLength(1);
        await cdp.send("Extensions.triggerAction", {
          id: extensionId,
          targetId: targets[0].targetId,
        });
        const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
        await expect
          .poll(() => context.pages().some((p) => p.url() === panelUrl))
          .toBe(true);
        const panel = context.pages().find((p) => p.url() === panelUrl);
        await expect(panel.locator(".lm-local-banner")).toBeVisible();
        // 原生上下文类型是证据门槛，不能把 newPage(sidepanel.html) 当作侧栏通过。
        const native = await panel.evaluate(() =>
          chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }),
        );
        expect(native.some((item) => item.documentUrl === panelUrl)).toBe(true);
        evidence.nativePanel = true;
        return panel;
      },
      async close() {
        const failures = [];
        try {
          expect(hashes(extension)).toEqual(sourceHashes);
          expect(errors, "真实页面不得发生未处理异常").toEqual([]);
          expect(blocked, "业务测试不得依赖外网").toEqual([]);
          await attach(testInfo, "extension-boundary", evidence);
          const extensionOrigin = `chrome-extension://${extensionId}`;
          const panelUrl = `${extensionOrigin}/sidepanel.html`;
          // 管理页会真实关闭阅读侧栏。先采集仍存活的原生侧栏，缩短枚举与截图之间的窗口。
          const pages = context
            .pages()
            .sort((a, b) => Number(b.url() === panelUrl) - Number(a.url() === panelUrl));
          for (const [i, page] of pages.entries()) {
            const url = page.url();
            if (!url.startsWith(`${extensionOrigin}/`)) continue;
            try {
              await testInfo.attach(`extension-ui-${i}`, {
                body: await page.screenshot({ animations: "disabled" }),
                contentType: "image/png",
              });
            } catch (error) {
              // 只接受管理页正常收起的原生侧栏；普通页面关闭、浏览器退出或 worker 失联仍失败。
              if (url !== panelUrl || !page.isClosed()) throw error;
              expect(context.browser().isConnected()).toBe(true);
              const ended = await worker.evaluate(async () => {
                const panels = await chrome.runtime.getContexts({
                  contextTypes: ["SIDE_PANEL"],
                });
                const activeTabs = await chrome.tabs.query({ active: true });
                const ownOptions = chrome.runtime.getURL("options.html");
                const management = activeTabs.filter(
                  (tab) => tab.url?.split(/[?#]/)[0] === ownOptions,
                );
                const disabled = await Promise.all(
                  management.map(async (tab) => ({
                    tabId: tab.id,
                    enabled: (await chrome.sidePanel.getOptions({ tabId: tab.id }))
                      .enabled,
                  })),
                );
                return { panelCount: panels.length, management: disabled };
              });
              expect(ended.panelCount, "正常收起后原生 SIDE_PANEL 必须确实消失").toBe(0);
              expect(ended.management.length, "必须有真实前台管理标签").toBeGreaterThan(
                0,
              );
              expect(ended.management.every((tab) => tab.enabled === false)).toBe(true);
              await attach(testInfo, `extension-ui-${i}-ended`, {
                url,
                reason: "管理页正常收起原生侧栏，最终截图前文档已结束",
                ...ended,
              });
            }
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          if (manageTrace) {
            const trace = testInfo.outputPath("extension-trace.zip");
            await context.tracing.stop({ path: trace });
            await testInfo.attach("extension-trace", {
              path: trace,
              contentType: "application/zip",
            });
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          await context.close();
        } catch (error) {
          failures.push(error);
        }
        fs.rmSync(root, { recursive: true, force: true });
        // 外部目录属于 Desktop factory，须先关浏览器再由上层释放，不能越权删除父目录。
        if (failures.length)
          throw new AggregateError(failures, "扩展 fixture 验收或清理失败");
      },
    };
    return harness;
  } catch (error) {
    try {
      await context?.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    throw error;
  }
}
module.exports = { launchExtension, readingServer, hashes, attach };
