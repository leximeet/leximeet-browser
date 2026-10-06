import { test, expect } from "./fixtures.ts";
import {
  workspace,
  navigate,
  addWord,
  mutePractice,
  familiarCurrent,
  graduateCurrent,
  facts,
  setTarget,
} from "./ui-helpers.ts";

test("实际练习完成初学与30分休息，六种状态全库筛选；重启保留事件和计划暂停", async ({
  extension,
}, info) => {
  // 包含真实的 20 次反馈和整浏览器重启；只调整维护者确认的整例时间。
  info.setTimeout(90000);
  let page = await workspace(extension);
  await addWord(page, "resilient");
  await mutePractice(page);
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await graduateCurrent(page);
  await navigate(page, "我的词库");
  await page.getByRole("button", { name: "待复习", exact: true }).click();
  await expect(page.locator(".v3-library-row > button")).toHaveCount(1);
  await expect(page.locator(".v3-card-origin")).toContainText("20 / 30 分");
  await expect(page.locator(".v3-card-origin")).toContainText("待复习");
  for (let score = 21; score <= 30; score++) {
    await navigate(page, "练习中心");
    await page.getByRole("button", { name: "重新开始", exact: true }).click();
    await familiarCurrent(page, score);
  }
  await navigate(page, "我的词库");
  await page.getByRole("button", { name: "已熟悉", exact: true }).click();
  await expect(page.locator(".v3-library-row > button")).toHaveCount(1);
  await expect(page.locator(".v3-card-origin")).toContainText("30 / 30 分");
  const original = await facts(page);
  expect(original.practice).toHaveLength(20);
  expect(original.reviews).toHaveLength(1);
  expect(
    original.practice.every((p: any) => p.learning.entryId === original.words[0].entryId),
  ).toBe(true);
  await setTarget(page, 10);
  await page.getByRole("checkbox", { name: "启用学习计划", exact: true }).uncheck();
  await expect.poll(async () => (await facts(page)).plan.paused).toBe(true);
  await extension.restart();
  page = await workspace(extension);
  await navigate(page, "我的词库");
  await page.getByRole("button", { name: "已熟悉", exact: true }).click();
  await expect(page.locator(".v3-card-origin")).toContainText("30 / 30 分");
  expect((await facts(page)).practice).toEqual(original.practice);
  expect((await facts(page)).reviews).toEqual(original.reviews);
  await navigate(page, "学习规划");
  await expect(
    page.getByRole("checkbox", { name: "启用学习计划", exact: true }),
  ).not.toBeChecked();
});

test("两窗口规划冲突保留编辑稿，不覆盖新的目标配额", async ({ extension }) => {
  const first = await workspace(extension);
  await setTarget(first, 10);
  await first.getByRole("button", { name: "调整计划", exact: true }).click();
  const oldEditor = first.getByRole("dialog", { name: "调整学习计划" });
  await oldEditor.getByRole("spinbutton", { name: "每天学习新词数" }).fill("15");
  const second = await workspace(extension);
  await navigate(second, "学习规划");
  await second.getByRole("button", { name: "调整计划", exact: true }).click();
  const editor = second.getByRole("dialog", { name: "调整学习计划" });
  await editor.getByRole("spinbutton", { name: "每天学习新词数" }).fill("12");
  await editor.getByRole("button", { name: "保存学习计划", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await first.bringToFront();
  await oldEditor.getByRole("button", { name: "保存学习计划", exact: true }).click();
  await expect(oldEditor.getByRole("alert")).toContainText("另一窗口");
  await expect(oldEditor.getByRole("spinbutton", { name: "每天学习新词数" })).toHaveValue(
    "15",
  );
  expect((await facts(first)).plan.dailyNew).toBe(12);
  await oldEditor.getByRole("button", { name: "取消", exact: true }).click();
  await first.getByRole("button", { name: "调整计划", exact: true }).click();
  await expect(
    first.getByRole("dialog").getByRole("spinbutton", { name: "每天学习新词数" }),
  ).toHaveValue("12");
});
