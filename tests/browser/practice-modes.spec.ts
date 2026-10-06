import { test, expect } from "./fixtures";
import { readingServer } from "../helpers/extension.cjs";
import { audioFixture } from "../helpers/audio-fixture";
import {
  workspace,
  navigate,
  addWord,
  mutePractice,
  practiceSettings,
  facts,
  setTarget,
  pickWord,
  frozenChoice,
} from "./ui-helpers";
import type { Page } from "@playwright/test";

async function quietGuide(page: Page) {
  const skip = page.getByRole("button", { name: "跳过引导", exact: true });
  if (await skip.count()) await skip.click();
}
async function localAudio(page: Page) {
  const requests: string[] = [];
  await page.route("https://dict.youdao.com/dictvoice?*", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: audioFixture(),
    });
  });
  return requests;
}

test("已保存答案可点击空白继续，上一个只重看，末题和列表完成条达到100%", async ({
  extension,
}, info) => {
  const page: Page = await workspace(extension);
  await quietGuide(page);
  await mutePractice(page);
  await localAudio(page);
  await addWord(page, "system");
  await addWord(page, "resilient");
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await practiceSettings(page, 1, false);
  const progress = page.getByRole("progressbar", { name: "练习进度" });
  const clickBlank = async () => {
    const area = await page.locator(".v3-practice").boundingBox();
    expect(area).not.toBeNull();
    await page.locator(".v3-practice").click({ position: { x: 5, y: area!.height - 8 } });
  };
  await clickBlank();
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 2 词");
  await expect(progress).toHaveAttribute("value", "0");
  const chooseWrong = async () => {
    await expect(page.locator(".v3-meaning-choices > button").first()).toBeEnabled();
    const question = await frozenChoice(page),
      wrong = question.options.find(
        (option: any) => option.id !== question.correctChoiceId,
      );
    await page
      .locator(".v3-meaning-choices > button")
      .filter({ hasText: wrong.text })
      .click();
    await expect(page.getByRole("button", { name: "下一个", exact: true })).toBeEnabled();
  };
  await chooseWrong();
  await expect(progress).toHaveAttribute("value", "1");
  await page.getByRole("button", { name: "查看词卡", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "练习词卡" });
  await dialog.click({ position: { x: 20, y: 40 } });
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 2 词");
  await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await clickBlank();
  await expect(page.locator(".v3-progress-line")).toContainText("第 2 / 2 词");
  const firstFacts = (await facts(page)).practice;
  await page.getByRole("button", { name: "上一个", exact: true }).click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 2 词");
  await expect(page.locator(".v3-meaning-choices > button").first()).toBeDisabled();
  expect((await facts(page)).practice).toEqual(firstFacts);
  await clickBlank();
  await expect(page.locator(".v3-progress-line")).toContainText("第 2 / 2 词");
  await chooseWrong();
  await expect(progress).toHaveAttribute("value", "2");
  await expect(progress).toHaveAttribute("max", "2");
  await clickBlank();
  await expect(page.getByRole("heading", { name: /和 2 个词重新见面/ })).toBeVisible();
  await expect(progress).toHaveAttribute("value", "2");
  await page.getByRole("button", { name: "上一个", exact: true }).click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 2 / 2 词");
  expect((await facts(page)).practice).toHaveLength(2);
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 2 词");
  await expect(progress).toHaveAttribute("value", "0");
  await page.getByRole("button", { name: "单词列表", exact: true }).click();
  const rows = page.locator(".v3-practice-list-row");
  await rows.first().getByRole("button", { name: "熟悉 +1", exact: true }).click();
  await expect(rows.first().locator(".v3-list-feedback")).toBeVisible();
  await rows.last().getByRole("button", { name: "不熟悉 −1", exact: true }).click();
  await expect(progress).toHaveAttribute("value", "2");
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(progress).toHaveAttribute("value", "0");
  await page.getByRole("button", { name: "单词列表", exact: true }).click();
  await expect(progress).toHaveAttribute("value", "2");
  await expect(page.locator(".v3-list-feedback")).toHaveCount(2);
  expect((await facts(page)).practice).toHaveLength(4);
  await page.screenshot({ path: info.outputPath("practice-completed-100.png") });
});

