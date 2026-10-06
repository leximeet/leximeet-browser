import { mutePractice } from "./ui-helpers";
import { test, expect } from "./fixtures";
import { readFile } from "node:fs/promises";
import { readingServer } from "../helpers/extension.cjs";
import {
  pickWord,
  workspace,
  navigate,
  addWord,
  setTarget,
  editWord,
  facts,
  practiceSettings,
  graduateCurrent,
} from "./ui-helpers";
test("0.0.3 Lite Text 真实目录、逐义词卡、关联和明暗设置", async ({
  extension,
}, info) => {
  const page = await workspace(extension);
  await navigate(page, "词库中心");
  await expect(page.locator(".mg-theme-card")).toHaveCount(16);
  await page.getByRole("button", { name: "专业", exact: true }).click();
  await expect(page.locator(".mg-theme-card")).toHaveCount(7);
  await page.getByRole("searchbox", { name: "搜索考试与专业词书" }).fill("四级");
  await expect(page.locator(".mg-theme-card")).toHaveCount(2);
  await page.getByRole("button", { name: "本地词典", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Lite Text 已启用" })).toBeVisible();
  await expect(page.getByRole("button", { name: "桌面端提供" })).toBeDisabled();
  await addWord(page, "resilient");
  await page.getByRole("button", { name: "新建单词本", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建单词本" });
  await dialog.getByRole("textbox", { name: "单词本名称" }).fill("考试积累");
  await dialog.getByRole("button", { name: "保存单词本", exact: true }).click();
  await editWord(page, "resilient");
  await page.getByRole("checkbox", { name: "考试积累", exact: true }).check();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".lm-sense").first()).toBeVisible();
  const data = await facts(page);
  expect(data.encounters).toHaveLength(0);
  expect(data.words[0].notebookIds).toContain(
    data.notebooks.find((n: any) => n.name === "考试积累").id,
  );
  await page.screenshot({ path: info.outputPath("library-light.png") });
  await navigate(page, "设置");
  await page.getByLabel("主题", { exact: true }).selectOption("dark");
  await expect(page.locator("main.lm-workspace")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: info.outputPath("management-dark.png") });
});
test("唯一目标、双配额、今日概览和真实毕业，不由查询伪造遇见", async ({
  extension,
}, info) => {
  const page = await workspace(extension);
  await setTarget(page, 12);
  await expect(page.locator(".v3-current-plan")).toContainText(
    "每天 12 新词 + 30 复习词",
  );
  await navigate(page, "今日学习");
  await page.getByRole("tab", { name: /学习计划/ }).click();
  await expect(page.locator(".v3-home-dashboard")).toBeVisible();
  await expect(page.locator(".v3-daily-group").locator("button")).toHaveCount(12);
  await page.locator(".v3-daily-group").locator("button").first().click();
  await mutePractice(page);
  await graduateCurrent(page);
  await navigate(page, "今日学习");
  await page.getByRole("tab", { name: /学习计划/ }).click();
  await expect(page.locator(".v3-daily-group").locator("button")).toHaveCount(11);
  const data = await facts(page);
  expect(data.reviews).toHaveLength(1);
  expect(data.practice).toHaveLength(10);
  expect(
    data.practice.every((p: any) => p.learning.ruleVersion === "leximeet.learning/2"),
  ).toBe(true);
  expect(data.words[0].collected).toBe(false);
  expect(data.encounters).toHaveLength(0);
  expect(data.plan.sourceKind).toBe("catalog");
  expect(data.plan.dailyReview).toBe(30);
  await page.screenshot({ path: info.outputPath("today-after-review.png") });
  await navigate(page, "学习规划");
  const forecast = page.getByRole("region", { name: "学习预测面板" });
  // 新面板按真实今日候选验证同一剩余额度，不依赖已替换的日期行布局。
  await expect(
    forecast
      .locator(".forecast-word-panels article")
      .first()
      .locator(".forecast-word-chips > span"),
  ).toHaveCount(11);
  await expect(forecast.locator(".forecast-overview h2")).toHaveText(
    /1\s*\/\s*2,607 词完成初学/,
  );
  await expect(forecast.locator(".forecast-percentage")).toContainText("目标初学完成率");
  await page.getByRole("button", { name: "调整计划", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "调整学习计划" });
  await expect(dialog.locator(".v3-forecast p").first()).toContainText("11 新词");
  await expect(dialog.locator(".v3-forecast strong")).toContainText("剩余");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
test("三种练习独立位置和草稿，仅换范围确认，整浏览器重开恢复", async ({
  extension,
}, info) => {
  let page = await workspace(extension);
  for (const word of ["resilient", "attention", "system"]) await addWord(page, word);
  await mutePractice(page);
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await expect(page.locator(".v3-meaning-choices button")).toHaveCount(4);
  await expect(page.locator(".v3-meaning-choices")).not.toContainText(/后缀|Unix/);
  for (let i = 0; i < 2; i++) {
    await page.locator(".v3-meaning-choices button").first().click();
    await page.getByRole("button", { name: "下一个", exact: false }).click();
  }
  await expect(page.locator(".v3-progress-line")).toContainText("第 3 / 3 词");
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await practiceSettings(page);
  const word = (await page.locator(".v3-character").allTextContents()).join("");
  await page
    .getByRole("textbox", { name: "逐字拼写" })
    .pressSequentially(word.slice(0, 2));
  await expect(page.locator(".v3-character.typed")).toHaveCount(2);
  await page.getByRole("button", { name: "单词默写", exact: true }).click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 3 词");
  await expect(page.locator(".v3-character.typed")).toHaveCount(0);
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(page.locator(".v3-character.typed")).toHaveCount(2);
  await page.getByRole("button", { name: "保存进度", exact: true }).click();
  const before = await facts(page);
  expect(before.reviews).toHaveLength(2);
  expect(before.reviews.every((r: any) => r.sourceSubmissionId)).toBe(true);
  expect(before.checkpoints.library.index).toBe(0);
  expect(before.checkpoints.library.indices["meaning-choice"]).toBe(2);
  await extension.restart();
  page = await workspace(extension);
  await mutePractice(page);
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 3 词");
  await expect(page.locator(".v3-character.typed")).toHaveCount(2);
  await page
    .getByRole("textbox", { name: "逐字拼写" })
    .pressSequentially(word.slice(2, 3));
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("target");
  await expect(page.getByRole("dialog", { name: "保存当前练习进度？" })).toBeVisible();
  await page.getByRole("button", { name: "继续练习", exact: true }).click();
  await page.screenshot({ path: info.outputPath("practice-independent-position.png") });
});
test("逐字临摹和默写：重复两次、错字重写、提示与反馈", async ({ extension }) => {
  const page = await workspace(extension);
  await addWord(page, "resilient");
  await mutePractice(page);
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await practiceSettings(page, 2, false);
  const input = page.getByRole("textbox", { name: "逐字拼写" });
  await input.press("z");
  await expect(page.locator(".v3-character-stage")).toHaveClass(/error/);
  await expect(page.locator(".v3-character-stage")).not.toHaveClass(/error/);
  await expect(page.locator(".v3-character.typed")).toHaveCount(0);
  await input.pressSequentially("resilient");
  await expect(page.locator(".v3-practice-word-line")).toContainText("1 / 2 次");
  await expect(page.locator(".v3-character.typed")).toHaveCount(0);
  await input.pressSequentially("resilient");
  await expect(page.locator(".v3-practice-word-line")).toContainText("2 / 2 次");
  await page.getByRole("button", { name: "单词默写", exact: true }).click();
  await expect(page.locator(".v3-character").first()).toHaveText("·");
  await page.getByRole("button", { name: "显示提示", exact: false }).click();
  await expect(page.locator(".v3-character").first()).toHaveText("r");
  const data = await facts(page);
  expect(data.practice.some((a: any) => !a.correct)).toBe(true);
  expect(data.practice.some((a: any) => a.correct)).toBe(true);
  expect(data.reviews).toHaveLength(0);
});
test("真实侧栏重复采集语境、正文恢复与刷新后事实保留", async ({ extension }) => {
  const server = await readingServer(
    '<!doctype html><title>语境验收</title><article><p>A resilient learner returns.</p><p>A resilient reader pays attention.</p><button id="site-button" onclick="this.textContent=\'站点可用\'">网页原有按钮</button></article>',
  );
  try {
    const article = await extension.context.newPage();
    await article.goto(server.url);
    const panel = await extension.openPanel(article);
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    for (let i = 0; i < 2; i++) {
      await pickWord(article, "resilient", i);
    }
    await panel.getByRole("button", { name: "加入单词本" }).click();
    await expect(panel.locator(".lm-notice")).toHaveText("已将 2 条语境加入单词本");
    await article.locator("#site-button").click();
    await expect(article.locator("#site-button")).toHaveText("站点可用");
    const page = await workspace(extension);
    const data = await facts(page);
    expect(data.words).toHaveLength(1);
    expect(data.encounters).toHaveLength(2);
    await page.reload();
    const reopened = await facts(page);
    expect(reopened.words).toEqual(data.words);
    expect(reopened.encounters).toEqual(data.encounters);
    await navigate(page, "设置");
    await expect(page.getByRole("button", { name: /导出|导入|JSON|CSV/ })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    expect(
      (
        await extension.worker.evaluate(() =>
          (globalThis as any).chrome.permissions.getAll(),
        )
      ).permissions,
    ).not.toContain("downloads");
    // 新开管理页后须等原生侧栏结束；不能在页面关闭过程中进入截图清理。
    await page.bringToFront();
    await expect
      .poll(() =>
        extension.worker.evaluate(() =>
          (globalThis as any).chrome.runtime.getContexts({
            contextTypes: ["SIDE_PANEL"],
          }),
        ),
      )
      .toHaveLength(0);
  } finally {
    await server.close();
  }
});
