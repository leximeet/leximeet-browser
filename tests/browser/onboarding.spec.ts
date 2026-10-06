import type { Page } from "@playwright/test";
import { panelTitle, closeNativePanel } from "./ui-helpers";
import { test, expect } from "./fixtures";
import {
  facts,
  setTarget,
  nativePanel,
  pickWord,
  navigate,
  wordPoint,
} from "./ui-helpers";

for (const pinFirst of [true, false])
  test(`内置教学：${pinFirst ? "固定后点图标" : "略过固定点下一步"}，真实侧栏、规划、采集和悬浮五步连续完成`, async ({
    extension,
  }, info) => {
    // 各入口都完整走过原生侧栏、规划、采集和悬浮五步；单独给完整流程时间。
    info.setTimeout(90000);
    const progress = () =>
      extension.worker.evaluate(
        async () =>
          (await (globalThis as any).chrome.storage.local.get("leximeet-onboarding-v2"))[
            "leximeet-onboarding-v2"
          ],
      );
    const contexts = () =>
      extension.worker.evaluate(() =>
        (globalThis as any).chrome.runtime.getContexts({
          contextTypes: ["SIDE_PANEL"],
        }),
      );
    const lesson = extension.context
      .pages()
      .find((p) => p.url().endsWith("tutorial.html"))!;
    const coach = lesson.locator("leximeet-page-ui .page-guide");
    await expect(coach).toHaveAttribute("data-step", "pin");
    expect(await contexts()).toHaveLength(0);
    await expect(lesson.locator("leximeet-page-ui .ball")).toBeHidden();
    await expect(
      lesson.getByRole("button", { name: "完成这一步", exact: true }),
    ).toHaveCount(0);
    await lesson.screenshot({
      path: info.outputPath("tutorial-pin-light.png"),
    });
    let panel: Page;
    if (pinFirst) {
      const opened = extension.context.waitForEvent("page");
      await coach.getByRole("button", { name: "在扩展设置中固定", exact: false }).click();
      const details = await opened;
      await expect(details).toHaveURL(`chrome://extensions/?id=${extension.extensionId}`);
      expect(
        await extension.worker.evaluate(
          async () =>
            (await (globalThis as any).chrome.action.getUserSettings()).isOnToolbar,
        ),
      ).toBe(false);
      // 真实 Chrome WebUI 开关，不能伪造图钉状态。默认教学优先提示浏览器拼图菜单。
      await details.getByRole("button", { name: "固定到工具栏", exact: true }).click();
      await expect(coach).toHaveAttribute("data-step", "panel");
      expect(await contexts()).toHaveLength(0);
      await details.close();
      panel = await extension.openPanel(lesson);
    } else {
      // 用户不必知道怎么固定；真实点击直接打开 SIDE_PANEL，不能伪造图钉事实。
      await coach.getByRole("button", { name: "下一步，打开侧栏", exact: false }).click();
      panel = await nativePanel(extension.context);
      expect(
        await extension.worker.evaluate(
          async () =>
            (await (globalThis as any).chrome.action.getUserSettings()).isOnToolbar,
        ),
      ).toBe(false);
      await expect.poll(async () => (await progress()).pinSkipped).toBe(true);
    }
    await expect(panel.locator(".v3-live-coach")).toHaveAttribute("data-step", "plan");
    await expect.poll(() => panelTitle(panel)).toBe("词遇 · 使用教学");
    const openedManager = extension.context.waitForEvent("page");
    await panel.getByRole("button", { name: "打开管理", exact: true }).click();
    const manager = await openedManager;
    await expect(manager).toHaveURL(/options\.html#\/plan$/);
    await setTarget(manager, 12);
    await expect(manager.locator(".v3-live-coach")).toHaveAttribute(
      "data-step",
      "encounter",
    );
    await manager.getByRole("button", { name: "返回阅读页", exact: false }).click();
    panel = await nativePanel(extension.context);
    await panel.getByRole("button", { name: "分析本页", exact: true }).click();
    await expect(coach).toHaveAttribute("data-step", "encounter", {
      timeout: 15000,
    });
    await expect(coach).toContainText("悬停");
    await expect(panel.locator(".v3-live-coach")).toBeHidden();
    expect((await progress()).completed.at(-1)).toBe("plan");
    const word = (await panel.locator(".lm-row strong").first().innerText()).trim();
    const point = await wordPoint(lesson, word);
    await lesson.mouse.move(point.x, point.y);
    await expect(lesson.locator("leximeet-page-ui .card")).toBeVisible();
    await expect(panel.locator(".v3-live-coach")).toHaveAttribute("data-step", "capture");
    await expect(panel.locator(".lm-row").first()).toBeVisible();
    await expect(lesson.locator("leximeet-page-ui .ball")).toBeHidden();
    // 内置阅读页真实刷新后保留阶段，并重新握手；不写教学完成事件。
    await lesson.reload();
    expect((await progress()).completed).toEqual(["pin", "panel", "plan", "encounter"]);
    // 刷新结束旧 Range；当前阶段由真实侧栏指引，开始新采集后才指向正文中的实际词。
    await expect(coach).toBeHidden();
    await expect(panel.locator(".v3-live-coach")).toHaveAttribute("data-step", "capture");
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    await expect(coach).toBeVisible();
    await pickWord(lesson, "resilient");
    await expect(panel.getByText("待加入语境 · 1 条")).toBeVisible();
    expect((await progress()).completed.at(-1)).toBe("encounter");
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect(panel.locator(".v3-live-coach")).toHaveAttribute(
      "data-step",
      "floating",
    );
    const data = await facts(manager);
    expect(data.encounters).toHaveLength(1);
    expect(data.encounters[0].surface).toBe("resilient");
    expect(data.encounters[0].source.url).toBe("leximeet://tutorial/reading");
    expect(data.words).toHaveLength(1);
    expect(data.plan.dailyNew).toBe(12);
    expect(data.plan.dailyReview).toBe(30);
    await expect(panel.locator(".v3-live-coach")).toContainText("接下来，试试悬浮按钮");
    await expect(panel.locator(".v3-coach-connector")).toBeHidden();
    await panel.screenshot({
      path: info.outputPath("tutorial-native-panel-light.png"),
    });
    if (pinFirst) await closeNativePanel(panel);
    else
      await panel
        .getByRole("button", { name: "收起侧栏，继续教学", exact: false })
        .click();
    await expect.poll(async () => (await progress()).floating.closed).toBe(true);
    const ball = lesson.locator("leximeet-page-ui .ball");
    await expect(ball).toBeVisible();
    await expect(coach).toBeVisible();
    await expect(coach).toHaveAttribute("data-substep", "encounter-on");
    await expect(coach.getByLabel("悬浮按钮的五步操作").locator("li")).toHaveCount(5);
    await expect(lesson.locator("#lesson-skip")).toBeVisible();
    await lesson.screenshot({
      path: info.outputPath("tutorial-floating-on.png"),
    });
    await ball.hover();
    await expect.poll(async () => (await progress()).floating.hovered).toBe(true);
    await expect(lesson.locator("leximeet-page-ui .ball-tip")).toBeVisible();
    await ball.click();
    await expect.poll(async () => (await progress()).floating.analyzed).toBe(true);
    await expect(coach).toContainText("再点一下，取消遇见");
    await expect(coach).toHaveAttribute("data-substep", "encounter-off");
    await lesson.screenshot({
      path: info.outputPath("tutorial-floating-off.png"),
    });
    await ball.click();
    await expect.poll(async () => (await progress()).floating.deactivated).toBe(true);
    await expect(ball).toHaveAttribute("aria-pressed", "false");
    await expect(coach).toContainText("拖到单词上，松开采集");
    await expect(coach).toHaveAttribute("data-substep", "collect");
    await lesson.screenshot({
      path: info.outputPath("tutorial-floating-collect.png"),
    });
    const collectorPoint = await wordPoint(lesson, "resource");
    await ball.hover();
    await lesson.mouse.down();
    await lesson.mouse.move(collectorPoint.x, collectorPoint.y, { steps: 12 });
    await expect(lesson.locator("leximeet-page-ui .collector-card .word")).toHaveText(
      "resource",
    );
    await lesson.mouse.up();
    await expect.poll(async () => (await progress()).floating.captured).toBe(true);
    await expect(coach).toContainText("右键，打开阅读侧栏");
    await expect(coach).toHaveAttribute("data-substep", "sidebar");
    await lesson.screenshot({
      path: info.outputPath("tutorial-floating-sidebar.png"),
    });
    const captured = await facts(manager);
    expect(captured.encounters.length).toBe(data.encounters.length + 1);
    await ball.click({ button: "right" });
    await expect.poll(async () => (await progress()).floating.reopened).toBe(true);
    expect((await progress()).completed).toHaveLength(5);
    expect(await contexts()).toHaveLength(1);
    const returnedPanel = await nativePanel(extension.context);
    await expect(
      returnedPanel.getByRole("button", { name: "遇见", exact: true }),
    ).toBeVisible();
    await expect(
      returnedPanel.getByRole("button", { name: "采集", exact: true }),
    ).toBeVisible();
    await expect(ball).toBeVisible();
    await expect(coach).toHaveAttribute("data-substep", "sidebar-close");
    await expect(coach).toContainText("再右键，收起阅读侧栏");
    await lesson.screenshot({
      path: info.outputPath("tutorial-floating-sidebar-close.png"),
    });
    await ball.click({ button: "right" });
    await expect.poll(contexts).toHaveLength(0);
    await expect.poll(async () => (await progress()).completed.length).toBe(6);
    await expect(ball).toBeVisible();
    // 未声明 tabs 权限时扩展页 URL 可被省略；用真实 tab ID 验证仍留在教学页。
    const lessonTab = await lesson.evaluate(() =>
      (globalThis as any).chrome.tabs.getCurrent(),
    );
    await expect
      .poll(() =>
        extension.worker.evaluate(async () => {
          const [active] = await (globalThis as any).chrome.tabs.query({
            active: true,
            lastFocusedWindow: true,
          });
          return active?.id;
        }),
      )
      .toBe(lessonTab.id);
    await lesson.bringToFront();
    await expect(lesson.locator("#lesson-manage")).toBeVisible();
    await expect(
      lesson.locator("leximeet-page-ui .page-guide-celebration"),
    ).toBeVisible();
    await lesson.reload();
    await expect(lesson.locator("#lesson-status")).toContainText("教学完成");
    await manager.bringToFront();
    await navigate(manager, "设置");
    await manager.getByRole("button", { name: "重新进入教学", exact: true }).click();
    await expect(coach).toHaveAttribute("data-step", pinFirst ? "panel" : "pin");
    expect((await facts(manager)).encounters).toEqual(captured.encounters);
    await info.attach("builtin-tutorial-real-flow", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          bundledEnglishPage: true,
          nativePinState: pinFirst,
          skippedPinKeepsRealUnpinnedState: !pinFirst,
          fourFloatingSubstepsVisible: true,
          explicitContinueAfterClose: !pinFirst,
          panelOnlyOpenedAfterUserGesture: true,
          realSidePanel: true,
          actualPlan: true,
          actualRangeCapture: true,
          stableTutorialSource: true,
          noExternalLessonNetwork: true,
          stageCelebrations: true,
          settingsRestartsWithoutChangingFacts: true,
        }),
      ),
    });
  });