test("六方式独立位置和进度，听音与临摹不同词草稿保存并整浏览器重开恢复", async ({
  extension,
}, info) => {
  let page: Page = await workspace(extension);
  await quietGuide(page);
  await localAudio(page);
  await mutePractice(page);
  for (const word of ["resilient", "system", "attention"]) await addWord(page, word);
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await practiceSettings(page, 1, false);
  for (let i = 0; i < 2; i++) {
    await expect(page.locator(".v3-meaning-choices > button").first()).toBeEnabled();
    const question = await frozenChoice(page);
    const wrong = question.options.find(
      (option: any) => option.id !== question.correctChoiceId,
    );
    await page
      .locator(".v3-meaning-choices > button")
      .filter({ hasText: wrong.text })
      .click();
    await page.getByRole("button", { name: "下一个", exact: true }).click();
  }
  await expect(page.locator(".v3-practice-headword")).toHaveText("resilient");
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 3 词");
  const typing = page.getByRole("textbox", { name: "逐字拼写" });
  for (const [index, word] of ["attention", "system"].entries()) {
    // 点击下一题只派发操作；等正式题准备完成再打字，不能把按键发给仍在切换的旧题。
    await expect(page.locator(".v3-progress-line")).toContainText(
      `第 ${index + 1} / 3 词`,
    );
    await expect(page.locator(".v3-practice-stage")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await typing.pressSequentially(word);
    await page.getByRole("button", { name: "下一个", exact: true }).click();
  }
  await expect(page.locator(".v3-progress-line")).toContainText("第 3 / 3 词");
  await expect(page.locator(".v3-practice-stage")).toHaveAttribute("aria-busy", "false");
  await typing.pressSequentially("re");
  await expect(page.getByRole("progressbar", { name: "练习进度" })).toHaveAttribute(
    "value",
    "2",
  );
  await page.getByRole("button", { name: "单词默写", exact: true }).click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 3 词");
  await expect(page.locator(".v3-character.typed")).toHaveCount(0);
  await page.getByRole("button", { name: "听音辨词", exact: true }).click();
  const input = page.getByRole("textbox", { name: "练习答案", exact: true });
  await input.fill("attention");
  await input.press("Enter");
  await page.getByRole("button", { name: "下一个", exact: true }).click();
  await input.fill("sys");
  await expect(page.locator(".v3-progress-line")).toContainText("第 2 / 3 词");
  await expect(page.getByRole("progressbar", { name: "练习进度" })).toHaveAttribute(
    "value",
    "1",
  );
  await page.getByRole("button", { name: "语境填空", exact: true }).click();
  await expect(page.locator(".v3-cloze-question")).toContainText("_____");
  await input.fill("att");
  await page.getByRole("button", { name: "单词列表", exact: true }).click();
  const row = page.locator('.v3-practice-list-row[data-key="resilient"]');
  await expect(page.locator(".v3-practice-list-row.selected")).toHaveAttribute(
    "data-key",
    "attention",
  );
  await row.getByRole("button", { name: "揭示中文", exact: true }).click();
  await expect(row).not.toContainText("点击查看");
  for (const [label, index, completed] of [
    ["单词列表", 1, 0],
    ["看词选义", 3, 2],
    ["单词临摹", 3, 2],
    ["单词默写", 1, 0],
    ["听音辨词", 2, 1],
    ["语境填空", 1, 0],
  ] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".v3-progress-line")).toContainText(`第 ${index} / 3 词`);
    await expect(page.getByRole("progressbar", { name: "练习进度" })).toHaveAttribute(
      "value",
      String(completed),
    );
    if (label === "单词临摹")
      await expect(page.locator(".v3-character.typed")).toHaveCount(2);
    if (label === "听音辨词") await expect(input).toHaveValue("sys");
    if (label === "语境填空") await expect(input).toHaveValue("att");
  }
  await page.getByRole("button", { name: "保存进度", exact: true }).click();
  const before = await facts(page);
  const saved = before.checkpoints.library;
  expect(saved.mode).toBe("cloze");
  expect(saved.indices.copy).toBe(2);
  expect(saved.indices.listening).toBe(1);
  expect(saved.indices["word-list"]).toBe(0);
  expect(saved.turns.cloze.input).toBe("att");
  expect(saved.wordTurns.system.listening.input).toBe("sys");
  expect(saved.wordTurns.resilient.copy.position).toBe(2);
  expect(saved.listRecall.resilient.revealed).toBe(true);
  await extension.restart();
  page = await workspace(extension);
  await localAudio(page);
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await expect(page.getByRole("textbox", { name: "练习答案", exact: true })).toHaveValue(
    "att",
  );
  await page.getByRole("button", { name: "听音辨词", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "练习答案", exact: true })).toHaveValue(
    "sys",
  );
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 3 / 3 词");
  await expect(page.locator(".v3-character.typed")).toHaveCount(2);
  const data = await facts(page);
  expect(data.practice).toEqual(before.practice);
  expect(data.practice).toHaveLength(6);
  expect(data.plan).toBeUndefined();
  await page.screenshot({ path: info.outputPath("six-modes-independent-restored.png") });
});

