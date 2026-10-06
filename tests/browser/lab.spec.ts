import { panelTitle, closeNativePanel } from "./ui-helpers";
import { test, expect } from "./fixtures";
import { nativePanel, toolbarAction } from "./ui-helpers";
import { startIsolatedBrowser } from "../../scripts/launch-isolated-browser.mjs";
import { createServer } from "node:http";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

async function absent(path: string) {
  try {
    await access(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function portClosed(url: string) {
  return new Promise<boolean>((resolve, reject) => {
    const address = new URL(url);
    const socket = createConnection({
      host: "127.0.0.1",
      port: Number(address.port),
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) =>
      (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
        ? resolve(true)
        : reject(error),
    );
  });
}

test("隔离浏览器遵循运行方式，正常结束时清理且只打开教学和手工阅读两个标签", async ({
  headless,
}, testInfo) => {
  const messages: string[] = [];
  const session = await startIsolatedBrowser({
    readingUrl: "local",
    headless,
    onStatus: (message: string) => messages.push(message),
  });
  try {
    expect(session.headless).toBe(headless);
    const worker = session.context.serviceWorkers()[0]!;
    // other target 中包含原生侧栏；浏览器 tabs 才是用户实际看到的两个标签。
    const tabs = await worker.evaluate(() => (globalThis as any).chrome.tabs.query({}));
    expect(tabs).toHaveLength(2);
    expect(session.startupUrl).toBe(
      `chrome-extension://${session.extensionId}/tutorial.html`,
    );
    expect(session.fallback).toBe(false);
    const activeTab = tabs.find((tab: { active: boolean }) => tab.active);
    const tutorialContext = await worker.evaluate(() =>
      (globalThis as any).chrome.runtime.getContexts({ contextTypes: ["TAB"] }),
    );
    expect(
      tutorialContext.find((item: { documentUrl: string }) =>
        item.documentUrl.endsWith("/tutorial.html"),
      ).tabId,
    ).toBe(activeTab.id);
    // 未申请 tabs/全站权限，扩展不能读取另一标签的 URL；由本例浏览器 CDP 核对窗口标签。
    const inspect = await session.context.browser()!.newBrowserCDPSession();
    const tabTargets = (
      await inspect.send("Target.getTargets", {
        filter: [{ type: "tab", exclude: false }],
      })
    ).targetInfos;
    expect(tabTargets.map((tab: { url: string }) => tab.url).sort()).toEqual(
      [session.url, `chrome-extension://${session.extensionId}/tutorial.html`].sort(),
    );
    expect((await fetch(session.url)).status).toBe(200);
    const workspace = session.context
      .pages()
      .find((page) => page.url().endsWith("tutorial.html"))!;
    await expect(
      workspace.getByRole("heading", {
        name: "A small habit, a lasting change.",
      }),
    ).toBeVisible();
    expect(
      await worker.evaluate(() =>
        (globalThis as any).chrome.runtime.getContexts({
          contextTypes: ["SIDE_PANEL"],
        }),
      ),
    ).toHaveLength(0);
    await workspace.screenshot({
      path: testInfo.outputPath("visible-lab-workspace.png"),
    });
    const cdp = await session.context.browser()!.newBrowserCDPSession();
    const browser = (
      (await cdp.send("SystemInfo.getProcessInfo")).processInfo as {
        type: string;
        id: number;
      }[]
    ).find((item) => item.type === "browser")!;
    // 原生 Browser.close 正常结束整个浏览器；不是只关网页或杀操作系统进程。
    await cdp.send("Browser.close");
    const first = session.close();
    expect(session.close()).toBe(first);
    await session.closed;
    await first;
    expect(await absent(session.root)).toBe(true);
    expect(await portClosed(session.url)).toBe(true);
    await expect
      .poll(() => {
        try {
          process.kill(browser.id, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      })
      .toBe(false);
    expect(messages.filter((message) => message.includes("已清理"))).toHaveLength(1);
    await testInfo.attach("lab-close", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          headless: session.headless,
          openedPages: 2,
          browserCloseCommand: true,
          profileRemoved: true,
          portClosed: true,
          ownedBrowserPidExited: true,
          cleanupRanOnce: true,
          scope: "原生浏览器正常关闭事件；未自动点击系统窗口关闭按钮",
        }),
      ),
    });
  } finally {
    await session.close();
  }
});

test("人工验收启动后浮球与窗口级原生侧栏可见，真实窗口缩放、跨标签及刷新均保留入口", async ({
  headless,
}, testInfo) => {
  const session = await startIsolatedBrowser({
    readingUrl: "local",
    headless,
    onStatus: () => {},
  });
  try {
    expect(session.headless).toBe(headless);
    const reading = session.context.pages().find((page) => page.url() === session.url)!;
    // 用户动作由测试显式触发；默认启动仍留在教学，零个侧栏。
    let panel = await toolbarAction(session.context, session.extensionId, reading);
    const workspace = await session.context.newPage();
    await workspace.goto(`chrome-extension://${session.extensionId}/options.html`);
    await reading.bringToFront();
    panel = await toolbarAction(session.context, session.extensionId, reading);
    const worker = session.context.serviceWorkers()[0]!;
    const contexts = () =>
      worker.evaluate(async () =>
        (
          await (globalThis as any).chrome.runtime.getContexts({
            contextTypes: ["SIDE_PANEL"],
          })
        ).map((item: { documentId: string }) => item.documentId),
      );
    await expect.poll(() => panelTitle(panel)).toBe("词遇隔离阅读页");
    let original = await contexts();
    expect(original).toHaveLength(1);
    expect(reading.viewportSize()).toBeNull();
    expect(panel.viewportSize()).toBeNull();
    const host = reading.locator("leximeet-page-ui");
    const ball = host.locator(".ball");
    const tip = host.locator(".ball-tip");
    await expect(ball).toBeVisible();
    await closeNativePanel(panel);
    await expect(ball).toBeVisible();
    // 侧栏展开有原生布局动画，先等吸边与真实阅读宽度一致，再操作鼠标。
    const aligned = () =>
      ball.evaluate(
        (element) =>
          Math.abs(
            parseFloat((element as HTMLElement).style.left) +
              element.getBoundingClientRect().width +
              12 -
              document.documentElement.clientWidth,
          ) < 1,
      );
    const settled = () =>
      ball.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return [
          document.documentElement.clientWidth,
          document.documentElement.clientHeight,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
        ];
      });
    // 原生侧栏动画中，球可以每帧都吸边却仍随阅读区变窄移动；必须等几何稳定再取鼠标坐标。
    await expect
      .poll(async () => {
        const before = await settled();
        await reading.waitForTimeout(100);
        return JSON.stringify(before) === JSON.stringify(await settled());
      })
      .toBe(true);
    await expect.poll(aligned).toBe(true);
    await expect(tip).toBeHidden();
    // 指针停在露出的最外沿；球展开后应保持可操作，不能因为滑离指针而闪回。
    const exposed = await ball.boundingBox();
    await reading.mouse.move(
      await reading.evaluate(() => document.documentElement.clientWidth - 2),
      exposed!.y + 23,
    );
    await expect(tip).toHaveText("单击开关遇见 · 拖拽采词 · 右键打开侧栏");
    await expect(tip.getByRole("button")).toHaveCount(0);
    await expect(ball).toHaveCSS("transform", "none");
    await reading.waitForTimeout(400); // 超过 180ms 的收起延迟，核对静止指针下提示仍在。
    await expect(tip).toBeVisible();
    await expect(ball).toHaveCSS("transform", "none");
    await reading.mouse.move(40, 40);
    await expect(tip).toBeHidden();
    await ball.hover();
    await expect(ball).toHaveCSS("transform", "none");
    await expect
      .poll(
        async () =>
          (await ball.boundingBox())!.x + 46 <=
          (await reading.evaluate(() => innerWidth)),
      )
      .toBe(true);
    await reading.screenshot({
      path: testInfo.outputPath("lab-entry-light.png"),
    });
    panel = await toolbarAction(session.context, session.extensionId, reading);
    await expect(ball).toBeVisible();
    original = await contexts();
    await panel.screenshot({
      path: testInfo.outputPath("lab-panel-light.png"),
    });

    const beforeManagement = original;
    await workspace.bringToFront();
    // 管理页按当前产品合同实际关闭窗口级面板；两个阅读标签仍共享同一实例。
    await expect.poll(contexts).toEqual([]);
    await workspace.goto(
      `chrome-extension://${session.extensionId}/options.html#/settings`,
    );
    await workspace.getByLabel("主题").selectOption("dark");
    await reading.bringToFront();
    await toolbarAction(session.context, session.extensionId, reading);
    await expect.poll(contexts).toHaveLength(1);
    panel = await nativePanel(session.context);
    original = await contexts();
    expect(original).not.toEqual(beforeManagement);
    await expect.poll(() => panelTitle(panel)).toBe("词遇隔离阅读页");
    await expect(host).toHaveAttribute("data-theme", "dark");
    await expect(ball).toBeVisible();
    await closeNativePanel(panel);
    await expect(ball).toBeVisible();
    await ball.hover();
    await expect(tip).toBeVisible();
    await expect(ball).toHaveCSS("transform", "none");
    await reading.screenshot({
      path: testInfo.outputPath("lab-entry-dark.png"),
    });
    panel = await toolbarAction(session.context, session.extensionId, reading);
    original = await contexts();
    await expect(ball).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath("lab-panel-dark.png") });

    const nextPage = session.context.waitForEvent("page");
    await reading.getByRole("link", { name: "在新标签页打开另一篇" }).click();
    const second = await nextPage;
    await second.waitForURL(session.url + "second");
    // 新标签没有 activeTab 授权；侧栏仍显示但不冒用旧来源，真实 action 后才能启用该页。
    await expect.poll(() => panelTitle(panel)).not.toBe("词遇隔离阅读页");
    await expect(panel.locator(".lm-panel")).toBeVisible();
    expect(await contexts()).toEqual(original);
    const actionCdp = await session.context.browser()!.newBrowserCDPSession();
    const targets = (
      await actionCdp.send("Target.getTargets", {
        filter: [{ type: "tab", exclude: false }],
      })
    ).targetInfos;
    const secondTarget = targets.find(
      (target: { url: string }) => target.url === second.url(),
    );
    if (!secondTarget) throw new Error("本例第二个阅读标签的原生 target 不存在");
    await actionCdp.send("Extensions.triggerAction", {
      id: session.extensionId,
      targetId: secondTarget.targetId,
    });
    await actionCdp.detach();
    await expect.poll(() => panelTitle(panel)).toBe("词遇隔离阅读页 · 第二篇");
    expect(await contexts()).toEqual(original);
    await second.close();
    await reading.bringToFront();
    await reading.reload();
    await expect(ball).toBeVisible();
    await expect.poll(() => panelTitle(panel)).toBe("词遇隔离阅读页");
    expect(await contexts()).toEqual(original);

    // 改变本例真实浏览器窗口；不以模拟 page viewport 冒充侧栏布局适配。
    const cdp = await session.context.browser()!.newBrowserCDPSession();
    const pageSession = await session.context.newCDPSession(reading);
    const { targetInfo } = await pageSession.send("Target.getTargetInfo");
    const { windowId } = await cdp.send("Browser.getWindowForTarget", {
      targetId: targetInfo.targetId,
    });
    const beforeWidth = await reading.evaluate(() => innerWidth);
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: 1100, height: 850 },
    });
    await expect.poll(() => reading.evaluate(() => innerWidth)).toBeLessThan(beforeWidth);
    await expect(ball).toBeVisible();
    await closeNativePanel(panel);
    await expect(ball).toBeVisible();
    await expect.poll(aligned).toBe(true);
    await ball.hover();
    await expect(tip).toBeVisible();
    await expect(ball).toHaveCSS("transform", "none");
    expect((await ball.boundingBox())!.x).toBeGreaterThan(0);
    expect(
      await reading.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBe(false);
    panel = await toolbarAction(session.context, session.extensionId, reading);
    original = await contexts();
    await expect(ball).toBeVisible();
    const dimensions = {
      reading: await reading.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        outerWidth,
      })),
      panel: await panel.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      })),
    };
    expect(dimensions.panel.width).toBeLessThan(500);
    expect(dimensions.panel.width).toBeGreaterThan(250);
    await reading.screenshot({
      path: testInfo.outputPath("lab-entry-resized.png"),
    });
    // 成对验证原生侧栏：打开和关闭时均保留球，实际关闭上下文为零。
    await expect.poll(contexts).toHaveLength(1);
    await expect(ball).toBeVisible();
    await closeNativePanel(panel);
    await expect.poll(contexts).toEqual([]);
    await expect(ball).toBeVisible();
    await expect.poll(aligned).toBe(true);
    await ball.hover();
    await expect(tip).toBeVisible();
    await toolbarAction(session.context, session.extensionId, reading);
    await expect.poll(contexts).toHaveLength(1);
    await testInfo.attach("lab-entry", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          headless: session.headless,
          simulatedViewport: false,
          explicitTestToolbarAction: true,
          startupFloatingBallHidden: true,
          floatingAppearsAfterClose: true,
          nativePanel: true,
          samePanelAcrossReadingTabsAndReload: true,
          managementClosesWindowPanel: true,
          resizedNativeWindow: true,
          dimensions,
          reopenedByToolbar: true,
          grantedSiteOrigins: (
            await worker.evaluate(() => (globalThis as any).chrome.permissions.getAll())
          ).origins,
        }),
      ),
    });
  } finally {
    await session.close();
  }
});

