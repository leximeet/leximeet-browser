import { test, expect } from "./fixtures";
import { readingServer } from "../helpers/extension.cjs";
import { workspace, facts, addWord, wordPoint } from "./ui-helpers";

test("原生侧栏初始化入口明确禁用，加载后一次点击采集即可开始", async ({ extension }) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  // 观察真实首帧，不替换 Chrome API、后台服务或产品状态。
  await extension.context.addInitScript(() => {
    if (location.pathname !== "/sidepanel.html") return;
    const observer = new MutationObserver(() => {
      const capture = document.querySelector<HTMLButtonElement>(
        '[data-guide="capture-tab"]',
      );
      if (!capture) return;
      (globalThis as any).__leximeetInitialPanel = {
        captureDisabled: capture.disabled,
        encounterDisabled: document.querySelector<HTMLButtonElement>(
          '[data-guide="encounter-tab"]',
        )?.disabled,
        managerDisabled: document.querySelector<HTMLButtonElement>(
          '[data-guide="manage"]',
        )?.disabled,
        loadingVisible: document
          .querySelector('[role="status"]')
          ?.textContent?.includes("正在加载词遇"),
        capturing: !!document.querySelector(".lm-capturing"),
      };
      observer.disconnect();
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
  const server = await readingServer(
    '<!doctype html><meta charset="utf-8"><title>Panel initial state</title><p>A resilient reader returns.</p>',
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    expect(
      await panel.evaluate(() => (globalThis as any).__leximeetInitialPanel),
    ).toEqual({
      captureDisabled: true,
      encounterDisabled: true,
      managerDisabled: true,
      loadingVisible: true,
      capturing: false,
    });
    const capture = panel.getByRole("button", { name: "采集", exact: true });
    await expect(capture).toBeEnabled();
    await capture.click();
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("status").filter({ hasText: /^采集中$/ })).toBeVisible();
  } finally {
    await server.close();
  }
});

test("词卡显式采集写入真实原句；独立确认窗仅有控制权限且支持明暗", async ({
  extension,
}, info) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  await addWord(manager, "resilient");
  const before = await facts(manager);
  const server = await readingServer(
    '<!doctype html><meta charset="utf-8"><title>Card capture</title><style>body{margin:48px;font:24px/1.9 Georgia}</style><p>🙂 A resilient reader returns.</p>',
  );
  try {
    const page = await extension.context.newPage();
    await page.goto(server.url);
    const ball = page.locator("leximeet-page-ui .ball");
    await expect(ball).toBeVisible();
    await ball.click();
    await expect(ball).toHaveAttribute("aria-pressed", "true");
    const point = await wordPoint(page, "resilient");
    await page.mouse.move(point.x, point.y);
    const card = page.locator("leximeet-page-ui .card");
    await expect(card).toBeVisible();
    await page.screenshot({
      path: info.outputPath("word-card-capture-light.png"),
    });
    await card.getByRole("button", { name: "采集 resilient", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "采集 resilient", exact: true }),
    ).toHaveText("已采集");
    await expect
      .poll(async () => (await facts(manager)).encounters.length)
      .toBe(before.encounters.length + 1);
    const actual = (await facts(manager)).encounters.at(-1)!;
    expect(JSON.stringify(actual)).toContain("resilient reader returns");
    const savedFacts = await facts(manager);
    const popup = await extension.context.newPage();
    await popup.goto(
      `chrome-extension://${extension.extensionId}/connection-confirmation.html`,
    );
    await expect(popup.getByRole("dialog", { name: "连接桌面端" })).toBeVisible();
    const rejected = await popup.evaluate(async () =>
      (globalThis as any).chrome.runtime.sendMessage({
        channel: "leximeet",
        action: "state",
        data: {},
      }),
    );
    expect(rejected).toMatchObject({ ok: false });
    expect(rejected.error).toContain("只能操作连接邀请");
    await popup.screenshot({
      path: info.outputPath("connection-popup-light.png"),
    });
    await popup.emulateMedia({ colorScheme: "dark" });
    await expect(popup.locator("main")).toHaveAttribute("data-theme", "dark");
    await popup.screenshot({
      path: info.outputPath("connection-popup-dark.png"),
    });
    expect(await facts(manager)).toEqual(savedFacts);
  } finally {
    await server.close();
  }
});