test("听音真媒体播放和失败重试；完整输入确认、重复次数、填空订正与无例句降级", async ({
  extension,
}, info) => {
  const page: Page = await workspace(extension);
  await quietGuide(page);
  await mutePractice(page);
  await addWord(page, "resilient");
  let requests = 0;
  await page.route("https://dict.youdao.com/dictvoice?*", async (route) => {
    requests++;
    if (requests === 1) return route.abort("failed");
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: audioFixture(),
    });
  });
  // 只读捕获正式 HTMLMediaElement 的事件，不替换播放器或浏览器 API。
  await page.evaluate(() => {
    (globalThis as any).__listeningPlays = 0;
    document.addEventListener(
      "playing",
      (e) => {
        if (e.target instanceof HTMLAudioElement) (globalThis as any).__listeningPlays++;
      },
      true,
    );
  });
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await practiceSettings(page, 2, false);
  const unchangedWords = (await facts(page)).words;
  await page.getByRole("button", { name: "听音辨词", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "发音加载失败" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "再听一次", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__listeningPlays))
    .toBe(1);
  const input = page.getByRole("textbox", { name: "练习答案", exact: true });
  await input.fill("wrong");
  await input.press("Enter");
  await expect(page.locator(".v3-practice-feedback")).toHaveText("再回想一下");
  await input.press("Enter");
  await expect.poll(async () => (await facts(page)).practice.length).toBe(1);
  await input.fill("RESILIENT");
  await input.press("Enter");
  await expect(page.locator(".v3-practice-word-line")).toContainText("1 / 2 次");
  await expect(input).toHaveValue("");
  await input.fill("resilient");
  await input.press("Enter");
  await expect(page.locator(".v3-practice-word-line")).toContainText("2 / 2 次");
  await page.getByRole("button", { name: "语境填空", exact: true }).click();
  await expect(page.locator(".v3-cloze-question")).toContainText("_____");
  await expect(page.locator(".v3-cloze-question")).not.toContainText(/resilient/i);
  await input.fill("wrong");
  await input.press("Enter");
  await expect(input).toHaveValue("wrong");
  await expect(page.locator(".v3-practice-feedback")).toHaveText("再回想一下");
  // 等真实提交事务完成后再操作；提示按钮与输入共用 active 状态，不能丢掉忙碌期间的点击。
  await expect(input).toBeEnabled();
  await page.getByRole("button", { name: "显示提示", exact: false }).click();
  await expect(page.locator(".v3-written-hint")).toHaveText("resilient");
  await page.screenshot({ path: info.outputPath("cloze-hint-after-saving.png") });
  await input.fill("resilient");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await input.fill("resilient");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "下一个", exact: true })).toBeEnabled();
  await expect.poll(async () => (await facts(page)).practice.length).toBe(7);
  const data = await facts(page);
  expect(data.reviews).toHaveLength(2);
  expect(
    data.reviews.every(
      (r: any) => r.rating === "again" && r.algorithmVersion === "fsrs-6/java-fsrs-1.0.0",
    ),
  ).toBe(true);
  expect(data.practice.filter((p: any) => p.learning.signal === "reveal")).toHaveLength(
    1,
  );
  expect(data.words).toEqual(unchangedWords);
  expect(data.practice.filter((a: any) => a.mode === "listening")).toHaveLength(3);
  expect(data.practice.filter((a: any) => a.mode === "cloze")).toHaveLength(4);
  await page.getByRole("button", { name: "下一个", exact: true }).click();
  await expect(page.getByRole("heading", { name: /和 1 个词重新见面/ })).toBeVisible();
  await addWord(page, "my-unlisted-word");
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("target");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "不保存并切换", exact: true })
    .click();
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await page.getByRole("button", { name: "语境填空", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "暂无包含目标词的例句" }),
  ).toBeVisible();
  await expect(input).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下一个", exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("cloze-no-example.png") });
});