test("隔离脚本收到 SIGINT 正常等待退出，删除本轮 profile 并关闭回环端口", async ({
  headless,
}, testInfo) => {
  const child = spawn(
    process.execPath,
    [resolve("scripts/launch-isolated-browser.mjs"), ...(headless ? ["--headless"] : [])],
    {
      cwd: process.cwd(),
      env: { ...process.env, LEXIMEET_LAB_URL: "local" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<{ profile: string; url: string }>((resolve, reject) => {
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      const profile = /临时资料：([^\n]+)/.exec(output)?.[1];
      const url = /阅读页：(http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)?.[1];
      if (profile && url) resolve({ profile, url });
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", () => reject(new Error("隔离脚本在就绪前结束：" + output)));
  });
  try {
    const session = await ready;
    expect(output).toContain(`运行方式：${headless ? "无界面自动化" : "可见人工验收"}`);
    expect(session.profile).toContain("leximeet-browser-lab-");
    expect((await fetch(session.url)).status).toBe(200);
    expect(child.kill("SIGINT")).toBe(true);
    expect(await exit).toEqual({ code: 130, signal: null });
    expect(await absent(session.profile)).toBe(true);
    expect(await portClosed(session.url)).toBe(true);
    expect(output).toContain("本轮临时资料已清理");
    const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,command="]);
    expect(stdout.split("\n").filter((line) => line.includes(session.profile))).toEqual(
      [],
    );
    await testInfo.attach("lab-signal-cleanup", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          headless,
          signal: "SIGINT",
          exitCode: 130,
          profileRemoved: true,
          portClosed: true,
          processesForOwnedProfile: 0,
          cleanupMessageReceived: true,
        }),
      ),
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exit;
    }
  }
});

