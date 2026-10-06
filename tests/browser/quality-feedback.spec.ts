import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { readingServer } from "../helpers/extension.cjs";
import {
  workspace,
  navigate,
  addWord,
  mutePractice,
  facts,
  pickWord,
  frozenChoice,
} from "./ui-helpers";

test("选义确认后保持一秒并完整切题；逐帧无空卡片、连点只记一次、错题不自动换词", async ({
  extension,
}, info) => {
  const page: Page = await workspace(extension);
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  for (const word of ["node", "system", "the"]) await addWord(page, word);
  await mutePractice(page);
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  const options = page.locator(".v3-meaning-choices > button");
  await expect(options).toHaveCount(4);
  await expect(options.first()).toBeEnabled();
  const question = await frozenChoice(page);
  const option = options.nth(
    question.options.findIndex((o: any) => o.id === question.correctChoiceId),
  );
  const before = await options.evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
  const head = await page.locator(".v3-practice-headword").innerText();
  // 观察真实 DOM 的换词时刻，不替换产品计时器，也不改变设备日期。
  await page.evaluate(() => {
    const sample = {
      clicked: 0,
      changed: 0,
      saved: 0,
      emptyFrames: 0,
      frames: [] as unknown[],
      head: document.querySelector(".v3-practice-headword")!.textContent,
      texts: [...document.querySelectorAll(".v3-meaning-choices > button strong")].map(
        (o) => o.textContent,
      ),
    };
    (globalThis as any).__choiceDwell = sample;
    document.querySelector(".v3-meaning-choices")!.addEventListener(
      "click",
      () => {
        sample.clicked ||= performance.now();
      },
      { capture: true },
    );
    const observe = () => {
      if (!sample.clicked) return;
      const heading = document.querySelector(".v3-practice-headword")?.textContent;
      const options = [...document.querySelectorAll(".v3-meaning-choices > button")];
      if (!sample.changed && !options.length) sample.emptyFrames++;
      if (
        !sample.saved &&
        document.querySelector(".v3-learning-score")?.textContent?.includes("· +1")
      )
        sample.saved = performance.now();
      if (!sample.changed)
        sample.frames.push({
          at: performance.now(),
          head: heading,
          options: options.map((o) => o.textContent),
          texts: options.map((o) => o.querySelector("strong")?.textContent),
          opacity: options.map((o) => getComputedStyle(o).opacity),
          boxes: options.map((o) => {
            const r = o.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }),
        });
    };
    new MutationObserver(() => {
      observe();
      if (
        sample.clicked &&
        !sample.changed &&
        document.querySelector(".v3-practice-headword")!.textContent !== sample.head
      )
        sample.changed = performance.now();
    }).observe(document.querySelector(".v3-practice-stage")!, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    const frame = () => {
      observe();
      if (!sample.changed) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await option.dblclick();
  await expect(option).toHaveClass(/correct/);
  await expect(options.first()).toBeDisabled();
  const after = await options.evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
  expect(after).toEqual(before);
  await expect.poll(async () => (await facts(page)).practice.length).toBe(1);
  await expect(page.locator(".v3-practice-headword")).not.toHaveText(head);
  const dwell = await page.evaluate(() => (globalThis as any).__choiceDwell);
  await info.attach("actual-choice-transition", {
    body: JSON.stringify(dwell, null, 2),
    contentType: "application/json",
  });
  expect(dwell.saved).toBeGreaterThan(dwell.clicked);
  expect(dwell.changed - dwell.saved).toBeGreaterThanOrEqual(1000);
  expect(dwell.emptyFrames).toBe(0);
  expect(
    dwell.frames.every(
      (f: any) => f.options.length === 4 && f.opacity.every((o: string) => o === "1"),
    ),
  ).toBe(true);
  const originalFrames = dwell.frames.filter((f: any) => f.head === dwell.head);
  expect(originalFrames.length).toBeGreaterThan(1);
  for (const frame of originalFrames) {
    expect(frame.texts).toEqual(dwell.texts);
    expect(frame.boxes).toEqual(before);
  }
  const rendered = await frozenChoice(page);
  expect(await options.locator("strong").allTextContents()).toEqual(
    rendered.options.map((o: any) => o.text),
  );
  expect((await facts(page)).practice).toHaveLength(1);
  expect((await facts(page)).practice[0].learning.attemptId).toBe(question.attemptId);
  await expect(options.first()).toBeEnabled();
  const next = await frozenChoice(page);
  const wrong = options.nth(
    next.options.findIndex((o: any) => o.id !== next.correctChoiceId),
  );
  const wrongWord = await page.locator(".v3-practice-headword").innerText();
  await wrong.click();
  await expect(wrong).toHaveClass(/wrong/);
  await expect.poll(async () => (await facts(page)).practice.length).toBe(2);
  expect(
    (await facts(page)).practice.find((p: any) => p.learning.attemptId === next.attemptId)
      ?.correct,
  ).toBe(false);
  // 此等待专门验证超过产品一秒停留期后，错题仍留在原词。
  await page.waitForTimeout(1200);
  await expect(page.locator(".v3-practice-headword")).toHaveText(wrongWord);
  await page.screenshot({ path: info.outputPath("choice-error-stable.png") });
});

test("正确反馈期间换模式、离开、重新开始不会被旧倒计时推进", async ({ extension }) => {
  const page: Page = await workspace(extension);
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  for (const word of ["node", "system"]) await addWord(page, word);
  await mutePractice(page);
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  const chooseCorrect = async () => {
    const options = page.locator(".v3-meaning-choices > button");
    await expect(options.first()).toBeEnabled();
    const q = await frozenChoice(page);
    await options
      .nth(q.options.findIndex((o: any) => o.id === q.correctChoiceId))
      .click();
    await expect(
      page.getByRole("button", { name: "重新开始", exact: true }),
    ).toBeEnabled();
  };
  await chooseCorrect();
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await page.waitForTimeout(1200);
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 2 词");
  await page.getByRole("button", { name: "看词选义", exact: true }).click();
  await navigate(page, "我的词库");
  await page.waitForTimeout(1200);
  await navigate(page, "练习中心");
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 2 词");
  await page.getByRole("button", { name: "重新开始", exact: true }).click();
  await page.waitForTimeout(1200);
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 2 词");
  await expect(page.locator(".v3-meaning-choices > button").first()).toBeEnabled();
  await chooseCorrect();
  await page.getByRole("button", { name: "拼写设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "拼写设置" })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.waitForTimeout(1200);
  await expect(page.locator(".v3-progress-line")).toContainText("第 1 / 2 词");
  expect((await facts(page)).practice).toHaveLength(2);

  await page.getByRole("button", { name: "重新开始", exact: true }).click();
  await expect(page.locator(".v3-meaning-choices > button").first()).toBeEnabled();
  const delayedQuestion = await frozenChoice(page),
    delayedHead = await page.locator(".v3-practice-headword").innerText();
  // 用真实 IndexedDB 连续读请求延迟写事务完成，不伪造回执或成绩。
  // release 后由浏览器正常提交；离开/返回必须只撤销自动切题，不撤销已经提交的事实。
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    let once = true;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: any[]) {
      const tx = (original as any).apply(this, args),
        names = Array.from(tx.objectStoreNames);
      if (
        once &&
        tx.mode === "readwrite" &&
        names.includes("practice") &&
        names.includes("reviews")
      ) {
        once = false;
        let hold = true;
        (globalThis as any).__heldPracticeWrite = { release: () => (hold = false) };
        const keepAlive = () => {
          const request = tx.objectStore("meta").get("test-read-only-keepalive");
          request.onsuccess = () => {
            if (hold) keepAlive();
          };
        };
        keepAlive();
      }
      return tx;
    } as typeof original;
  });
  await page
    .locator(".v3-meaning-choices > button")
    .nth(
      delayedQuestion.options.findIndex(
        (o: any) => o.id === delayedQuestion.correctChoiceId,
      ),
    )
    .click();
  await expect(
    page.getByRole("button", { name: "重新开始", exact: true }),
  ).toBeDisabled();
  await navigate(page, "我的词库");
  await expect(
    page.getByRole("heading", { name: "我的词库", exact: true }),
  ).toBeVisible();
  await navigate(page, "练习中心");
  await expect(page.locator(".v3-practice-headword")).toHaveText(delayedHead);
  await page.evaluate(() => (globalThis as any).__heldPracticeWrite.release());
  await expect(page.getByRole("button", { name: "重新开始", exact: true })).toBeEnabled();
  await page.waitForTimeout(1200);
  await expect(page.locator(".v3-practice-headword")).toHaveText(delayedHead);
  const saved = (await facts(page)).practice;
  expect(saved).toHaveLength(3);
  expect(
    saved.filter((p: any) => p.learning.attemptId === delayedQuestion.attemptId),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "下一个", exact: true }).click();
  await expect(page.locator(".v3-practice-headword")).not.toHaveText(delayedHead);
});

test("实际保存事务中止保留原题；重试确认后才停留一秒，同一次尝试只记一条", async ({
  extension,
}, info) => {
  const page = await workspace(extension);
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  for (const word of ["node", "system"]) await addWord(page, word);
  await mutePractice(page);
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await expect(page.locator(".v3-meaning-choices > button").first()).toBeEnabled();
  const question = await frozenChoice(page),
    head = await page.locator(".v3-practice-headword").innerText();
  // 故障注入真正 abort 当前练习写事务，不伪造服务回执，也不写入测试成绩。
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    let once = true;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: any[]) {
      const tx = (original as any).apply(this, args),
        names = Array.from(tx.objectStoreNames);
      if (
        once &&
        tx.mode === "readwrite" &&
        names.includes("practice") &&
        names.includes("reviews")
      ) {
        once = false;
        queueMicrotask(() => tx.abort());
      }
      return tx;
    } as typeof original;
  });
  await page
    .locator(".v3-meaning-choices > button")
    .nth(question.options.findIndex((o: any) => o.id === question.correctChoiceId))
    .click();
  await expect(page.getByRole("button", { name: "重试保存", exact: true })).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator(".v3-practice-headword")).toHaveText(head);
  expect((await facts(page)).practice).toHaveLength(0);
  await page.screenshot({
    path: info.outputPath("actual-write-abort-retains-question.png"),
  });
  const savedAt = await page
    .getByRole("button", { name: "重试保存", exact: true })
    .click()
    .then(() => Date.now());
  await expect.poll(async () => (await facts(page)).practice.length).toBe(1);
  await expect(page.locator(".v3-practice-headword")).not.toHaveText(head);
  expect(Date.now() - savedAt).toBeGreaterThanOrEqual(1000);
  const practice = (await facts(page)).practice;
  expect(practice).toHaveLength(1);
  expect(practice[0].learning.attemptId).toBe(question.attemptId);
});

