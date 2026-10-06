import { test, expect } from "./fixtures.ts";
import {
  workspace,
  navigate,
  setTarget,
  frozenChoice,
  mutePractice,
  facts,
} from "./ui-helpers.ts";

test("十题混合作答，最后题答错仍满格；切方式、保存和重开保持完成数", async ({
  extension,
}, info) => {
  let page = await workspace(extension);
  const skip = page.getByRole("button", { name: "跳过引导", exact: true });
  if (await skip.count()) await skip.click();
  await mutePractice(page);
  await setTarget(page, 10);
  for (const theme of ["light", "dark"] as const) {
    await navigate(page, "设置");
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await navigate(page, "学习规划");
    await page.screenshot({
      path: info.outputPath(`planning-after-${theme}.png`),
      fullPage: true,
    });
  }
  await navigate(page, "练习中心");
  const progress = page.getByRole("progressbar", { name: "练习进度" });
  for (let index = 1; index <= 10; index++) {
    await expect(page.locator(".v3-progress-line")).toContainText(`第 ${index} / 10 词`);
    await expect(page.locator(".v3-practice-stage")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    const question = await frozenChoice(page);
    const option = question.options.find((o: any) =>
      index === 10
        ? o.id !== question.correctChoiceId
        : o.id === question.correctChoiceId,
    );
    await page
      .locator(".v3-meaning-choices > button")
      .filter({ hasText: option.text })
      .click();
    await expect(page.locator(".v3-practice-stage")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(progress).toHaveAttribute("value", String(index));
  }
  await expect(progress).toHaveAttribute("max", "10");
  await expect(page.locator(".v3-practice-completion")).toHaveText("已完成 10 / 10");
  await page.screenshot({ path: info.outputPath("practice-last-wrong-100.png") });
  const attempts = (await facts(page)).practice;
  expect(attempts).toHaveLength(10);
  expect(attempts.filter((attempt: any) => !attempt.correct)).toHaveLength(1);
  expect(
    [...attempts]
      .sort((a: any, b: any) => a.learning.logicalClock - b.learning.logicalClock)
      .at(-1).correct,
  ).toBe(false);
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(progress).toHaveAttribute("value", "0");
  await page.getByRole("button", { name: "看词选义", exact: true }).click();
  await expect(progress).toHaveAttribute("value", "10");
  await page.getByRole("button", { name: "保存进度", exact: true }).click();
  await extension.restart();
  page = await workspace(extension);
  await navigate(page, "练习中心");
  await expect(page.getByRole("progressbar", { name: "练习进度" })).toHaveAttribute(
    "value",
    "10",
  );
  expect((await facts(page)).practice).toEqual(attempts);
  await navigate(page, "学习规划");
  const actual = page.getByLabel("实际作答节奏", { exact: true });
  await expect(actual).toContainText("10 个词");
  await expect(actual).toContainText("今天作答 10 词");
  await expect(page.getByLabel("已知复习安排", { exact: true })).toContainText(
    "暂无已排程",
  );
  await page
    .getByLabel("每日额度比较", { exact: true })
    .getByRole("button", { name: /每天 20 词/ })
    .click();
  expect((await facts(page)).practice).toEqual(attempts);
  for (const theme of ["light", "dark"] as const) {
    await navigate(page, "设置");
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await navigate(page, "学习规划");
    await page.setViewportSize({ width: 1280, height: 1700 });
    await page
      .locator(".mg-page-body")
      .evaluate((element: HTMLElement) => (element.scrollTop = 0));
    await page
      .getByRole("region", { name: "学习预测面板" })
      .screenshot({ path: info.outputPath(`planning-with-practice-${theme}.png`) });
  }
});

test("列表跳到末词仍保留真实未完成数，结束后补练缺词而不重复记分", async ({
  extension,
}) => {
  const page = await workspace(extension);
  const skip = page.getByRole("button", { name: "跳过引导", exact: true });
  if (await skip.count()) await skip.click();
  await mutePractice(page);
  await setTarget(page, 3);
  await navigate(page, "练习中心");
  await page.getByRole("button", { name: "单词列表", exact: true }).click();
  const rows = page.locator(".v3-practice-list-row");
  const progress = page.getByRole("progressbar", { name: "练习进度" });
  await rows.nth(2).getByRole("button", { name: "不熟悉 −1", exact: true }).click();
  await expect(progress).toHaveAttribute("value", "1");
  await expect(page.locator(".v3-practice-remaining")).toContainText("还有 2 词未完成");
  await page.getByRole("button", { name: "下一个", exact: true }).click();
  await expect(page.locator(".v3-practice-empty")).toContainText("跳过 2 词");
  await expect(progress).toHaveAttribute("value", "1");
  await page.getByRole("button", { name: "补练未完成", exact: true }).click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 3 词");
  await rows.nth(0).getByRole("button", { name: "熟悉 +1", exact: true }).click();
  await expect(progress).toHaveAttribute("value", "2");
  await rows.nth(1).getByRole("button", { name: "熟悉 +1", exact: true }).click();
  await expect(progress).toHaveAttribute("value", "3");
  const attempts = (await facts(page)).practice;
  expect(attempts).toHaveLength(3);
  await page.getByRole("button", { name: "上一个", exact: true }).click();
  await expect(progress).toHaveAttribute("value", "3");
  expect((await facts(page)).practice).toEqual(attempts);
});