test("外网导航超时后仍保留隔离浏览器，切到真实本地英文阅读页与原生侧栏", async ({
  headless,
}, info) => {
  // 一个真实的慢 HTTP 服务，不替换浏览器 API、导航结果或生产包。
  const slow = createServer(() => {});
  await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
  const requestedUrl = `http://127.0.0.1:${(slow.address() as any).port}/slow`;
  const messages: string[] = [];
  let session;
  try {
    session = await startIsolatedBrowser({
      readingUrl: requestedUrl,
      navigationTimeout: 1000,
      headless,
      onStatus: (message) => messages.push(message),
    });
    expect(session.headless).toBe(headless);
    expect(session.requestedUrl).toBe(requestedUrl);
    expect(session.url).toBe(session.localUrl);
    expect(session.fallback).toBe(true);
    const guideUrl = `chrome-extension://${session.extensionId}/tutorial.html`;
    expect(session.startupUrl).toBe(guideUrl);
    const activeId = await session.context.serviceWorkers()[0]!.evaluate(
      async () =>
        (
          await (globalThis as any).chrome.tabs.query({
            active: true,
            currentWindow: true,
          })
        )[0].id,
    );
    const contextsBeforeAction = await session.context
      .serviceWorkers()[0]!
      .evaluate(() =>
        (globalThis as any).chrome.runtime.getContexts({ contextTypes: ["TAB"] }),
      );
    expect(
      contextsBeforeAction.find(
        (item: { documentUrl: string }) => item.documentUrl === guideUrl,
      ).tabId,
    ).toBe(activeId);
    const reading = session.context
      .pages()
      .find((page) => page.url() === session!.localUrl)!;
    await expect(
      reading.getByRole("heading", {
        name: "Building a reliable system",
        exact: true,
      }),
    ).toBeVisible();
    await expect(reading.locator("leximeet-page-ui .ball")).toBeVisible();
    const contexts = await session.context.serviceWorkers()[0]!.evaluate(() =>
      (globalThis as any).chrome.runtime.getContexts({
        contextTypes: ["SIDE_PANEL"],
      }),
    );
    expect(contexts).toHaveLength(0);
    const panel = await toolbarAction(session.context, session.extensionId, reading);
    await expect.poll(() => panelTitle(panel)).toBe("词遇隔离阅读页");
    expect(messages.some((message) => message.includes("浏览器继续保留"))).toBe(true);
    await info.attach("lab-navigation-fallback", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          headless: session.headless,
          realHttpTimeout: true,
          nativeBrowserKept: true,
          englishReadingPage: true,
          ballVisible: true,
          nativePanel: true,
        }),
      ),
    });
  } finally {
    await session?.close();
    await new Promise<void>((resolve) => {
      slow.close(() => resolve());
      slow.closeAllConnections();
    });
  }
});
