#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { DEFAULT_READING_URL } from "../lib/reading-page.mjs";
import {
  labReadingUrl,
  openLabReadingPage,
  installedTutorial,
  activateLabPage,
} from "./lib/lab-startup-pages.mjs";
import { labProxy } from "./lab-network.mjs";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>词遇隔离阅读页</title>
<style>body{margin:0;background:#f3f5ef;color:#253b31;font:18px/1.8 Georgia,serif}main{max-width:740px;margin:80px auto;padding:40px;background:white;border-radius:15px;box-shadow:0 20px 60px #24423218}h1{font:normal 36px/1.2 Georgia}button,a{display:inline-block;padding:8px 15px;border:1px solid #1c7861;border-radius:8px;color:#1c7861;background:white;cursor:pointer;font:14px/1.5 system-ui;text-decoration:none}p{margin:22px 0}@media(max-width:900px){main{margin:30px 24px;padding:28px}}</style></head><body><main>
<small>ENGLISH TECHNICAL NOTES · 本轮本地英文阅读页</small><h1>Building a reliable system</h1>
<p>A system is a group of components that work together. Each component provides a useful service, while the network connects resources and carries data between them.</p>
<h2>Keep the design clear</h2><p>Start with a simple plan. Give every resource a clear purpose and make each operation easy to understand. A small change can improve the whole system when its effect is measured carefully.</p><p>A resilient learner can encounter an unfamiliar word, capture its context, and return to the idea tomorrow.</p><p>The book remains useful even when the desktop application is not installed. Read the article, then practice the spelling of resilient.</p>
<button id="site-action" onclick="document.getElementById('site-result').textContent='网页按钮正常可用'">网页原有按钮</button> <span id="site-result"></span>
<p>点击工具栏的词遇图标打开侧栏。进入采集模式，直接点击正文英文词并加入单词本；侧栏打开时也可使用悬浮球。</p>
<p><a href="/second" target="_blank">在新标签页打开另一篇</a> <a href="${DEFAULT_READING_URL}" target="_blank" rel="noreferrer">打开 Node.js 英文文档</a></p>
<p>切换标签、刷新页面时侧栏保持打开；采集中切换标签后会暂停并询问是否继续；收起后可右键悬浮球打开或收起侧栏；点击工具栏图标或按 Alt+Shift+L（macOS：⌥⇧L）打开侧栏。普通网页默认显示悬浮球；拖到单词上松开即可加入单词本。</p></main></body></html>`;

/**
 * 创建本轮独占的浏览器、profile 和回环阅读页。手工入口可见，自动回归显式无界面。
 * 生命周期函数也供真实浏览器测试调用；不改生产包、不依赖 Desktop。
 * close 返回同一清理 Promise，关窗事件和 finally 必须等它完成，不能提前退出。
 */
export async function startIsolatedBrowser({
  extensionDir = resolve(import.meta.dirname, "../.output/chrome-mv3"),
  onStatus = console.log,
  readingUrl,
  navigationTimeout = 20000,
  // 程序调用默认无界面，避免后续复用时意外弹窗；人工 CLI 会显式传入可见模式。
  headless = true,
  signal,
} = {}) {
  signal?.throwIfAborted();
  readingUrl = labReadingUrl({ headless, readingUrl });
  const manifest = JSON.parse(
    await readFile(join(extensionDir, "manifest.json"), "utf8"),
  );
  if (
    manifest.version !== "1.0.0" ||
    !manifest.permissions?.includes("nativeMessaging") ||
    JSON.stringify(manifest.host_permissions) !==
      JSON.stringify(["http://*/*", "https://*/*"])
  )
    throw new Error("请先运行 npm run build，并核对 1.0.0 manifest");
  const dictionary = JSON.parse(
    await readFile(
      join(extensionDir, "dictionaries/core/dictionary-manifest.json"),
      "utf8",
    ),
  );
  if (
    dictionary.schema !== "leximeet.browser-text.v3" ||
    dictionary.dictionaryVersion !== "0.0.3" ||
    dictionary.sourceReleaseSha256 !==
      "8c9392ddf92c3bf3b0f471075b55c5042826a08129c4aa1efbbe9cd922926317" ||
    dictionary.entryCount !== 26417 ||
    dictionary.audioCount !== 0 ||
    dictionary.catalogCount !== 23 ||
    dictionary.sourceEdition !== "lite-text"
  )
    throw new Error("请先运行 npm run build，确认扩展内置固定的词遇核心词包");

  const root = await mkdtemp(join(tmpdir(), "leximeet-browser-lab-"));
  const profile = join(root, "chromium-profile");
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      request.url?.startsWith("/second")
        ? pageHtml.replace(
            "<title>词遇隔离阅读页</title>",
            "<title>词遇隔离阅读页 · 第二篇</title>",
          )
        : pageHtml,
    );
  });
  let context;
  let ownedBrowserPid;
  let closing;
  let finish;
  let fail;
  const closed = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // 启动失败时调用方尚未取得 closed；保留拒绝供正常等待，同时避免未处理拒绝。
  void closed.catch(() => {});
  function close() {
    // 先保存 Promise 再执行任务，防止 context.close 同步触发 close 事件时递归重入。
    closing ??= Promise.resolve().then(async () => {
      try {
        try {
          await context?.close();
        } catch {
          // 原生浏览器可能已经结束
        }
        if (server.listening)
          await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          });
        // 原生关窗的 context close 早于浏览器最后一次 profile 落盘；只等待本轮 PID。
        if (ownedBrowserPid) {
          const before = Date.now() + 10000;
          while (true) {
            try {
              process.kill(ownedBrowserPid, 0);
            } catch (error) {
              if (error.code === "ESRCH") break;
              throw error;
            }
            if (Date.now() > before)
              throw new Error("本轮浏览器进程尚未退出，临时资料保留供检查");
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        // root 唯一来自本轮 mkdtemp；不跟随目录名查杀，也不清理调用者的扩展目录。
        await rm(root, { recursive: true, force: true });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      onStatus("词遇隔离验收环境已关闭，本轮临时资料已清理。");
    });
    closing.then(finish, fail);
    return closing;
  }
  const onAbort = () => {
    void close().catch(() => {});
  };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const localUrl = `http://127.0.0.1:${server.address().port}/`;
    signal?.throwIfAborted();
    // 真正的 SIDE_PANEL 是 Chromium 的 other target；只在本轮独占脚本中启用观察。
    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
    const proxy = readingUrl === "local" ? null : await labProxy();
    if (proxy) onStatus("本轮隔离 Chromium 已启用代理，回环阅读页仍直连。");
    context = await chromium.launchPersistentContext(profile, {
      ...(proxy ? { proxy } : {}),
      channel: "chromium",
      headless,
      viewport: null,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      // 生命周期归脚本持有，避免 Playwright 的信号处理提前 process.exit 中断 rm。
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        "--window-size=1440,1000",
        "--enable-unsafe-extension-debugging",
        "--no-first-run",
        "--disable-sync",
        "--disable-background-networking",
      ],
    });
    const processCdp = await context.browser().newBrowserCDPSession();
    try {
      // 读浏览器自身的 UA 核对真实模式；不为检查参数增加会改变人工窗口的 automation 标记。
      // 本脚本不覆盖 userAgent。页面模拟的 UA 不影响 Browser.getVersion 返回的原生值。
      const version = await processCdp.send("Browser.getVersion");
      const actualHeadless = version.userAgent.includes("HeadlessChrome/");
      if (actualHeadless !== headless)
        throw new Error("本轮浏览器的实际运行方式与配置不一致");
      ownedBrowserPid = (
        await processCdp.send("SystemInfo.getProcessInfo")
      ).processInfo.find((item) => item.type === "browser")?.id;
      if (!ownedBrowserPid) throw new Error("无法确认本轮隔离浏览器进程");
    } finally {
      await processCdp.detach();
    }
    context.once("close", () => {
      void close().catch(() => {});
    });
    signal?.throwIfAborted();
    signal?.addEventListener("abort", onAbort, { once: true });
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    const extensionId = new URL(worker.url()).hostname;
    const readyBefore = Date.now() + 15000;
    while (!(await worker.evaluate(() => chrome.action.onClicked.hasListeners()))) {
      signal?.throwIfAborted();
      if (Date.now() > readyBefore) throw new Error("词遇扩展入口初始化超时");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // 首次安装已自动打开引导，复用该页，关闭本轮多余空页，保留两个普通标签。
    const workspace = await installedTutorial({ context, extensionId, signal });
    const guideUrl = workspace.url();
    for (const page of context.pages())
      if (page !== workspace && page.url() === "about:blank") await page.close();
    const { url, requestedUrl, fallback } = await openLabReadingPage({
      context,
      readingUrl,
      localUrl,
      navigationTimeout,
      signal,
      onStatus,
    });
    await activateLabPage({ tutorial: workspace, startupPage: "tutorial" });
    onStatus(
      `词遇隔离浏览器已启动\n运行方式：${headless ? "无界面自动化" : "可见人工验收"}\n扩展 ID：${extensionId}\n内置词典：LexiMeet Dictionary Lite Text ${dictionary.dictionaryVersion} · ${dictionary.entryCount} 词 · 无内置音频\n阅读页：${url}\n使用教学：${guideUrl}\n临时资料：${profile}\n请先按内置教学固定扩展，再亲自点击词遇图标打开侧栏；Node.js 文档另留作手工验收。\n右键悬浮球打开或收起侧栏；点击工具栏图标或按 Alt+Shift+L（macOS：⌥⇧L）打开侧栏；关闭浏览器或按 Ctrl+C 结束并清理。`,
    );
    return {
      root,
      profile,
      url,
      localUrl,
      requestedUrl,
      fallback,
      startupUrl: guideUrl,
      headless,
      context,
      extensionId,
      closed,
      close,
    };
  } catch (error) {
    await close();
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--headless"))
    throw new Error("隔离浏览器脚本仅支持 --headless；默认可见供手工验收");
  const headless = args.includes("--headless");
  let session;
  const controller = new AbortController();
  const stop = (signal) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(new Error("隔离环境启动或运行已取消"));
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    session = await startIsolatedBrowser({
      headless,
      readingUrl: process.env.LEXIMEET_LAB_URL || undefined,
      signal: controller.signal,
    });
    await session.closed;
  } catch (error) {
    // 取消可以正常结束；清理失败仍要报告，不能被 aborted 状态吞掉。
    if (error !== controller.signal.reason) throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    await session?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
