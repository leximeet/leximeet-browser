import { test, expect } from "./fixtures";
import {
  mutePractice,
  familiarCurrent,
  workspace,
  navigate,
  addWord,
  editWord,
  facts,
  setTarget,
} from "./ui-helpers";

// 正式 bundle 的同一隔离 profile：视觉证据和资料操作来自真实页面。
test("独立工作页：窄窗词卡四档、编辑、学习与明暗主题保持可用", async ({
  extension,
}, info) => {
  const page = await workspace(extension);
  await page.setViewportSize({ width: 390, height: 790 });
  await addWord(page, "resilient");
  await expect(page.locator(".lm-sense").first()).toBeVisible();
  await page.screenshot({
    path: info.outputPath("workspace-narrow-light.png"),
  });
  await editWord(page, "resilient");
  await expect(page.getByLabel("我的释义")).toHaveCount(0);
  await expect(page.getByLabel("标签，使用逗号分隔")).toHaveCount(0);
  await page.getByLabel("我的笔记").fill("来自独立版测试");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await navigate(page, "设置");
  await expect(page.getByLabel("词卡密度")).toHaveValue("moderate");
  await page.getByLabel("词卡密度").selectOption("complete");
  const completeDialog = page.getByRole("dialog", { name: "词卡显示设置" });
  await expect(completeDialog).toBeVisible();
  await completeDialog.getByRole("button", { name: "保存词卡设置", exact: true }).click();
  await expect(completeDialog).toHaveCount(0);
  await page.getByLabel("主题", { exact: true }).selectOption("dark");
  await expect(page.locator("main.lm-workspace")).toHaveAttribute("data-theme", "dark");
  await navigate(page, "我的词库");
  await expect(page.locator(".lm-sense").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "来源与审核", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
  ).toBe(false);
  await page.screenshot({ path: info.outputPath("workspace-narrow-dark.png") });
  await page.reload();
  await expect(page.locator("main.lm-workspace")).toHaveAttribute("data-theme", "dark");
  await editWord(page, "resilient");
  await expect(page.getByLabel("我的笔记")).toHaveValue("来自独立版测试");
  await page.getByRole("button", { name: "关闭对话框" }).click();
  await setTarget(page, 1);
  await navigate(page, "今日学习");
  await page.getByRole("tab", { name: /学习计划/ }).click();
  await page.locator(".v3-daily-group").locator("button").first().click();
  await mutePractice(page);
  await familiarCurrent(page, 11);
  await expect(page.locator(".v3-learning-score")).toContainText("+1");
  expect((await facts(page)).reviews).toHaveLength(1);
  await navigate(page, "我的词库");
  await page.getByRole("button", { name: "词卡显示设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "词卡显示设置" });
  await dialog.getByRole("button", { name: "自定义", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "候选音标", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "保存词卡设置", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".v3-card-pronunciation")).toHaveCount(0);
  await expect(page.locator(".v3-card-summary")).toBeVisible();
  await page.screenshot({ path: info.outputPath("workspace-custom-dark.png") });
  await page.reload();
  await navigate(page, "设置");
  await expect(page.getByLabel("词卡密度")).toHaveValue("custom");
  const data = await facts(page);
  expect(data.workspace.card.sections).not.toContain("pronunciations");
});

test("多个管理页的主题以实际提交通知同步，重复设置不依赖提示文案", async ({
  extension,
}) => {
  const first = await workspace(extension);
  const second = await workspace(extension);
  await navigate(first, "设置");
  await navigate(second, "设置");
  for (const theme of ["dark", "light", "dark"]) {
    await first.getByLabel("主题", { exact: true }).selectOption(theme);
    await expect(first.locator("main")).toHaveAttribute("data-theme", theme);
    await expect(second.locator("main")).toHaveAttribute("data-theme", theme);
  }
});
