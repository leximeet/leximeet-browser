import { test, expect } from "./fixtures.ts";
import { workspace, navigate, setTarget, facts } from "./ui-helpers.ts";

test("真实规划面板显示状态、作答与已知复习；额度比较、逐日预览和暂停不产生学习成绩", async ({
  extension,
}, info) => {
  const page = await workspace(extension);
  const skip = page.getByRole("button", { name: "跳过引导", exact: true });
  if (await skip.count()) await skip.click();
  await setTarget(page, 3);
  const panel = page.getByRole("region", { name: "学习预测面板" });
  await expect(panel).toBeVisible();
  const before = await facts(page);
  const preview = panel.locator(".forecast-word-panels article").nth(1);
  const first = await preview.locator(".forecast-word-chips > span").allTextContents();
  expect(first).toHaveLength(3);
  await page.getByRole("button", { name: "预览后一天" }).click();
  const second = await preview.locator(".forecast-word-chips > span").allTextContents();
  expect(second).toHaveLength(3);
  expect(second.some((w: string) => first.includes(w))).toBe(false);
  await page.getByRole("button", { name: "预览前一天" }).click();
  await expect(preview.locator(".forecast-word-chips > span")).toHaveText(first);
  await expect(panel.getByLabel("实际作答节奏", { exact: true })).toContainText("0 个词");
  await expect(panel.getByLabel("已知复习安排", { exact: true })).toContainText(
    "暂无已排程",
  );
  const comparison = panel.getByLabel("每日额度比较", { exact: true });
  await comparison.getByRole("button", { name: /每天 5 词/ }).click();
  await expect(preview.locator(".forecast-word-chips > span")).toHaveCount(5);
  await expect(comparison).toContainText("计划仍是每天 3 词");
  const compared = await facts(page);
  expect(compared.plan).toEqual(before.plan);
  expect(compared.practice).toEqual(before.practice);
  await comparison.getByRole("button", { name: /每天 3 词/ }).click();
  await expect(preview.locator(".forecast-word-chips > span")).toHaveText(first);
  for (const [theme, width] of [
    ["light", 1280],
    ["dark", 1280],
    ["light", 390],
    ["dark", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await navigate(page, "设置");
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await expect(page.locator("main")).toHaveAttribute("data-theme", theme);
    await navigate(page, "学习规划");
    await expect(panel).toBeVisible();
    await page
      .locator(".mg-page-body")
      .evaluate((element: HTMLElement) => (element.scrollTop = 0));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBe(false);
    await page.screenshot({
      path: info.outputPath(`planning-${theme}-${width}.png`),
      fullPage: true,
    });
    // 面板位于内部滚动区；扩大截图高度以完整记录真实组件，避免截到裁切空白。
    await page.setViewportSize({ width, height: width < 600 ? 2600 : 1700 });
    await page
      .locator(".mg-page-body")
      .evaluate((element: HTMLElement) => (element.scrollTop = 0));
    await panel.screenshot({ path: info.outputPath(`forecast-${theme}-${width}.png`) });
  }
  await page.getByRole("checkbox", { name: "启用学习计划", exact: true }).uncheck();
  await expect(panel).toContainText("已暂停");
  await expect(page.getByRole("button", { name: "预览后一天" })).toBeDisabled();
  await panel.getByRole("button", { name: "修改每日额度", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "调整学习计划", exact: true });
  await expect(editor.getByRole("spinbutton", { name: "每天学习新词数" })).toHaveValue(
    "3",
  );
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  const after = await facts(page);
  expect(after.practice).toEqual(before.practice);
  expect(after.reviews).toEqual(before.reviews);
});
