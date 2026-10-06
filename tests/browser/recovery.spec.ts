import { panelTitle } from "./ui-helpers";
import { test, expect } from "./fixtures";

test("真实 action 后停止 MV3 worker：独立分析恢复、旧文档拒绝与侧栏推送", async ({
  extension,
}) => {
  const { context, worker } = extension;
  const article = await context.newPage();
  await article.route("https://recovery.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>${route.request().url().endsWith("/second") ? "Recovered after navigation" : "Recovery fixture"}</title></head><body><p>A book remains on this page.</p></body></html>`,
    }),
  );
  await article.goto("https://recovery.example.test/first");
  const controller = await extension.openPanel(article);
  const tab = await worker.evaluate(async () => {
    const [tab] = await (globalThis as any).chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    await (globalThis as any).chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-scripts/page.js"],
    });
    return { id: tab.id, windowId: tab.windowId };
  });
  const call = (action: string, data: Record<string, unknown> = {}) =>
    controller.evaluate(
      async (payload) =>
        (globalThis as any).chrome.runtime.sendMessage({
          channel: "leximeet",
          ...payload,
        }),
      { action, data: { windowId: tab.windowId, ...data } },
    );
  await expect.poll(async () => !!(await call("state")).result?.page).toBe(true);
  const before = (await call("state")).result.page;
  await worker.evaluate(
    async (tabId) =>
      (globalThis as any).chrome.tabs.sendMessage(tabId, {
        channel: "leximeet-page",
        action: "ping",
        data: {},
      }),
    tab.id,
  );
  expect((await call("state")).result.page.generation).toBe(before.generation);
  const cdp = await context.newCDPSession(controller);
  await cdp.send("ServiceWorker.enable");
  const originalTarget = (await cdp.send("Target.getTargets")).targetInfos.find(
    (target) => target.type === "service_worker" && target.url === worker!.url(),
  );
  expect(originalTarget).toBeTruthy();
  await worker.evaluate(() => {
    // 测试标记仅存在 worker 堆内，不写 storage；重启后必须消失。
    (globalThis as any).__leximeetRestartProof = "before-stop";
  });
  await cdp.send("ServiceWorker.stopAllWorkers");
  // Chromium 已销毁 worker 时 Playwright 的 close 通知仍可能延后到 context.close。
  // 用浏览器原生 target 消失作为停止证据，不能仅等待一个代理对象的事件。
  await expect
    .poll(async () =>
      (await cdp.send("Target.getTargets")).targetInfos.some(
        (target) => target.targetId === originalTarget!.targetId,
      ),
    )
    .toBe(false);
  // 停止 worker 后无需 Desktop 配对，也无需刷新网页；分析应在原文档恢复。
  // 原生侧栏保持打开时浮球仍可操作；直接点其真实分析按钮唤醒 worker。
  await expect(article.locator("leximeet-page-ui .ball")).toBeVisible();
  await controller.getByRole("button", { name: "分析本页", exact: true }).click();
  await expect.poll(async () => !!(await call("state")).result?.page).toBe(true);
  const analysis = await call("analyze", { mode: "encounter" });
  expect(analysis.ok).toBe(true);
  const recovered = (await call("state")).result.page;
  expect(recovered.documentId).toBe(before.documentId);
  expect(recovered.generation).toBe(before.generation);
  expect(recovered.phase).toBe("encounter");
  expect(recovered.occurrences).toEqual([]);
  const recoveredTarget = (await cdp.send("Target.getTargets")).targetInfos.find(
    (target) => target.type === "service_worker" && target.url === worker!.url(),
  );
  expect(recoveredTarget).toBeTruthy();
  // 当前 Chromium 会复用 targetId；检测堆标记消失才能证明发生了真实重启。
  expect(
    await worker.evaluate(() => (globalThis as any).__leximeetRestartProof),
  ).toBeUndefined();
  await article.goto("https://recovery.example.test/second");
  await controller.evaluate(
    async (tabId) =>
      (globalThis as any).chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-scripts/page.js"],
      }),
    tab.id,
  );
  await expect
    .poll(async () => (await call("state")).result?.page?.documentId)
    .not.toBe(before.documentId);
  const rejected = await controller.evaluate(
    async ({ tabId, generation }) => {
      const results = await (globalThis as any).chrome.scripting.executeScript({
        target: { tabId },
        func: (old: string) =>
          (globalThis as any).chrome.runtime.sendMessage({
            channel: "leximeet",
            action: "select",
            generation: old,
            data: { id: "old-location" },
          }),
        args: [generation],
      });
      return results[0].result;
    },
    { tabId: tab.id, generation: before.generation },
  );
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toMatch(/页面会话已失效/);
  // 网页只消费固定公开回执，个人资料与旧伴侣状态均不得出现在页面。
  await controller.evaluate(async (tabId) => {
    const api = (globalThis as any).chrome;
    await api.tabs.sendMessage(tabId, {
      channel: "leximeet-page",
      action: "end",
      data: { reason: "已写入本机词本，网页已恢复" },
    });
    await api.tabs.sendMessage(tabId, {
      channel: "leximeet-page",
      action: "capture-result",
      data: { status: "confirmed" },
    });
  }, tab.id);
  await expect(article.locator("leximeet-page-ui").getByRole("status")).toHaveText(
    "已加入单词本；网页已恢复",
  );
  // 不调用 UI 的 act/刷新：新文档来源必须通过重连后的 panel port 被动推送到已打开界面。
  await expect
    .poll(async () => (await call("state")).result.page?.title)
    .toBe("Recovered after navigation");
  await expect(controller.locator(".lm-local-banner")).toContainText("我的词库0 词");
  await expect.poll(() => panelTitle(controller)).toBe("Recovered after navigation");
});
