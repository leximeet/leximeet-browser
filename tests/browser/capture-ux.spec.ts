import { panelTitle, closeNativePanel } from "./ui-helpers";
import { test, expect } from "./fixtures";
import { readingServer } from "../helpers/extension.cjs";
import {
  workspace,
  navigate,
  facts,
  pickWord,
  nativePanel,
  addWord,
  setTarget,
} from "./ui-helpers";

test("采摘真实 Range：空列表、抓手与飞入、结束确认、草稿保留、选本原子保存和侧栏共存", async ({
  extension,
}, info) => {
  const manager = await workspace(extension);
  const skip = manager.getByRole("button", { name: "跳过引导", exact: true });
  await expect(skip).toBeVisible();
  await skip.click();
  await manager.getByRole("button", { name: "新建单词本", exact: true }).click();
  const bookDialog = manager.getByRole("dialog", { name: "新建单词本" });
  await bookDialog.getByRole("textbox", { name: "单词本名称" }).fill("精读采摘");
  await bookDialog.getByRole("button", { name: "保存单词本", exact: true }).click();
  await expect(bookDialog).toHaveCount(0);
  const server = await readingServer(
    `<!doctype html><title>Context collection</title><style>body{margin:48px;font:22px/1.9 Georgia}p{max-width:650px}</style><p>A resilient reader returns. A simple system can help a resilient learner.</p><button id="original" onclick="this.textContent='restored'">Site action</button>`,
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    let panel = await extension.openPanel(reading);
    const ball = reading.locator("leximeet-page-ui .ball");
    const contexts = () =>
      extension.worker.evaluate(() =>
        (globalThis as any).chrome.runtime.getContexts({
          contextTypes: ["SIDE_PANEL"],
        }),
      );
    await expect.poll(contexts).toHaveLength(1);
    await expect(ball).toBeVisible();
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    await expect(reading.locator("body > p")).toHaveCSS("cursor", "grab");
    // 仅观察正式动画元素插入，不修改产品事件或数据。
    await reading.evaluate(() => {
      (globalThis as any).__pickAnimations = 0;
      const root = document.querySelector("leximeet-page-ui")!.shadowRoot!;
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (node instanceof HTMLElement && node.classList.contains("pick-flight"))
              (globalThis as any).__pickAnimations++;
      }).observe(root, { childList: true });
    });
    await pickWord(reading, "resilient");
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    await expect(panel.locator(".lm-detail h2")).toHaveText("resilient");
    await expect
      .poll(() => reading.evaluate(() => (globalThis as any).__pickAnimations))
      .toBe(1);
    await pickWord(reading, "resilient");
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    await pickWord(reading, "resilient", 1);
    await expect(panel.locator(".lm-row")).toHaveCount(2);
    expect((await facts(manager)).encounters).toHaveLength(0);
    const listBox = await panel.locator(".lm-results").boundingBox(),
      cardBox = await panel.locator(".lm-detail").boundingBox();
    // 新版保留完整词卡；列表仍有足够空间，两个区域独立滚动。
    expect(listBox!.height).toBeGreaterThan(160);
    expect(cardBox!.height).toBeGreaterThan(240);
    await expect(panel.getByRole("button", { name: "释义", exact: true })).toBeVisible();
    await panel.screenshot({ path: info.outputPath("picked-light.png") });
    await panel.getByRole("button", { name: "结束采集", exact: true }).click();
    let confirm = panel.getByRole("dialog", {
      name: "将采集的单词加入单词本？",
    });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "继续采集", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(reading.locator("body > p")).toHaveCSS("cursor", "grab");
    await panel.getByRole("button", { name: "结束采集", exact: true }).click();
    await confirm
      .getByRole("button", { name: "暂不加入，结束采集", exact: true })
      .click();
    await expect(panel.locator(".lm-row")).toHaveCount(2);
    expect((await facts(manager)).encounters).toHaveLength(0);
    await reading.getByRole("button", { name: "Site action", exact: true }).click();
    await expect(reading.locator("#original")).toHaveText("restored");
    await closeNativePanel(panel);
    await expect.poll(contexts).toHaveLength(0);
    await expect(ball).toBeVisible();
    expect((await facts(manager)).encounters).toHaveLength(0);
    panel = await extension.openPanel(reading);
    await expect(panel.locator(".lm-row")).toHaveCount(2);
    await panel.getByRole("button", { name: "开始采集", exact: true }).click();
    await panel.getByRole("button", { name: "结束采集", exact: true }).click();
    confirm = panel.getByRole("dialog", { name: "将采集的单词加入单词本？" });
    await expect(confirm).toBeVisible();
    await panel.screenshot({ path: info.outputPath("end-confirm.png") });
    await confirm.getByRole("combobox").selectOption({ label: "精读采摘" });
    await confirm.getByRole("button", { name: "加入并结束", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await closeNativePanel(panel);
    await expect.poll(contexts).toHaveLength(0);
    await expect(ball).toBeVisible();
    const data = await facts(manager),
      book = data.notebooks.find((n: any) => n.name === "精读采摘");
    expect(data.encounters).toHaveLength(2);
    expect(data.words).toHaveLength(1);
    expect(data.words[0].notebookIds).toEqual([book.id]);
    panel = await extension.openPanel(reading);
    await expect.poll(contexts).toHaveLength(1);
    await expect(ball).toBeVisible();
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    await reading.reload();
    await expect(ball).toBeVisible();
    await expect.poll(() => panelTitle(panel)).toBe("Context collection");
    await info.attach("real-picking-boundary", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          nativePanel: true,
          actualRanges: 2,
          distinctWords: 1,
          selectedNotebook: true,
          retainedDrafts: true,
          cursorRestored: true,
          mutualExclusionAcrossReload: true,
          animationsObserved: true,
        }),
      ),
    });
  } finally {
    await server.close();
  }
});