test("单词列表遮挡、反馈和分页独立范围位置，切范围才确认并保留已保存反馈", async ({
  extension,
}, info) => {
  const page: Page = await workspace(extension);
  await quietGuide(page);
  await mutePractice(page);
  await setTarget(page, 14);
  await navigate(page, "练习中心");
  await page.getByRole("button", { name: "单词列表", exact: true }).click();
  await expect(page.locator(".v3-practice-list-row")).toHaveCount(12);
  await expect(page.getByRole("button", { name: "揭示中文", exact: true })).toHaveCount(
    12,
  );
  await page.getByRole("button", { name: "遮挡英文", exact: true }).click();
  await expect(page.getByRole("button", { name: "揭示英文", exact: true })).toHaveCount(
    12,
  );
  await page.getByRole("button", { name: "揭示英文", exact: true }).first().click();
  await page
    .locator(".v3-practice-list-row")
    .first()
    .getByRole("button", { name: "不熟悉 −1", exact: true })
    .click();
  await expect(page.locator(".v3-list-feedback")).toHaveText("不熟悉 · 已记录");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 13 / 14 词");
  await expect(page.locator(".v3-practice-list-row")).toHaveCount(2);
  await page
    .locator(".v3-practice-list-row")
    .last()
    .getByRole("button", { name: "熟悉 +1", exact: true })
    .click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 14 / 14 词");
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 14 词");
  await page.getByRole("button", { name: "单词列表", exact: true }).click();
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("target");
  const dialog = page.getByRole("dialog", { name: "保存当前练习进度？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "保存并切换", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("today");
  await expect(page.locator(".v3-progress-line")).toContainText("第 14 / 14 词");
  await expect(page.locator(".v3-list-feedback")).toHaveText("熟悉 · 已记录");
  await page.reload();
  await expect(page.locator(".v3-progress-line")).toContainText("第 14 / 14 词");
  await expect(page.locator(".v3-list-feedback")).toHaveText("熟悉 · 已记录");
  const data = await facts(page);
  expect(data.practice).toHaveLength(3);
  expect(data.reviews).toHaveLength(1);
  expect(data.practice.every((a: any) => a.mode === "word-list")).toBe(true);
  await page.screenshot({
    path: info.outputPath("list-restored-page-two.png"),
  });
  await page.getByRole("button", { name: "重新开始", exact: true }).click();
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 14 词");
  await expect(page.locator(".v3-list-feedback")).toHaveCount(0);
  await page
    .locator(".v3-practice-list-row")
    .first()
    .getByRole("button", { name: "熟悉 +1", exact: true })
    .click();
  await expect.poll(async () => (await facts(page)).practice.length).toBe(4);
  expect((await facts(page)).reviews).toHaveLength(2);
});

test("真实采集后的遇见字号层级、词卡入口，六模式在明暗宽窄窗口保持可操作", async ({
  extension,
}, info) => {
  const page: Page = await workspace(extension);
  await quietGuide(page);
  await mutePractice(page);
  const server = await readingServer(
    "<!doctype html><title>Learning context</title><p>A resilient reader returns.</p>",
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await pickWord(reading, "resilient");
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "加入单词本", exact: true }),
    ).toHaveCount(0);
    await page.bringToFront();
    await localAudio(page);
    for (const theme of ["light", "dark"]) {
      await navigate(page, "设置");
      await page.getByRole("combobox", { name: "主题", exact: true }).selectOption(theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await navigate(page, "遇见记录");
        const sizes = await page.locator(".v3-context").evaluate((el) => ({
          word: parseFloat(getComputedStyle(el.querySelector("strong")!).fontSize),
          context: parseFloat(getComputedStyle(el.querySelector("blockquote")!).fontSize),
        }));
        expect(sizes.word).toBeGreaterThanOrEqual(24);
        expect(sizes.context).toBeLessThanOrEqual(16);
        expect(sizes.word).toBeGreaterThan(sizes.context * 1.5);
        await page.locator(".v3-context header button").click();
        await expect(page.getByRole("dialog", { name: "遇见词卡" })).toBeVisible();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "关闭对话框" })
          .click();
        await page.screenshot({
          path: info.outputPath(`encounters-${theme}-${width}.png`),
        });
        await navigate(page, "练习中心");
        await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
        for (const mode of [
          "单词列表",
          "看词选义",
          "单词临摹",
          "单词默写",
          "听音辨词",
          "语境填空",
        ]) {
          const button = page.getByRole("button", { name: mode, exact: true });
          await button.click();
          await expect(button).toHaveAttribute("aria-pressed", "true");
          await expect(page.locator(".v3-practice-toolbar")).toBeInViewport({
            ratio: 1,
          });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          if (["单词列表", "语境填空", "听音辨词"].includes(mode))
            await page.screenshot({
              path: info.outputPath(`practice-${mode}-${theme}-${width}.png`),
            });
        }
      }
    }
  } finally {
    await server.close();
  }
});

