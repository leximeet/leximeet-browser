import { activeTabUrl } from "./ui-helpers";
import { closeNativePanel } from "./ui-helpers";
import { test, expect } from "./fixtures";
import { readingServer } from "../helpers/extension.cjs";
import {
  workspace,
  addWord,
  facts,
  pickWord,
  wordPoint,
  nativePanel,
} from "./ui-helpers";

test("采集直接就绪：无全文查词/高亮，悬停辅助与跨节点原句、重复点击、切模式丢弃", async ({
  extension,
}, info) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  const padding =
    "<p>A practical reading system supports independent learners and careful attention.</p>".repeat(
      1200,
    );
  const server = await readingServer(
    `<!doctype html><meta charset="utf-8"><title>Direct picking</title><style>body{margin:40px;font:22px/1.9 Georgia}p{max-width:600px}</style><p id="first">📚 A res<em>ilient</em> reader returns. Another resilient reader keeps a LexiMeetSecret.</p><pre>codesecret</pre><p contenteditable="true">editorsecret</p><button id="site" onclick="this.textContent='restored'">Site button</button>${padding}`,
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    const before = await reading.locator("#first").evaluate((p) => ({
      html: p.innerHTML,
      rect: p.getBoundingClientRect().toJSON(),
    }));
    // 旁听真实消息，不返回业务结果或替换 chrome API。
    await extension.worker.evaluate(() => {
      (globalThis as any).__readingMessages = [];
      (globalThis as any).chrome.runtime.onMessage.addListener((message: any) => {
        if (message.channel === "leximeet")
          (globalThis as any).__readingMessages.push(message.action);
      });
    });
    const at = Date.now();
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    const entryMilliseconds = Date.now() - at;
    await panel.screenshot({
      path: info.outputPath("direct-capture-ready.png"),
    });
    expect(entryMilliseconds).toBeLessThan(2500);
    expect(
      await reading.evaluate(() =>
        [...(CSS as any).highlights.values()].reduce(
          (n: number, h: any) => n + h.size,
          0,
        ),
      ),
    ).toBe(0);
    expect(
      await extension.worker.evaluate(() => (globalThis as any).__readingMessages),
    ).not.toContain("resolve");
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    const point = await wordPoint(reading, "resilient");
    await reading.mouse.move(point.x, point.y);
    await expect(reading.locator("leximeet-page-ui .pick-lens")).toHaveText("resilient");
    await reading.mouse.click(point.x, point.y);
    await reading.mouse.click(point.x, point.y);
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    await expect(panel.locator(".lm-detail h2")).toHaveText("resilient");
    await pickWord(reading, "resilient", 1);
    await expect(panel.locator(".lm-row")).toHaveCount(2);
    await pickWord(reading, "LexiMeetSecret");
    await expect(panel.locator(".lm-row")).toHaveCount(3);
    const after = await reading.locator("#first").evaluate((p) => ({
      html: p.innerHTML,
      rect: p.getBoundingClientRect().toJSON(),
    }));
    expect(after).toEqual(before);
    await panel.getByRole("button", { name: "遇见", exact: true }).click();
    const dialog = panel.getByRole("dialog", { name: "继续采集吗？" });
    await expect(dialog).toContainText("3 条语境未加入单词本");
    await panel.screenshot({
      path: info.outputPath("mode-switch-confirm.png"),
    });
    await dialog.getByRole("button", { name: "继续采集", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "采集", exact: true })).toHaveClass(
      /active/,
    );
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "开始采集", exact: true }),
    ).toBeVisible();
    const saved = await facts(manager);
    expect(saved.encounters).toHaveLength(3);
    const firstContext = saved.encounters.find(
      (e: any) => e.originalSentence === "📚 A resilient reader returns.",
    );
    expect(firstContext).toBeDefined();
    expect(firstContext.occurrenceRanges).toEqual([{ start: 5, end: 14 }]);
    expect(saved.encounters.filter((e: any) => e.surface === "resilient")).toHaveLength(
      2,
    );
    await panel.getByRole("button", { name: "开始采集", exact: true }).click();
    await pickWord(reading, "reader");
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    await panel.getByRole("button", { name: "遇见", exact: true }).click();
    await dialog.getByRole("button", { name: "不继续，丢弃未加入", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(reading.locator("body")).not.toHaveCSS("cursor", "grab");
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    expect((await facts(manager)).encounters).toEqual(saved.encounters);
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "遇见", exact: true }).click();
    await expect(dialog).toContainText("当前没有待加入的单词");
    await dialog.getByRole("button", { name: "不继续，丢弃未加入", exact: true }).click();
    await reading.getByRole("button", { name: "Site button", exact: true }).click();
    await expect(reading.locator("#site")).toHaveText("restored");
    await info.attach("direct-picking-evidence", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          entryMilliseconds,
          paragraphs: 1201,
          noResolveBeforeClick: true,
          noPageHighlights: true,
          crossInlineUtf16Context: true,
          samePositionDeduplicated: true,
          savedFactsPreservedOnDiscard: true,
        }),
      ),
    });
  } finally {
    await server.close();
  }
});

