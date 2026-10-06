import { activeTabUrl } from "./ui-helpers";
import { mutePractice } from "./ui-helpers";
import { panelTitle, closeNativePanel } from "./ui-helpers";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  workspace,
  navigate,
  addWord,
  setTarget,
  facts,
  nativePanel,
  toolbarAction,
} from "./ui-helpers";
import { startIsolatedBrowser } from "../../scripts/launch-isolated-browser.mjs";

async function rectangle(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}
async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
}
async function pauseGuide(page: Page) {
  const pause = page.getByRole("button", { name: "跳过引导", exact: true });
  if (await pause.count()) await pause.click();
  await expect(page.getByLabel("真实操作引导")).toHaveCount(0);
}

test("宽窗明暗布局：词卡在列表右侧且切换可见，练习四宫格与工具栏不挤压", async ({
  extension,
}, info) => {
  const page: Page = await workspace(extension);
  await page.setViewportSize({ width: 1440, height: 914 });
  await pauseGuide(page);
  const nav = page.getByRole("navigation", { name: "工作区导航" });
  await expect(
    nav.getByRole("group", { name: "学习", exact: true }).getByRole("button"),
  ).toHaveText([/今日学习/, "学习规划", "练习中心", "学习洞察"]);
  await expect(
    nav.getByRole("group", { name: "资料", exact: true }).getByRole("button"),
  ).toHaveText([/我的词库/, "遇见记录", "词库中心"]);
  await mutePractice(page);
  await addWord(page, "resilient");
  await addWord(page, "attention");
  await setTarget(page);
  for (const theme of ["light", "dark"]) {
    await navigate(page, "设置");
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await expect(page.locator("main")).toHaveAttribute("data-theme", theme);
    await navigate(page, "我的词库");
    await expect(nav.getByRole("button", { name: /^我的词库/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const contrast = () =>
      nav.locator('[aria-current="page"]').evaluate((el) => {
        const style = getComputedStyle(el);
        const luminance = (color: string) => {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((n) => {
              const v = n / 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
          return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
        };
        const a = luminance(style.color),
          b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    await expect
      .poll(contrast, { message: "明暗当前导航文字应清晰可读" })
      .toBeGreaterThanOrEqual(4.5);
    const table = await rectangle(page.locator(".v3-library-table"));
    const detail = await rectangle(
      page.getByRole("complementary", { name: "所选单词详情" }),
    );
    expect(detail.x).toBeGreaterThanOrEqual(table.x + table.width - 1);
    expect(Math.abs(detail.y - table.y)).toBeLessThan(2);
    for (const word of ["resilient", "attention"]) {
      await page
        .locator(".v3-library-row > button")
        .filter({ hasText: word })
        .first()
        .click();
      await expect(page.getByRole("heading", { name: word, exact: true })).toBeInViewport(
        { ratio: 1 },
      );
      await expect(
        page.getByRole("button", { name: "编辑个人内容", exact: true }),
      ).toBeInViewport({ ratio: 1 });
    }
    const cardBody = await rectangle(page.locator(".v3-library-detail .v3-card-scroll"));
    const cardFooter = await rectangle(page.locator(".v3-library-detail > footer"));
    expect(cardBody.height).toBeGreaterThanOrEqual(80);
    expect(cardBody.y + cardBody.height).toBeLessThanOrEqual(cardFooter.y + 1);
    await expect(page.locator(".v3-library-detail > footer")).toBeInViewport({
      ratio: 1,
    });
    expect(
      await page
        .getByLabel("搜索我的词库")
        .evaluate((e) => getComputedStyle(e).borderTopWidth),
    ).toBe("0px");
    await page.screenshot({
      path: info.outputPath(`library-wide-${theme}.png`),
    });
    await navigate(page, "练习中心");
    await expect(page.locator(".v3-meaning-choices > button")).toHaveCount(4);
    const boxes = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        rectangle(page.locator(".v3-meaning-choices > button").nth(i)),
      ),
    );
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
    expect(boxes[1]!.x - boxes[0]!.x - boxes[0]!.width).toBeGreaterThanOrEqual(8);
    expect(boxes[2]!.y - boxes[0]!.y - boxes[0]!.height).toBeGreaterThanOrEqual(8);
    expect(Math.abs(boxes[2]!.x - boxes[0]!.x)).toBeLessThan(2);
    for (const choice of await page.locator(".v3-meaning-choices > button").all()) {
      await expect(choice).toBeInViewport({ ratio: 1 });
      expect((await rectangle(choice)).height).toBeGreaterThanOrEqual(48);
    }
    const toolbar = await rectangle(page.locator(".v3-practice-toolbar"));
    const stage = await rectangle(page.locator(".v3-practice-stage"));
    expect(stage.y - toolbar.y - toolbar.height).toBeLessThan(80);
    expect(
      await page
        .locator(".v3-practice-headword")
        .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(38);
    for (const name of ["看词选义", "单词临摹", "单词默写"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(
        page.getByRole("button", { name: "下一个", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: info.outputPath(`practice-${name}-${theme}.png`),
      });
    }
    await page.getByRole("button", { name: "看词选义", exact: true }).click();
    await navigate(page, "词库中心");
    const tabs = await rectangle(page.getByRole("navigation", { name: "词库中心内容" }));
    const categories = await rectangle(page.locator(".v3-catalog-tools"));
    expect(categories.y - tabs.y - tabs.height).toBeGreaterThanOrEqual(16);
    await expect(
      page.getByRole("button", { name: "主题词库", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "考试", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "本地词典", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "本地词典", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "增量升级", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await noHorizontalOverflow(page);
  }
});

test("窄窗与中窗：列表点词直接展示详情，全部导航和计划/拼写弹窗可操作", async ({
  extension,
}, info) => {
  // 两种窗口、两种主题逐一检查全部导航与弹窗，保留所有几何断言。
  info.setTimeout(90000);
  const page: Page = await workspace(extension);
  await pauseGuide(page);
  await mutePractice(page);
  await addWord(page, "resilient");
  await setTarget(page);
  for (const width of [960, 390]) {
    await page.setViewportSize({ width, height: 790 });
    for (const theme of ["light", "dark"]) {
      await navigate(page, "设置");
      await page.getByLabel("主题", { exact: true }).selectOption(theme);
      await expect(page.locator("main")).toHaveAttribute("data-theme", theme);
      for (const name of [
        "今日学习",
        "学习规划",
        "学习洞察",
        "我的词库",
        "遇见记录",
        "练习中心",
        "词库中心",
        "回收站",
        "设置",
      ]) {
        await navigate(page, name);
        await noHorizontalOverflow(page);
      }
      await navigate(page, "我的词库");
      await page
        .locator(".v3-library-row > button")
        .filter({ hasText: "resilient" })
        .first()
        .click();
      await expect(
        page.getByRole("heading", { name: "resilient", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: info.outputPath(`detail-${width}-${theme}.png`),
      });
      await page.getByRole("button", { name: "编辑个人内容", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "编辑个人内容" });
      await expect(edit.getByLabel("我的笔记")).toBeInViewport({ ratio: 1 });
      await expect(
        edit.getByRole("button", { name: "保存修改", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await edit.getByRole("button", { name: "关闭对话框" }).click();
      await navigate(page, "学习规划");
      await page.getByRole("button", { name: "调整计划", exact: true }).click();
      await expect(page.getByRole("dialog").getByLabel("每天学习新词数")).toBeInViewport({
        ratio: 1,
      });
      const beforePlan = (await facts(page)).plan;
      await page.getByRole("dialog").getByLabel("每天学习新词数").fill("13");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "保存学习计划", exact: true })
        .click();
      const afterPlan = (await facts(page)).plan;
      expect(afterPlan.sourceKind).toBe(beforePlan.sourceKind);
      expect(afterPlan.sourceId).toBe(beforePlan.sourceId);
      expect(afterPlan.dailyNew).toBe(13);
      await navigate(page, "练习中心");
      await page.getByRole("button", { name: "看词选义", exact: true }).click();
      if (width === 390) {
        const boxes = await Promise.all(
          [0, 1, 2, 3].map((i) =>
            rectangle(page.locator(".v3-meaning-choices > button").nth(i)),
          ),
        );
        for (let i = 1; i < boxes.length; i++)
          expect(boxes[i]!.y).toBeGreaterThanOrEqual(
            boxes[i - 1]!.y + boxes[i - 1]!.height + 4,
          );
      }
      await page.getByRole("button", { name: "拼写设置", exact: true }).click();
      const spelling = page.getByRole("dialog", { name: "拼写设置" });
      await expect(
        spelling.getByRole("checkbox", { name: "隐藏单词", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await expect(
        spelling.getByRole("button", { name: "保存拼写设置", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await spelling.getByRole("button", { name: "关闭对话框" }).click();
      await noHorizontalOverflow(page);
      await page.screenshot({
        path: info.outputPath(`practice-${width}-${theme}.png`),
      });
    }
  }
});

test("原生窗口：管理页真正收起侧栏，各入口/刷新一致，阅读页可重新打开", async ({
  headless,
}, info) => {
  const session = await startIsolatedBrowser({
    readingUrl: "local",
    headless,
    onStatus: () => {},
  });
  try {
    expect(session.headless).toBe(headless);
    const worker = session.context.serviceWorkers()[0]!;
    const reading = session.context.pages().find((p) => p.url() === session.url)!;
    // 启动只打开教学和手工页；这里显式模拟用户点击真实工具栏入口。
    const panel = await toolbarAction(session.context, session.extensionId, reading);
    await expect
      .poll(() => reading.evaluate(() => innerWidth < outerWidth - 200))
      .toBe(true);
    const readingWidth = await reading.evaluate(() => innerWidth);
    const initialNative = await worker.evaluate(() =>
      (globalThis as any).chrome.runtime.getContexts({
        contextTypes: ["SIDE_PANEL"],
      }),
    );
    expect(initialNative).toHaveLength(1);
    async function managementFillsTab(page: Page) {
      await expect(page.locator("main.lm-workspace")).toBeVisible();
      const tab = await page.evaluate(() => (globalThis as any).chrome.tabs.getCurrent());
      await expect
        .poll(() =>
          worker.evaluate(
            (tabId: number) => (globalThis as any).chrome.sidePanel.getOptions({ tabId }),
            tab.id,
          ),
        )
        .toMatchObject({ enabled: false });
      await expect
        .poll(() => page.evaluate(() => innerWidth))
        .toBeGreaterThan(readingWidth + 200);
      await expect
        .poll(() =>
          worker.evaluate(
            async () =>
              (
                await (globalThis as any).chrome.runtime.getContexts({
                  contextTypes: ["SIDE_PANEL"],
                })
              ).length,
          ),
        )
        .toBe(0);
      await noHorizontalOverflow(page);
      return tab.id;
    }
    // 从原生侧栏进入管理页，而非伪造一个普通 sidepanel.html 标签。
    const newPage = session.context.waitForEvent("page", (p) =>
      p.url().includes("/options.html"),
    );
    await panel.getByRole("button", { name: "打开管理", exact: true }).click();
    const manager = await newPage;
    const tabId = await managementFillsTab(manager);
    const fullWidth = await manager.evaluate(() => innerWidth);
    await manager.screenshot({
      path: info.outputPath("management-native-full-width.png"),
    });
    await manager.reload();
    await managementFillsTab(manager);
    await reading.bringToFront();
    const ball = reading.locator("leximeet-page-ui").locator(".ball");
    await toolbarAction(session.context, session.extensionId, reading);
    await expect
      .poll(() =>
        worker.evaluate(
          async () =>
            (
              await (globalThis as any).chrome.runtime.getContexts({
                contextTypes: ["SIDE_PANEL"],
              })
            ).length,
        ),
      )
      .toBe(1);
    const restoredPanel = await nativePanel(session.context);
    await expect.poll(() => panelTitle(restoredPanel)).toBe("词遇隔离阅读页");
    const restoredNative = await worker.evaluate(() =>
      (globalThis as any).chrome.runtime.getContexts({
        contextTypes: ["SIDE_PANEL"],
      }),
    );
    expect(restoredNative).toHaveLength(1);
    expect(restoredNative[0].documentId).not.toBe(initialNative[0].documentId);
    // 侧栏虽是可信 UI，仍不能冒充管理页禁用阅读标签。
    const denied = await restoredPanel.evaluate(
      (id: number) =>
        (globalThis as any).chrome.runtime.sendMessage({
          channel: "leximeet",
          action: "workspace-ready",
          data: { tabId: id },
        }),
      tabId,
    );
    expect(denied.ok).toBe(false);
    await expect(ball).toBeVisible();
    await closeNativePanel(restoredPanel);
    await expect
      .poll(() =>
        worker.evaluate(
          async () =>
            (
              await (globalThis as any).chrome.runtime.getContexts({
                contextTypes: ["SIDE_PANEL"],
              })
            ).length,
        ),
      )
      .toBe(0);
    await expect(ball).toBeVisible();
    // 右键只打开真实阅读侧栏；管理仍由侧栏显式进入，并关闭原生面板。
    await ball.click({ button: "right" });
    const ballPanel = await nativePanel(session.context);
    await expect(
      ballPanel.getByRole("button", { name: "遇见", exact: true }),
    ).toBeVisible();
    await expect(ball).toBeVisible();
    // Chromium 调试页的 visibilityState 不代表原生选中标签；读取真实 tabs 状态。
    await expect.poll(() => activeTabUrl(worker)).toBe(reading.url());
    const managerOpened = session.context.waitForEvent("page");
    await ballPanel.getByRole("button", { name: "打开管理", exact: true }).click();
    const ballManager = await managerOpened;
    await managementFillsTab(ballManager);
    const direct = await session.context.newPage();
    await direct.goto(`chrome-extension://${session.extensionId}/options.html#/catalog`);
    await managementFillsTab(direct);
    await manager.bringToFront();
    await managementFillsTab(manager);
    await toolbarAction(session.context, session.extensionId, reading);
    await expect
      .poll(() =>
        worker.evaluate(
          async () =>
            (
              await (globalThis as any).chrome.runtime.getContexts({
                contextTypes: ["SIDE_PANEL"],
              })
            ).length,
        ),
      )
      .toBe(1);
    const finalPanel = await nativePanel(session.context);
    await expect
      .poll(() => finalPanel.evaluate(() => document.visibilityState))
      .toBe("visible");
    await expect.poll(() => panelTitle(finalPanel)).toBe("词遇隔离阅读页");
    await expect
      .poll(() => reading.evaluate(() => innerWidth))
      .toBeLessThan(fullWidth - 200);
    const permissions = await worker.evaluate(() =>
      (globalThis as any).chrome.permissions.getAll(),
    );
    expect(permissions.permissions).not.toContain("tabs");
    await info.attach("management-native-boundary", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          headless: session.headless,
          nativeContextType: "SIDE_PANEL",
          readingWidth,
          managementWidth: fullWidth,
          closedNativeContextOnManagement: true,
          reopenedNativeContextThroughToolbar: true,
          noTabsPermission: !permissions.permissions.includes("tabs"),
          entries: [
            "sidepanel",
            "floating-ball-via-sidepanel",
            "direct-options",
            "existing-tab",
            "reload",
          ],
          managementSidePanelDisabledAndWindowClosed: true,
        }),
      ),
    });
  } finally {
    await session.close();
  }
});
