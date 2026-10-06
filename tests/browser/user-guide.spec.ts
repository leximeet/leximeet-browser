import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { readingServer } from "../helpers/extension.cjs";
import { captureReadingWorkspace } from "../helpers/reading-workspace";
import { audioFixture } from "../helpers/audio-fixture";
import {
  workspace,
  navigate,
  addWord,
  mutePractice,
  pickWord,
  facts,
  frozenChoice,
} from "./ui-helpers";

// 当前生产扩展的实操图：所有资料经 UI 创建，不以原型或改 DOM 充当产品截图。
test("用户指南：首次安装、规划、网页采集、笔记与练习的明暗窄窗实操图", async ({
  extension,
}, info) => {
  test.setTimeout(120000);
  const page: Page = await workspace(extension);
  await expect(page.getByRole("button", { name: "跳过引导", exact: true })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("usage-first-install.png"),
  });
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  for (const word of ["node", "the", "system"]) await addWord(page, word);
  await mutePractice(page);
  await navigate(page, "学习规划");
  await page.getByRole("button", { name: "设置学习规划", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "四级词汇", exact: false }).first().click();
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("usage-goal.png"),
  });
  await dialog.getByRole("button", { name: "下一步：每天学多少", exact: false }).click();
  await dialog.getByLabel("每天学习新词数").fill("10");
  await dialog.getByLabel("每天复习词数").fill("20");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("usage-plan.png"),
  });
  await dialog.getByRole("button", { name: "保存学习规划", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const server = await readingServer(
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Reading example</title><style>body{margin:0;background:#f5f6f3;color:#26352f;font:20px/1.8 Georgia}main{max-width:720px;margin:48px auto;padding:36px;background:white;border:1px solid #dfe5dd;border-radius:12px}h1{font-size:34px;line-height:1.25}small{font:13px/1.4 system-ui;color:#6c7a71}p{margin:24px 0}</style><main><small>ENGLISH READING · 本地示例文章</small><h1>A useful reading habit</h1><p>Node uses the system.</p><p>Node uses the system.</p><p>The system helps the reader and Node learns.</p><h2>Read, collect, and revisit</h2><p>Keep one sentence with each useful word. Review the sentence after reading the article.</p></main></html>',
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    await panel.getByRole("button", { name: "分析本页", exact: true }).click();
    await expect(
      panel.locator(".lm-row strong").filter({ hasText: /^Node$/ }),
    ).toHaveCount(1);
    await expect(
      panel.locator(".lm-row strong").filter({ hasText: /^(The|the)$/ }),
    ).toHaveCount(1);
    for (const theme of ["light", "dark"]) {
      await reading.emulateMedia({ colorScheme: theme as "light" | "dark" });
      await panel.emulateMedia({ colorScheme: theme as "light" | "dark" });
      await expect(panel.locator(".lm-panel")).toHaveAttribute("data-theme", theme);
      await panel.screenshot({
        animations: "disabled",
        path: info.outputPath(`reading-words-after-${theme}.png`),
      });
      await captureReadingWorkspace(
        reading,
        panel,
        info.outputPath(`usage-reading-workspace-${theme}.png`),
      );
      const contrasts = await panel.locator(".lm-row strong").evaluateAll((words) => {
        const luminance = (rgb: string) => {
          const [r, g, b] = rgb
            .match(/\d+(?:\.\d+)?/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const n = v / 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        return words.map((word) => {
          let container: Element | null = word;
          while (
            container &&
            getComputedStyle(container).backgroundColor === "rgba(0, 0, 0, 0)"
          )
            container = container.parentElement;
          const a = luminance(getComputedStyle(word).color),
            b = luminance(getComputedStyle(container!).backgroundColor);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
      });
      for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await pickWord(reading, "Node");
    await expect(panel.locator(".lm-detail h2")).toHaveText("Node");
    await panel.screenshot({
      animations: "disabled",
      path: info.outputPath("usage-capture.png"),
    });
    await reading.emulateMedia({ colorScheme: "light" });
    await panel.emulateMedia({ colorScheme: "light" });
    await captureReadingWorkspace(
      reading,
      panel,
      info.outputPath("usage-capture-workspace.png"),
    );
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect.poll(async () => (await facts(page)).encounters.length).toBe(1);
    await captureReadingWorkspace(
      reading,
      panel,
      info.outputPath("usage-saved-workspace.png"),
    );
    await page.bringToFront();
    await page.getByRole("button", { name: "新建单词本", exact: true }).click();
    const book = page.getByRole("dialog", { name: "新建单词本" });
    await book.getByLabel("单词本名称", { exact: true }).fill("技术用法");
    await book.getByRole("button", { name: "保存单词本", exact: true }).click();
    await expect(book).toHaveCount(0);
    await navigate(page, "我的词库");
    await page
      .locator(".v3-library-row > button")
      .filter({ hasText: /node/i })
      .first()
      .click();
    await page.getByRole("button", { name: "编辑个人内容", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑个人内容" });
    await edit.getByLabel("我的笔记", { exact: true }).fill("阅读文章时记下的一句用法。");
    await edit.getByRole("checkbox", { name: "技术用法", exact: true }).check();
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("usage-personal-note.png"),
    });
    await edit.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await facts(page)).words.find((w: any) => w.normalized === "node")?.note,
      )
      .toBe("阅读文章时记下的一句用法。");
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("usage-library.png"),
    });
    await page.getByRole("button", { name: "编辑单词列表", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择单词 node", exact: true }).check();
    await page.getByRole("checkbox", { name: "选择单词 system", exact: true }).check();
    await expect(page.getByLabel("批量单词操作", { exact: true })).toContainText(
      "已选择 2 词",
    );
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("usage-library-bulk.png"),
    });
    await page.getByRole("button", { name: "批量移到回收站", exact: true }).click();
    const recycle = page.getByRole("dialog", { name: "移到回收站？" });
    await expect(recycle).toContainText("2 个单词");
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("usage-recycle-confirmation.png"),
    });
    await recycle.getByRole("button", { name: "取消", exact: true }).click();
    await expect(recycle).toHaveCount(0);
    await page.getByRole("button", { name: "结束批量编辑", exact: true }).click();
    for (const theme of ["light", "dark"]) {
      await navigate(page, "设置");
      await page.getByLabel("主题", { exact: true }).selectOption(theme);
      await expect(page.locator("main.lm-workspace")).toHaveAttribute(
        "data-theme",
        theme,
      );
      await navigate(page, "练习中心");
      await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
      if (theme === "dark")
        await page.getByRole("button", { name: "重新开始", exact: true }).click();
      await page.getByRole("button", { name: "看词选义", exact: true }).click();
      await expect(page.locator(".v3-meaning-choices > button")).toHaveCount(4);
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`choice-after-${theme}.png`),
      });
      const question = await frozenChoice(page);
      const correct = page
        .locator(".v3-meaning-choices > button")
        .nth(question.options.findIndex((o: any) => o.id === question.correctChoiceId));
      await correct.click();
      await expect(correct).toHaveClass(/correct/);
      await expect
        .poll(async () => (await facts(page)).practice.length)
        .toBe(theme === "light" ? 1 : 2);
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`choice-feedback-${theme}.png`),
      });
      await page.getByRole("button", { name: "单词临摹", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "逐字拼写" })).toBeEnabled();
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`usage-copy-${theme}.png`),
      });
      await page.setViewportSize({ width: 780, height: 900 });
      await page.screenshot({
        animations: "disabled",
        path: info.outputPath(`usage-copy-narrow-${theme}.png`),
      });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await navigate(page, "设置");
    await page.getByLabel("主题", { exact: true }).selectOption("light");
    await page.getByLabel("采集隐私与重复语境", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("usage-capture-settings.png"),
    });
    await navigate(page, "练习中心");
    for (const [mode, filename] of [
      ["单词列表", "usage-practice-list.png"],
      ["单词默写", "usage-practice-recall.png"],
      ["语境填空", "usage-practice-cloze.png"],
    ]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      await expect(page.locator(".v3-practice-stage")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      await page.screenshot({ animations: "disabled", path: info.outputPath(filename!) });
    }
    // 听力仍经过真正 HTMLMediaElement；仅用本地 WAV 代替外部 Provider 的网络响应。
    await page.route("https://dict.youdao.com/dictvoice?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: audioFixture(),
      });
    });
    await page.getByRole("button", { name: "听音辨词", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "练习答案" })).toBeEnabled();
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("usage-practice-listening.png"),
    });
    await page.getByRole("button", { name: "显示提示", exact: true }).click();
    const hint = page.locator(".v3-written-hint");
    await expect(hint).toBeVisible();
    const answer = page.getByRole("textbox", { name: "练习答案" });
    await expect(answer).toBeEnabled();
    await answer.fill((await hint.textContent())!.trim().slice(0, 2));
    await expect(answer).not.toHaveValue("");
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("usage-listening-hint.png"),
    });
  } finally {
    await server.close();
  }
});