test("原生遇见侧栏同词归并但保留真实所选位置；采集不同语境仍分条", async ({
  extension,
}) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  for (const word of ["node", "the", "system"]) await addWord(manager, word);
  const server = await readingServer(
    '<!doctype html><meta charset="utf-8"><title>Reading example</title><p>Node uses the system.</p><p>Node uses the system.</p><p>The system helps the reader and Node learns.</p>',
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    await panel.getByRole("button", { name: "分析本页", exact: true }).click();
    await expect(panel.locator(".lm-row")).toHaveCount(3);
    await expect(panel.locator(".lm-results .lm-region-title")).toContainText("3 词");
    const names = await panel.locator(".lm-row strong").allTextContents();
    expect(names.map((x) => x.toLowerCase()).sort()).toEqual(["node", "system", "the"]);
    expect((await facts(manager)).encounters).toHaveLength(0);
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await pickWord(reading, "Node", 0);
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect.poll(async () => (await facts(manager)).encounters.length).toBe(1);
    for (const [position, count] of [
      [1, 1],
      [2, 2],
    ] as const) {
      await panel.getByRole("button", { name: "开始采集", exact: true }).click();
      await pickWord(reading, "Node", position);
      await expect(panel.locator(".lm-row")).toHaveCount(1);
      await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
      await expect(
        panel.getByRole("button", { name: "开始采集", exact: true }),
      ).toBeVisible();
      expect((await facts(manager)).encounters).toHaveLength(count);
    }
    expect(
      (await facts(manager)).words.filter((w: any) => w.normalized === "node"),
    ).toHaveLength(1);
  } finally {
    await server.close();
  }
});