test("跳过教学与设置重新进入保留个人资料，教学批注可拖动和收起", async ({
  extension,
}) => {
  const lesson = extension.context
    .pages()
    .find((p) => p.url().endsWith("tutorial.html"))!;
  const coach = lesson.locator("leximeet-page-ui .page-guide");
  await expect(coach).toHaveAttribute("data-step", "pin");
  const before = (await coach.boundingBox())!,
    header = (await coach.locator("header").boundingBox())!;
  await lesson.mouse.move(header.x + 40, header.y + 10);
  await lesson.mouse.down();
  await lesson.mouse.move(header.x - 160, header.y + 210, { steps: 8 });
  await lesson.mouse.up();
  await expect
    .poll(async () => (await coach.boundingBox())!.y)
    .toBeGreaterThan(before.y + 100);
  const moved = (await coach.boundingBox())!;
  await expect.poll(async () => (await coach.boundingBox())!.y).toBeCloseTo(moved.y, 0);
  await coach.getByRole("button", { name: "收起教学", exact: true }).click();
  await expect(coach).toHaveAttribute("data-collapsed", "true");
  await expect(lesson.locator("leximeet-page-ui .page-guide-line")).toBeHidden();
  await coach.getByRole("button", { name: "展开教学", exact: true }).click();
  await expect(coach).toHaveAttribute("data-collapsed", "false");
  await lesson.getByRole("button", { name: "跳过教学", exact: true }).last().click();
  await expect(coach).toBeHidden();
  const page = await workspace(extension);
  await addWord(page, "resilient");
  await setTarget(page);
  const original = await facts(page);
  await navigate(page, "设置");
  await expect(page.getByText("使用教学", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新进入教学", exact: true }).click();
  await expect(coach).toBeVisible();
  await expect(coach).toHaveAttribute("data-step", "pin");
  const state = await extension.worker.evaluate(
    async () =>
      (await (globalThis as any).chrome.storage.local.get("leximeet-onboarding-v2"))[
        "leximeet-onboarding-v2"
      ],
  );
  expect(state.active).toBe(true);
  expect(state.completed).toEqual([]);
  expect(
    extension.context.pages().filter((p) => p.url().endsWith("tutorial.html")),
  ).toHaveLength(1);
  const after = await facts(page);
  expect(after.words).toEqual(original.words);
  expect(after.plan).toEqual(original.plan);
});
