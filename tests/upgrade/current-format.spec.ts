import path from "node:path";
import { PERSONAL_FORMAT } from "../../lib/local-model";
import { test, expect, chromium } from "@playwright/test";
import { launchExtension } from "../helpers/extension.cjs";
import {
  workspace,
  addWord,
  editWord,
  navigate,
  mutePractice,
  facts,
  setTarget,
} from "../browser/ui-helpers";

test("真实当前格式候选替换：完整退出并替换原包，词本/笔记/练习/规划和ID完整保留", async ({
  headless,
}, info) => {
  const beforeBuild = process.env.LEXIMEET_UPGRADE_FROM;
  if (!beforeBuild)
    throw new Error(
      "请用 LEXIMEET_UPGRADE_FROM 指定已验证的当前格式旧候选目录，测试不会修改正式 manifest",
    );
  const extension = await launchExtension({
    chromium,
    expect,
    testInfo: info,
    headless,
    buildDir: beforeBuild,
    manageTrace: false,
  });
  try {
    let manager = await workspace(extension);
    const previousFormat = await manager.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open("leximeet-personal-v1");
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      try {
        const value = await new Promise<any>((resolve, reject) => {
          const get = db.transaction("meta").objectStore("meta").get("book");
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        });
        return value?.format;
      } finally {
        db.close();
      }
    });
    expect(previousFormat, "前包须为当前格式候选，预发布旧库不迁移").toBe(
      PERSONAL_FORMAT,
    );
    await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
    await addWord(manager, "state");
    await editWord(manager, "state");
    const edit = manager.getByRole("dialog", { name: "编辑个人内容" });
    await edit.getByLabel("我的笔记").fill("候选替换前的笔记保持原样");
    await edit.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await setTarget(manager, 10);
    await mutePractice(manager);
    await navigate(manager, "练习中心");
    const personal = (await facts(manager)).words.find((w: any) => w.word === "state");
    expect(personal?.notebookIds?.length).toBeGreaterThan(0);
    await manager
      .getByLabel("练习范围", { exact: true })
      .selectOption("notebook:" + personal.notebookIds[0]);
    await manager.getByRole("button", { name: "单词临摹", exact: true }).click();
    await manager
      .getByRole("textbox", { name: "逐字拼写", exact: true })
      .pressSequentially("state");
    await expect.poll(async () => (await facts(manager)).practice.length).toBe(1);
    await manager.getByRole("button", { name: "保存进度", exact: true }).click();
    await expect
      .poll(async () => Object.keys((await facts(manager)).checkpoints).length)
      .toBe(1);
    // 同一旧正式包设置实图：记录实际布局，不从版本号或历史截图推导功能缺失。
    await navigate(manager, "设置");
    const priorTheme = await manager.getByLabel("主题", { exact: true }).inputValue();
    await manager
      .getByRole("heading", { name: "网页阅读", exact: true })
      .scrollIntoViewIfNeeded();
    await manager.screenshot({
      path: info.outputPath("policy-before-light.png"),
    });
    await manager.getByLabel("主题", { exact: true }).selectOption("dark");
    await manager
      .getByRole("heading", { name: "网页阅读", exact: true })
      .scrollIntoViewIfNeeded();
    await manager.screenshot({
      path: info.outputPath("policy-before-dark.png"),
    });
    await manager.getByLabel("主题", { exact: true }).selectOption(priorTheme);
    await expect.poll(async () => (await facts(manager)).settings.theme).toBe(priorTheme);
    const before = await facts(manager);
    await extension.restart({
      upgradeBuildDir: path.resolve(".output/chrome-mv3"),
    });
    manager = await workspace(extension);
    const after = await facts(manager);
    expect(after).toEqual(before);
    await navigate(manager, "设置");
    await expect(manager.getByLabel("相同语境去重天数")).toHaveValue("7");
    await expect(manager.getByLabel("敏感内容替换为 xxx")).toBeChecked();
    await navigate(manager, "我的词库");
    await manager.getByRole("searchbox", { name: "搜索我的词库" }).fill("state");
    await manager
      .locator(".v3-table-body")
      .getByRole("button", { name: /^state\s/ })
      .click();
    await expect(manager.getByRole("article", { name: "单词词卡" })).toContainText(
      "候选替换前的笔记保持原样",
    );
    await info.attach("current-format-personal-data", {
      body: Buffer.from(
        JSON.stringify({
          before,
          after,
          currentFormat: true,
          sameOwnedProfile: true,
          identityPreserved: true,
        }),
      ),
      contentType: "application/json",
    });
  } finally {
    await extension.close();
  }
});
