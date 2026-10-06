import { mutePractice } from "./ui-helpers";
import { test, expect, chromium } from "./fixtures";
import { launchExtension, readingServer } from "../helpers/extension.cjs";
import {
  pickWord,
  workspace,
  navigate,
  addWord,
  editWord,
  setTarget,
  practiceSettings,
  facts,
  familiarCurrent,
} from "./ui-helpers";

test("整个浏览器重开保留词本、回收与全部学习事实，另一份 profile 保持隔离", async ({
  extension,
}, info) => {
  const server = await readingServer(
    '<!doctype html><meta charset="utf-8"><title>持久化验收</title><article><p>A resilient learner returns.</p></article>',
  );
  let destination: Awaited<ReturnType<typeof launchExtension>> | undefined;
  try {
    const article = await extension.context.newPage();
    await article.goto(server.url);
    const panel = await extension.openPanel(article);
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    await pickWord(article, "resilient");
    await panel.getByRole("button", { name: "加入单词本" }).click();
    await expect(panel.locator(".lm-notice")).toHaveText("已将 1 条语境加入单词本");
    let page = await workspace(extension);
    await expect(page.locator("main")).toHaveAttribute(
      "data-account-state",
      "unavailable",
    );
    await expect(page.locator("main")).toHaveAttribute(
      "data-desktop-state",
      "unavailable",
    );
    await addWord(page, "attention");
    await page.getByRole("button", { name: "新建单词本", exact: true }).click();
    await page.getByLabel("单词本名称", { exact: true }).fill("迁移验收");
    await page.getByRole("button", { name: "保存单词本", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await editWord(page, "resilient");
    await page.getByRole("checkbox", { name: "迁移验收", exact: true }).check();
    await page.getByLabel("我的笔记").fill("来自隔离阅读页，保留事实 ID");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // 唯一计划来自主题词书；个人本只组织资料和练习范围。
    await setTarget(page, 12);
    await navigate(page, "今日学习");
    await page.locator(".v3-daily-group").first().getByRole("button").first().click();
    await mutePractice(page);
    await familiarCurrent(page, 11);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await mutePractice(page);
    await navigate(page, "练习中心");
    const notebookScope = await page
      .getByRole("combobox", { name: "练习范围" })
      .locator("option")
      .filter({ hasText: "迁移验收" })
      .getAttribute("value");
    await page.getByRole("combobox", { name: "练习范围" }).selectOption(notebookScope!);
    await page.getByRole("button", { name: "不保存并切换", exact: true }).click();
    await page.getByRole("button", { name: "单词临摹", exact: true }).click();
    await practiceSettings(page, 1, false);
    await page.getByRole("textbox", { name: "逐字拼写" }).pressSequentially("resilient");
    await expect(page.locator(".v3-practice-word-line")).toContainText("1 / 1 次");
    await page.getByRole("button", { name: "保存进度", exact: true }).click();
    await editWord(page, "attention");
    await page.getByRole("button", { name: "关闭对话框" }).click();
    await page.getByRole("button", { name: "移到回收站", exact: true }).click();
    await page.getByRole("button", { name: "确认移到回收站", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已将 1 个单词移到回收站");
    const original = await facts(page);
    expect(original.words).toHaveLength(2);
    expect(original.words.filter((word: any) => word.deletedAt)).toHaveLength(1);
    expect(
      original.words.find((word: any) => word.normalized === "resilient")?.notebookIds,
    ).toHaveLength(2);
    expect(original.notebooks).toHaveLength(2);
    expect(original.encounters).toHaveLength(1);
    expect(original.reviews).toHaveLength(1);
    expect(original.practice).toHaveLength(2);
    expect(
      original.practice.every(
        (p: any) => p.learning.ruleVersion === "leximeet.learning/2",
      ),
    ).toBe(true);
    expect(original.plan?.sourceKind).toBe("catalog");
    expect(Object.keys(original.checkpoints || {})).toHaveLength(1);
    await extension.restart();
    page = await workspace(extension);
    const reopened = await facts(page);
    expect(reopened).toEqual(original);
    // 完全独立的第二 profile 必须是新资料，不偷偷迁移用户数据。
    destination = await launchExtension({
      chromium,
      expect,
      testInfo: info,
      manageTrace: false,
    });
    expect(destination.profile).not.toBe(extension.profile);
    const fresh = await facts(await workspace(destination));
    expect(fresh.book.bookUid).not.toBe(original.book.bookUid);
    expect(fresh.book.deviceId).not.toBe(original.book.deviceId);
    expect(fresh.words).toEqual([]);
    expect(fresh.encounters).toEqual([]);
    expect(fresh.reviews).toEqual([]);
    expect(fresh.practice).toEqual([]);
    expect(fresh.plan).toBeUndefined();
    await info.attach("restart-and-isolated-facts", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          actualBrowserRestart: true,
          stableFactIds: true,
          independentOwnedProfiles: true,
          words: 2,
          notebooks: 2,
          encounters: 1,
          reviews: 1,
          practice: 2,
          noPersonalFileTransfer: true,
        }),
      ),
    });
  } finally {
    await destination?.close();
    await server.close();
  }
});
