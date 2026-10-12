import { test, expect } from "./fixtures";
import { readingServer } from "../helpers/extension.cjs";
import { workspace, facts, panelTitle, pickWord } from "./ui-helpers";

test("空采集切标签、切模式及打开管理直接退出；移除末条后也不弹保存确认", async ({
  extension,
}, info) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  const server = await readingServer(
    (url) =>
      `<!doctype html><title>${url === "/second" ? "Second reading" : "Empty capture"}</title><style>body{margin:40px;font:22px/1.8 Georgia}</style><p>A resilient reader returns.</p>`,
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    const dialog = panel.getByRole("dialog", { name: "继续采集吗？" });
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    const second = await extension.context.newPage();
    await second.goto(server.url + "/second");
    await expect.poll(() => panelTitle(panel)).toBe("Second reading");
    await panel.screenshot({ path: info.outputPath("empty-capture-switch.png") });
    await expect(dialog).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "开始采集", exact: true }),
    ).toBeEnabled();
    await reading.bringToFront();
    await expect.poll(() => panelTitle(panel)).toBe("Empty capture");
    await expect(
      panel.getByRole("button", { name: "开始采集", exact: true }),
    ).toBeEnabled();
    await panel.getByRole("button", { name: "开始采集", exact: true }).click();
    await panel.getByRole("button", { name: "遇见", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(reading.locator("body > p")).not.toHaveCSS("cursor", "grab");
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await pickWord(reading, "resilient");
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    await panel.getByRole("button", { name: "遇见", exact: true }).click();
    await expect(dialog).toContainText("1 条语境未加入单词本");
    await dialog.getByRole("button", { name: "继续采集", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await panel.getByRole("button", { name: "打开管理", exact: true }).click();
    await expect(dialog).toContainText("1 条语境未加入单词本");
    await dialog.getByRole("button", { name: "继续采集", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await panel.getByRole("button", { name: "编辑语境", exact: true }).click();
    await panel.getByRole("button", { name: "移除此处", exact: true }).click();
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    const opened = extension.context.waitForEvent("page");
    await panel.getByRole("button", { name: "打开管理", exact: true }).click();
    const nextManager = await opened;
    await expect(nextManager).toHaveURL(/options\.html/);
    await expect
      .poll(() =>
        nextManager.evaluate(() =>
          (globalThis as any).chrome.runtime.getContexts({
            contextTypes: ["SIDE_PANEL"],
          }),
        ),
      )
      .toHaveLength(0);
    expect((await facts(nextManager)).encounters).toHaveLength(0);
    await expect(reading.locator("body > p")).not.toHaveCSS("cursor", "grab");
  } finally {
    await server.close();
  }
});

test("SPA 导航提示自动关闭；连续同文提示重新计时，清空后旧计时不影响新状态", async ({
  extension,
}, info) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  const server = await readingServer(
    `<!doctype html><title>Navigation notice</title><style>body{margin:40px;font:22px/1.8 Georgia}</style><p>A resilient reader returns.</p><button id="next" onclick="history.pushState({}, '', '/article-'+ ++window.turn)">Next article</button><script>window.turn=0</script>`,
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const notice = reading.locator("leximeet-page-ui .notice");
    await expect(reading.locator("leximeet-page-ui .ball")).toBeVisible();
    await reading.getByRole("button", { name: "Next article", exact: true }).click();
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("重新分析");
    await reading.screenshot({ path: info.outputPath("navigation-notice.png") });
    await expect(notice).toBeHidden();
    await reading.getByRole("button", { name: "Next article", exact: true }).click();
    await expect(notice).toBeVisible();
    await reading.waitForTimeout(2000); // 观察真实产品计时，不改时钟或覆盖通知方法。
    await reading.getByRole("button", { name: "Next article", exact: true }).click();
    await expect(notice).toBeVisible();
    await reading.waitForTimeout(1800); // 已跨过前条提示的到期点，但新提示仍需可见。
    await expect(notice).toBeVisible();
    await expect(notice).toBeHidden();
    await reading.getByRole("button", { name: "Next article", exact: true }).click();
    await expect(notice).toBeVisible();
    const panel = await extension.openPanel(reading);
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(notice).toBeHidden();
    await expect(reading.locator("body > p")).toHaveCSS("cursor", "grab");
    await reading.waitForTimeout(3600);
    await expect(reading.locator("body > p")).toHaveCSS("cursor", "grab");
    await expect(notice).toBeHidden();
  } finally {
    await server.close();
  }
});