test("临摹和默写等待完整发音再换词，发音失败仍能自动继续", async ({
  extension,
}, info) => {
  const page: Page = await workspace(extension);
  await quietGuide(page);
  await page.route("https://dict.youdao.com/dictvoice?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: audioFixture(1500),
    }),
  );
  // 1.5 秒真实媒体比一秒最低反馈长；实际 ended 必须先于自动换词，不能被切题截断。
  await page.evaluate(() => {
    (globalThis as any).__completionAudio = { playing: 0, ended: 0, lastEnded: 0 };
    for (const name of ["playing", "ended"])
      document.addEventListener(
        name,
        (event) => {
          if (event.target instanceof HTMLAudioElement) {
            (globalThis as any).__completionAudio[name]++;
            if (name === "ended")
              (globalThis as any).__completionAudio.lastEnded = performance.now();
          }
        },
        true,
      );
  });
  await addWord(page, "system");
  await addWord(page, "resilient");
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await expect(page.locator(".v3-practice-headword")).toHaveText("resilient");
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await practiceSettings(page, 1, true);
  await page.getByRole("textbox", { name: "逐字拼写" }).pressSequentially("resilient");
  await expect(page.locator(".v3-progress-line")).toContainText("第 2 / 2 词");
  expect(
    await page.evaluate(() => ({
      ended: (globalThis as any).__completionAudio.ended,
      completedBeforeTransition:
        (globalThis as any).__completionAudio.lastEnded > 0 &&
        (globalThis as any).__completionAudio.lastEnded <= performance.now(),
    })),
  ).toEqual({ ended: 1, completedBeforeTransition: true });
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__completionAudio.ended))
    .toBe(1);
  await page.getByRole("button", { name: "单词默写", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "逐字拼写" })).toBeEnabled();
  await page.getByRole("textbox", { name: "逐字拼写" }).pressSequentially("resilient");
  await expect(page.locator(".v3-progress-line")).toContainText("第 2 / 2 词");
  await expect(page.getByRole("textbox", { name: "逐字拼写" })).toBeEnabled();
  await page.getByRole("textbox", { name: "逐字拼写" }).pressSequentially("system");
  await expect(page.getByRole("heading", { name: /和 2 个词重新见面/ })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__completionAudio.ended))
    .toBe(3);
  const audio = await page.evaluate(() => (globalThis as any).__completionAudio);
  expect(audio.playing).toBe(3);
  const data = await facts(page);
  expect(data.practice).toHaveLength(3);
  expect(data.practice.map((a: any) => a.mode).sort()).toEqual([
    "copy",
    "recall",
    "recall",
  ]);
  expect(data.reviews).toHaveLength(2);
  expect(
    data.reviews.every((review: any) =>
      data.practice.some(
        (attempt: any) =>
          attempt.mode === "recall" && attempt.id === review.sourceSubmissionId,
      ),
    ),
  ).toBe(true);
  // 真正媒体失败也不能卡住：保持练习结果有效，结束声音等待并按一秒最低反馈继续。
  await page.route("https://dict.youdao.com/dictvoice?*", (route) =>
    route.fulfill({ status: 503, body: "offline test audio unavailable" }),
  );
  await page.getByRole("button", { name: "重新开始", exact: true }).click();
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "逐字拼写" })).toBeEnabled();
  await page.getByRole("textbox", { name: "逐字拼写" }).pressSequentially("resilient");
  await expect(
    page.getByText("发音加载失败，请检查网络后重试", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".v3-progress-line")).toContainText("第 2 / 2 词");
  const afterFailure = await facts(page);
  expect(afterFailure.practice).toHaveLength(4);
  expect(afterFailure.practice.at(-1).correct).toBe(true);
  await info.attach("practice-completion-audio", {
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({
        ...audio,
        failureContinued: true,
        response: "offline 1.5s WAV fixture",
        voiceQualityVerified: false,
      }),
    ),
  });
});