test("悬浮球开关：旋转忙碌、再次点击静默取消、连续切换最后状态生效、右键打开原生侧栏", async ({
  extension,
}, info) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  await addWord(manager, "resilient");
  const server = await readingServer(
    '<!doctype html><meta charset="utf-8"><title>Encounter toggle</title><style>body{margin:50px;font:22px/1.9 Georgia}</style><p>A resilient reader keeps a practical system. Careful attention supports independent reading.</p>',
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    let panel = await extension.openPanel(reading);
    await closeNativePanel(panel);
    const ball = reading.locator("leximeet-page-ui .ball");
    await expect(ball).toBeVisible();
    await ball.hover();
    await expect(reading.locator("leximeet-page-ui .ball-tip button")).toHaveCount(0);
    // 观察忙碌状态与实际动画，快速完成时也必须提供反馈。
    await ball.evaluate((el) => {
      (globalThis as any).__ballSpinners = [];
      new MutationObserver(() => {
        if (el.getAttribute("aria-busy") === "true")
          (globalThis as any).__ballSpinners.push(
            getComputedStyle(el.querySelector(".ball-spinner")!).animationName,
          );
      }).observe(el, { attributes: true, attributeFilter: ["aria-busy"] });
    });
    await ball.click();
    await expect(ball).toHaveAttribute("aria-busy", "false");
    await expect(ball).toHaveAttribute("aria-pressed", "true");
    expect(await reading.evaluate(() => (globalThis as any).__ballSpinners)).toContain(
      "ball-spin",
    );
    await reading.waitForTimeout(220);
    await ball.click();
    await expect(ball).toHaveAttribute("aria-busy", "false");
    await expect(ball).toHaveAttribute("aria-pressed", "false");
    expect(
      await reading.evaluate(() =>
        [...(CSS as any).highlights.values()].reduce(
          (n: number, h: any) => n + h.size,
          0,
        ),
      ),
    ).toBe(0);
    await expect(reading.locator("leximeet-page-ui .notice")).toBeHidden();
    // 两次真实快速点击仍应回到关闭态，不能为了限流直接丢弃第二次“关闭”。
    await reading.waitForTimeout(220);
    await ball.dblclick({ delay: 30 });
    await expect(ball).toHaveAttribute("aria-busy", "false");
    await expect(ball).toHaveAttribute("aria-pressed", "false");
    await expect(reading.locator("leximeet-page-ui .notice")).toBeHidden();
    // 每 220ms 一次有效动作，覆盖开→关→开，不等待前一次查词完成。
    await reading.waitForTimeout(220);
    await ball.click();
    await reading.waitForTimeout(220);
    await ball.click();
    await reading.waitForTimeout(220);
    await ball.click();
    await expect(ball).toHaveAttribute("aria-busy", "false");
    await expect(ball).toHaveAttribute("aria-pressed", "true");
    await reading.waitForTimeout(220);
    await ball.click();
    await expect(ball).toHaveAttribute("aria-pressed", "false");
    await ball.click({ button: "right" });
    panel = await nativePanel(extension.context);
    await expect(panel.getByRole("button", { name: "遇见", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "采集", exact: true })).toBeVisible();
    // Chromium 调试页的 visibilityState 不代表原生选中标签；读取真实 tabs 状态。
    await expect.poll(() => activeTabUrl(extension.worker)).toBe(reading.url());
    await expect
      .poll(() => reading.evaluate(() => document.visibilityState))
      .toBe("visible");
    await expect(ball).toBeVisible();
    expect(
      await extension.worker.evaluate(() =>
        (globalThis as any).chrome.runtime.getContexts({
          contextTypes: ["SIDE_PANEL"],
        }),
      ),
    ).toHaveLength(1);
    await closeNativePanel(panel);
    await expect(ball).toBeVisible();
    await ball.focus();
    await reading.keyboard.press("Shift+F10");
    panel = await nativePanel(extension.context);
    await expect(ball).toBeVisible();
    await closeNativePanel(panel);
    panel = await extension.openPanel(reading);
    await info.attach("encounter-toggle-evidence", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          actualSpinner: true,
          silentOff: true,
          latestIntentWins: true,
          rapidDoubleClickEndsOff: true,
          rightClickNativePanel: true,
          keyboardNativePanel: true,
          toolbarNativePanel: true,
        }),
      ),
    });
  } finally {
    await server.close();
  }
});
