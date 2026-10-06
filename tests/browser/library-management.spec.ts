import { test, expect } from "./fixtures";
import { workspace, navigate, addWord, editWord, facts, setTarget } from "./ui-helpers";

test("个人笔记和多本编辑、批量追加关联与筛选清空选择，重启保留", async ({
  extension,
}) => {
  let page = await workspace(extension);
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  await expect(page.getByRole("button", { name: "跳过引导", exact: true })).toHaveCount(
    0,
  );
  await addWord(page, "resilient");
  await addWord(page, "attention");
  for (const name of ["考试词", "阅读词"]) {
    await page.getByRole("button", { name: "新建单词本", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建单词本" });
    await dialog.getByLabel("单词本名称", { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "保存单词本", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(page.locator(".v3-library-row input[type=checkbox]")).toHaveCount(0);
  await page.getByRole("button", { name: "编辑单词列表", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择单词 resilient", exact: true }).check();
  await page.getByRole("checkbox", { name: "选择单词 attention", exact: true }).check();
  const bulk = page.getByLabel("批量单词操作", { exact: true });
  await expect(bulk).toContainText("已选择 2 词");
  await bulk.getByRole("button", { name: "加入单词本", exact: true }).click();
  const books = page.getByRole("dialog", { name: "批量加入单词本" });
  await books.getByRole("checkbox", { name: "考试词", exact: true }).check();
  await books.getByRole("checkbox", { name: "阅读词", exact: true }).check();
  await books.getByRole("button", { name: "保存单词本关联", exact: true }).click();
  await expect(books).toHaveCount(0);
  const data = await facts(page);
  expect(data.words).toHaveLength(2);
  for (const word of data.words) expect(word.notebookIds).toHaveLength(3);
  expect(data.encounters).toHaveLength(0);
  await page.getByRole("button", { name: "结束批量编辑", exact: true }).click();
  await expect(page.locator(".v3-library-row input[type=checkbox]")).toHaveCount(0);
  await expect(bulk).toHaveCount(0);
  await editWord(page, "resilient");
  const edit = page.getByRole("dialog", { name: "编辑个人内容" });
  await expect(edit.getByLabel("我的释义")).toHaveCount(0);
  await expect(edit.getByLabel("标签，使用逗号分隔")).toHaveCount(0);
  await edit.getByLabel("我的笔记").fill("只维护笔记与单词本");
  await edit.getByRole("checkbox", { name: "阅读词", exact: true }).uncheck();
  await edit.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await page.getByRole("button", { name: "编辑单词列表", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择当前页全部单词", exact: true }).check();
  await expect(bulk).toContainText("已选择 2 词");
  await page.getByRole("combobox", { name: "按主词性筛选" }).selectOption("adjective");
  await expect(bulk).toHaveCount(0);
  await expect(page.locator(".v3-library-row > button")).toHaveCount(1);
  await expect(page.locator(".v3-library-row > button")).toContainText("resilient");
  await page.getByRole("combobox", { name: "按主词性筛选" }).selectOption("all");
  await extension.restart();
  page = await workspace(extension);
  await navigate(page, "我的词库");
  await expect(page.locator(".v3-library-row input[type=checkbox]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "编辑单词列表", exact: true }),
  ).toBeVisible();
  const reopened = await facts(page);
  expect(reopened.words.find((w: any) => w.normalized === "resilient").note).toBe(
    "只维护笔记与单词本",
  );
  expect(
    reopened.words.find((w: any) => w.normalized === "resilient").notebookIds,
  ).toHaveLength(2);
});

test("公共目标词回收需要确认，重开不重生，恢复同一词条与队列", async ({ extension }) => {
  let page = await workspace(extension);
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  await expect(page.getByRole("button", { name: "跳过引导", exact: true })).toHaveCount(
    0,
  );
  await setTarget(page, 3);
  await navigate(page, "我的词库");
  const first = page.locator(".v3-library-row").first();
  const word = (await first.locator("strong").textContent())!.trim();
  await first.locator("button").click();
  expect((await facts(page)).words).toHaveLength(0);
  await page.getByRole("button", { name: "移到回收站", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "移到回收站？" });
  await expect(dialog).toContainText(word);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect((await facts(page)).words).toHaveLength(0);
  await expect(first).toBeVisible();
  await page.getByRole("button", { name: "移到回收站", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "移到回收站？" });
  await dialog.getByRole("button", { name: "确认移到回收站", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await facts(page);
  expect(saved.words).toHaveLength(1);
  expect(saved.words[0].deletedAt).not.toBeNull();
  const id = saved.words[0].id;
  await page.getByRole("searchbox", { name: "搜索我的词库" }).fill(word);
  await expect(
    page
      .locator(".v3-library-row strong")
      .filter({ hasText: new RegExp("^" + word + "$") }),
  ).toHaveCount(0);
  await extension.restart();
  page = await workspace(extension);
  await navigate(page, "我的词库");
  await page.getByRole("searchbox", { name: "搜索我的词库" }).fill(word);
  await expect(
    page
      .locator(".v3-library-row strong")
      .filter({ hasText: new RegExp("^" + word + "$") }),
  ).toHaveCount(0);
  await navigate(page, "回收站");
  await page.getByRole("button", { name: "恢复词条", exact: true }).click();
  await navigate(page, "我的词库");
  await page.getByRole("searchbox", { name: "搜索我的词库" }).fill(word);
  await expect(
    page
      .locator(".v3-library-row strong")
      .filter({ hasText: new RegExp("^" + word + "$") }),
  ).toHaveCount(1);
  const restored = await facts(page);
  expect(restored.words).toHaveLength(1);
  expect(restored.words[0].id).toBe(id);
  expect(restored.words[0].deletedAt).toBeNull();
});

test("当前页全选与跨页批量回收，切换筛选清选择，明暗窄窗保持无横向溢出", async ({
  extension,
}, info) => {
  const page = await workspace(extension);
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  await expect(page.getByRole("button", { name: "跳过引导", exact: true })).toHaveCount(
    0,
  );
  await setTarget(page, 3);
  await navigate(page, "我的词库");
  await page.getByRole("button", { name: "编辑单词列表", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择当前页全部单词", exact: true }).check();
  await expect(page.getByLabel("批量单词操作", { exact: true })).toContainText(
    "已选择 50 词",
  );
  await page
    .locator(".v3-library-table .v3-pagination")
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  await page.locator(".v3-library-row input[type=checkbox]").first().check();
  await expect(page.getByLabel("批量单词操作", { exact: true })).toContainText(
    "已选择 51 词",
  );
  await page.getByRole("button", { name: "批量移到回收站", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "移到回收站？" });
  await expect(dialog).toContainText("51 个单词");
  await dialog.getByRole("button", { name: "确认移到回收站", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await facts(page)).words.filter((w: any) => w.deletedAt)).toHaveLength(51);
  await page.setViewportSize({ width: 390, height: 790 });
  for (const theme of ["light", "dark"]) {
    await navigate(page, "设置");
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await navigate(page, "我的词库");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBe(false);
    await expect(page.getByRole("combobox", { name: "按主词性筛选" })).toBeVisible();
    await expect(page.locator(".v3-library-row input[type=checkbox]")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`library-default-narrow-${theme}.png`),
    });
    await page.getByRole("button", { name: "编辑单词列表", exact: true }).click();
    await expect(
      page.locator(".v3-library-row input[type=checkbox]").first(),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath(`library-bulk-narrow-${theme}.png`) });
    await page.getByRole("button", { name: "结束批量编辑", exact: true }).click();
  }
});