test("六方式共用顶部重新开始；逐词分数不串行，切词保留草稿且重开不清分", async ({
  extension,
}, info) => {
  const page: Page = await workspace(extension);
  await quietGuide(page);
  await mutePractice(page);
  await localAudio(page);
  await addWord(page, "system");
  await addWord(page, "resilient");
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await practiceSettings(page, 1, false);
  await page.getByRole("button", { name: "单词列表", exact: true }).click();
  const rows = page.locator(".v3-practice-list-row");
  const first = rows.first(),
    other = rows.last();
  const firstKey = (await first.getAttribute("data-key"))!;
  const otherKey = (await other.getAttribute("data-key"))!;
  const score = page.locator(".v3-learning-score");
  await other.getByRole("button", { name: "揭示中文", exact: true }).click();
  await expect(other.getByLabel(`${otherKey} 熟悉度`, { exact: true })).toHaveText(
    "9 / 30 分",
  );
  await expect(score).toContainText(`${firstKey} · 10 / 30 分`);
  await first.getByRole("button", { name: "熟悉 +1", exact: true }).click();
  await expect(score).toContainText("11 / 30 分");
  const restart = page.getByRole("button", { name: "重新开始", exact: true });
  await expect(restart).toHaveCount(1);
  await expect(page.getByRole("button", { name: "再练一轮", exact: true })).toHaveCount(
    0,
  );
  const before = (await facts(page)).practice;
  await restart.click();
  await expect(first.getByRole("button", { name: "熟悉 +1", exact: true })).toBeEnabled();
  expect((await facts(page)).practice).toEqual(before);
  await first.getByRole("button", { name: "熟悉 +1", exact: true }).click();
  await expect(score).toContainText("12 / 30 分");
  const scored = (await facts(page)).practice;
  const firstAttempts = scored
    .filter((a: any) => a.learning.signal === "familiar")
    .map((a: any) => a.learning.attemptId);
  expect(new Set(firstAttempts).size).toBe(2);

  // 列表选择另一个词不改临摹的位置或草稿；独立游标仍能经过真实模式切换恢复。
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await page
    .getByRole("textbox", { name: "逐字拼写" })
    .pressSequentially(firstKey.slice(0, 2));
  await page.getByRole("button", { name: "单词列表", exact: true }).click();
  await other.getByRole("button", { name: `练习词 ${otherKey}`, exact: true }).click();
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(page.locator(".v3-character.typed")).toHaveCount(2);
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 2 词");
  await page.getByRole("button", { name: "单词列表", exact: true }).click();
  await first.getByRole("button", { name: `练习词 ${firstKey}`, exact: true }).click();
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await expect(page.locator(".v3-character.typed")).toHaveCount(2);
  await page.getByRole("button", { name: "保存进度", exact: true }).click();
  let previousId = (await facts(page)).checkpoints.library.id;
  for (const [label, mode] of [
    ["单词列表", "word-list"],
    ["看词选义", "meaning-choice"],
    ["单词临摹", "copy"],
    ["单词默写", "recall"],
    ["听音辨词", "listening"],
    ["语境填空", "cloze"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(restart).toBeEnabled();
    await restart.click();
    await expect
      .poll(async () => (await facts(page)).checkpoints.library.id)
      .not.toBe(previousId);
    await expect(restart).toBeEnabled();
    await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 2 词");
    const saved = (await facts(page)).checkpoints.library;
    expect(saved.id).not.toBe(previousId);
    expect(saved.mode).toBe(mode);
    expect(saved.ids).toEqual([firstKey, otherKey]);
    expect(saved.results).toEqual([]);
    expect(saved.turns).toEqual({});
    expect((await facts(page)).practice).toEqual(scored);
    await expect(score).toContainText(`${firstKey} · 12 / 30 分`);
    previousId = saved.id;
  }
  const scope = await page.getByRole("combobox", { name: "练习范围" }).boundingBox();
  const button = await restart.boundingBox();
  expect(button!.x).toBeGreaterThanOrEqual(scope!.x + scope!.width);
  expect(Math.abs(button!.y - scope!.y)).toBeLessThan(4);
  await page.screenshot({ path: info.outputPath("restart-all-modes.png") });
});
