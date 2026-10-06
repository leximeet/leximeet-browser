import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { readingServer } from "../helpers/extension.cjs";
import {
  workspace,
  navigate,
  addWord,
  setTarget,
  facts,
  pickWord,
  practiceSettings,
} from "./ui-helpers";

test("学习规划分步提交与唯一替换；首页三个 Tab 切换同一个任务列表", async ({
  extension,
}) => {
  const page = await workspace(extension);
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  await addWord(page, "resilient");
  await navigate(page, "学习规划");
  await page.getByRole("button", { name: "设置学习规划", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "下一步：每天学多少", exact: false }),
  ).toBeDisabled();
  await expect(dialog.getByLabel("每天学习新词数")).toHaveCount(0);
  await dialog.getByRole("button", { name: "四级词汇", exact: false }).first().click();
  expect((await facts(page)).plan).toBeUndefined();
  await dialog.getByRole("button", { name: "下一步：每天学多少", exact: false }).click();
  await dialog.getByLabel("每天学习新词数").fill("9");
  await dialog.getByLabel("每天复习词数").fill("20");
  await dialog.getByRole("button", { name: "保存学习规划", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const original = await facts(page);
  expect(original.plan.dailyNew).toBe(9);
  expect(original.plan.dailyReview).toBe(20);
  await page.getByRole("button", { name: "调整计划", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("navigation", { name: "学习目标类型" })).toHaveCount(0);
  await dialog.getByLabel("每天学习新词数").fill("11");
  await dialog.getByRole("button", { name: "保存学习计划", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const adjusted = (await facts(page)).plan;
  expect(adjusted.id).toBe(original.plan.id);
  expect(adjusted.sourceId).toBe(original.plan.sourceId);
  expect(adjusted.dailyNew).toBe(11);
  await page.getByRole("button", { name: "更换学习目标", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "六级词汇", exact: false }).first().click();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect((await facts(page)).plan).toEqual(adjusted);
  await page.getByRole("button", { name: "更换学习目标", exact: true }).click();
  await dialog.getByRole("button", { name: "六级词汇", exact: false }).first().click();
  await dialog.getByRole("button", { name: "下一步：每天学多少", exact: false }).click();
  await dialog.getByRole("button", { name: "保存学习规划", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const replaced = await facts(page);
  expect(replaced.plan.id).not.toBe(original.plan.id);
  expect(replaced.plan.sourceId).not.toBe(original.plan.sourceId);
  expect(replaced.words).toEqual(original.words);
  expect(replaced.encounters).toEqual(original.encounters);
  await navigate(page, "今日学习");
  await expect(
    page.getByRole("tablist", { name: "今日任务" }).getByRole("tab"),
  ).toHaveCount(3);
  for (const [label, count] of [
    ["今日遇见", 0],
    ["学习计划", 11],
    ["复习计划", 0],
  ] as const) {
    await page.getByRole("tab", { name: new RegExp(label) }).click();
    await expect(page.getByRole("tabpanel")).toHaveCount(1);
    await expect(
      page.getByRole("tabpanel").getByRole("heading", { name: label }),
    ).toBeVisible();
    await expect(page.locator(".v3-daily-group > button")).toHaveCount(count);
  }
  await page.getByRole("tab", { name: /今日遇见/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /学习计划/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "打开练习中心", exact: false }),
  ).toHaveCount(0);
});

// 明确的网络夹具：用 WAV 检查自动播放链路，不将测试音频称为有道真人音质。
function audioFixture() {
  const samples = 3200,
    wave = Buffer.alloc(44 + samples * 2);
  wave.write("RIFF");
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wave.writeInt16LE(
      Math.round(Math.sin((i * Math.PI * 2 * 440) / 8000) * 700),
      44 + i * 2,
    );
  return wave;
}
test("临摹默写完成才发音，选义与未完成不发音；音效可关闭并跨刷新保留", async ({
  extension,
}, info) => {
  const page: Page = await workspace(extension),
    requests: string[] = [],
    nodes: string[] = [];
  await page.route("https://dict.youdao.com/dictvoice?*", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: audioFixture(),
    });
  });
  await page.evaluate(() => {
    (globalThis as any).__audioPlays = [];
    document.addEventListener(
      "playing",
      (event) => {
        if (event.target instanceof HTMLAudioElement)
          (globalThis as any).__audioPlays.push(event.target.currentSrc);
      },
      true,
    );
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAudio.enable");
  cdp.on("WebAudio.audioNodeCreated", (event) => {
    if (/Oscillator/.test(event.node.nodeType)) nodes.push(event.node.nodeId);
  });
  await navigate(page, "设置");
  await expect(
    page.getByRole("checkbox", { name: "拼写完成后发音", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "打字与答题音效", exact: true }),
  ).toBeChecked();
  await addWord(page, "resilient");
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await expect(page.locator(".v3-meaning-choices > button")).toHaveCount(4);
  expect(requests).toHaveLength(0);
  await page.locator(".v3-meaning-choices > button").first().click();
  await expect.poll(() => nodes.length).toBe(2);
  expect(requests).toHaveLength(0); // 看词选义答题也不自动发音。
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await practiceSettings(page, 1, false);
  const input = page.getByRole("textbox", { name: "逐字拼写" });
  await input.press("r");
  await expect(page.locator(".v3-character.typed")).toHaveCount(1);
  expect(requests).toHaveLength(0);
  await expect.poll(() => nodes.length).toBe(3);
  await input.pressSequentially("esilient", { delay: 45 });
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__audioPlays.length))
    .toBe(1);
  expect(new URL(requests[0]!).searchParams.get("audio")).toBe("resilient");
  await page.getByRole("button", { name: "单词默写", exact: true }).click();
  expect(await page.evaluate(() => (globalThis as any).__audioPlays.length)).toBe(1);
  await input.press("x");
  await expect(page.locator(".v3-character-stage.error")).toHaveCount(1);
  expect(await page.evaluate(() => (globalThis as any).__audioPlays.length)).toBe(1);
  await expect(page.locator(".v3-character-stage.error")).toHaveCount(0);
  await input.pressSequentially("resilient", { delay: 45 });
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__audioPlays.length))
    .toBe(2);
  await page.getByRole("button", { name: "拼写设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "拼写完成后发音", exact: true }).uncheck();
  await dialog.getByRole("checkbox", { name: "打字与答题音效", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "保存拼写设置", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const nodesBefore = nodes.length,
    requestsBefore = requests.length;
  await page.reload();
  await navigate(page, "设置");
  await expect(
    page.getByRole("checkbox", { name: "拼写完成后发音", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "打字与答题音效", exact: true }),
  ).not.toBeChecked();
  await navigate(page, "练习中心");
  await page.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await page.getByRole("button", { name: "单词临摹", exact: true }).click();
  await input.pressSequentially("resilient", { delay: 45 });
  await expect(page.locator(".v3-practice-feedback")).toHaveText("拼写正确");
  expect(nodes.length).toBe(nodesBefore);
  expect(requests.length).toBe(requestsBefore);
  await info.attach("audio-evidence", {
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({
        requests,
        oscillatorNodes: nodes.length,
        source: "offline WAV fixture; not voice quality evidence",
      }),
    ),
  });
  await cdp.detach();
});

test("采集中打开管理先确认，原网页不提前切换；拒绝继续不会自动保存", async ({
  extension,
}) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  const server = await readingServer(
    "<!doctype html><title>Before navigation</title><p>A resilient learner returns.</p>",
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    await expect(
      panel.getByRole("button", { name: "关闭侧栏", exact: true }),
    ).toHaveCount(0);
    await expect(panel.locator("footer")).toHaveText("浏览器独立运行");
    await expect(
      panel.getByRole("contentinfo", { name: "运行状态", exact: true }),
    ).toHaveText("浏览器独立运行");
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await pickWord(reading, "resilient");
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    await panel.getByRole("button", { name: "打开管理", exact: true }).click();
    const dialog = panel.getByRole("dialog", { name: "继续采集吗？" });
    await expect(dialog).toContainText("1 条语境未加入");
    expect(await reading.evaluate(() => document.visibilityState)).toBe("visible");
    expect((await facts(manager)).encounters).toHaveLength(0);
    await dialog.getByRole("button", { name: "继续采集", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "打开管理", exact: true }).click();
    await dialog.getByRole("button", { name: "不继续，丢弃未加入", exact: true }).click();
    await expect
      .poll(() => manager.evaluate(() => document.visibilityState))
      .toBe("visible");
    await expect
      .poll(() =>
        extension.worker.evaluate(() =>
          (globalThis as any).chrome.runtime.getContexts({
            contextTypes: ["SIDE_PANEL"],
          }),
        ),
      )
      .toHaveLength(0);
    expect((await facts(manager)).encounters).toHaveLength(0);
    expect((await facts(manager)).words).toHaveLength(0);
  } finally {
    await server.close();
  }
});
