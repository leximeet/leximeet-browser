import type { Route } from "@playwright/test";
import { test, expect } from "./fixtures";
import { workspace, addWord, navigate } from "./ui-helpers";

test("正式 government 助记 Markdown 展开为标题与列表，明暗布局可读", async ({
  extension,
}, info) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  await addWord(manager, "government");
  const card = manager.getByRole("article", { name: "单词词卡" });
  await card.getByRole("button", { name: "词卡显示设置" }).click();
  const dialog = manager.getByRole("dialog", { name: "词卡显示设置" });
  await dialog.getByRole("button", { name: "完整", exact: true }).click();
  await dialog.getByRole("button", { name: "保存词卡设置", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await card.getByText("助记文章", { exact: true }).scrollIntoViewIfNeeded();
  await manager.screenshot({ path: info.outputPath("markdown-light.png") });
  await navigate(manager, "设置");
  await manager.getByLabel("主题", { exact: true }).selectOption("dark");
  await navigate(manager, "我的词库");
  await card.getByText("助记文章", { exact: true }).scrollIntoViewIfNeeded();
  await manager.screenshot({ path: info.outputPath("markdown-dark.png") });
  await expect(
    card.getByRole("heading", { name: "词根分析", exact: true }),
  ).toBeVisible();
  await expect(card.locator("ol")).not.toHaveCount(0);
  // 完整词卡按阅读模块呈现，不能把源数据 JSON 输出给用户。
  await expect(card.locator("pre")).toHaveCount(0);
  await expect(card).not.toContainText("schema_version");
  await expect(
    card.locator(".lm-readable-text", { hasText: "词根分析" }),
  ).not.toContainText("### 词根分析");
});

test("独立采集默认安全句子、7天查重和设置关闭；重启保留政策与事实", async ({
  extension,
}, info) => {
  const { readingServer } = await import("../helpers/extension.cjs");
  const { facts, pickWord, closeNativePanel } = await import("./ui-helpers");
  let manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  await navigate(manager, "设置");
  const policy = manager.getByRole("region", { name: "采集隐私与重复语境" });
  await policy.scrollIntoViewIfNeeded();
  await manager.screenshot({
    path: info.outputPath("capture-policy-light.png"),
  });
  await manager.getByLabel("主题", { exact: true }).selectOption("dark");
  await policy.scrollIntoViewIfNeeded();
  await manager.screenshot({
    path: info.outputPath("capture-policy-dark.png"),
  });
  await expect(policy.getByLabel("相同语境去重天数")).toHaveValue("7");
  await expect(policy.getByLabel("敏感内容替换为 xxx")).toBeChecked();
  await expect(policy.getByLabel("单句语境长度上限")).toHaveValue("500");

  const server = await readingServer(
    `<!doctype html><title>Contact token=secretvalue</title><style>body{margin:48px;font:22px/1.9 Georgia}p{max-width:650px}</style><p>Before no target. Contact me@example.com about resilient on 13800138000. After no target.</p>`,
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    const capture = async (newRound = false) => {
      // 首次切入自动开始；结束后留在同一采集页，使用明确的“开始采集”新一轮入口。
      await panel
        .getByRole("button", {
          name: newRound ? "开始采集" : "采集",
          exact: true,
        })
        .click();
      await expect(
        panel.getByRole("button", { name: "结束采集", exact: true }),
      ).toBeVisible();
      await pickWord(reading, "resilient");
      await expect(panel.locator(".lm-row")).toHaveCount(1);
      await panel.getByRole("button", { name: "结束采集", exact: true }).click();
      const confirm = panel.getByRole("dialog", {
        name: "将采集的单词加入单词本？",
      });
      await confirm.getByRole("button", { name: "加入并结束", exact: true }).click();
      await expect(confirm).toHaveCount(0);
    };
    await capture();
    const initial = await facts(manager);
    expect(initial.encounters).toHaveLength(1);
    const record = initial.encounters[0];
    expect(record.originalSentence).toBe("Contact xxx about resilient on xxx.");
    expect(record.savedExcerpt).toBe(record.originalSentence);
    expect(record.occurrenceRanges).toEqual([{ start: 18, end: 27 }]);
    expect(record.source.title).toBe("Contact token=xxx");
    const savedDrafts = await extension.worker.evaluate(async () =>
      JSON.stringify(await (globalThis as any).chrome.storage.local.get(null)),
    );
    expect(savedDrafts).not.toContain("me@example.com");
    expect(savedDrafts).not.toContain("13800138000");
    expect(savedDrafts).not.toContain("secretvalue");
    await capture(true);
    await expect(
      panel.getByText("已新增 0 条语境，1 条相同语境已记录", { exact: true }),
    ).toBeVisible();
    expect((await facts(manager)).encounters).toEqual(initial.encounters);
    await closeNativePanel(panel);
    await navigate(manager, "设置");
    await policy.getByLabel("相同语境去重天数").fill("0");
    await policy.getByLabel("相同语境去重天数").press("Tab");
    await expect(policy.getByLabel("相同语境去重天数")).toHaveValue("0");
    await extension.restart();
    manager = await workspace(extension);
    await navigate(manager, "设置");
    await expect(manager.getByLabel("相同语境去重天数")).toHaveValue("0");
    expect((await facts(manager)).encounters).toEqual(initial.encounters);
    await info.attach("real-policy-record", {
      body: Buffer.from(
        JSON.stringify({
          record,
          duplicateDidNotCreate: true,
          redactedDraft: true,
          policyRestored: true,
        }),
      ),
      contentType: "application/json",
    });
  } finally {
    await server.close();
  }
});

test("快速往返六模式后临摹只记一次，离开返回与重新开始不会卡住原反馈", async ({
  extension,
}) => {
  const { facts, mutePractice } = await import("./ui-helpers");
  const { audioFixture } = await import("../helpers/audio-fixture");
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  await addWord(manager, "state");
  await mutePractice(manager);
  // 听音题必须请求真实音频，离线响应验证业务，不放行外网。
  await manager.route("https://dict.youdao.com/dictvoice?*", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: audioFixture(),
    }),
  );
  await navigate(manager, "练习中心");
  await manager.getByLabel("练习范围", { exact: true }).selectOption("library");
  for (let round = 0; round < 2; round++)
    for (const label of [
      "看词选义",
      "单词临摹",
      "单词默写",
      "听音辨词",
      "语境填空",
      "单词列表",
    ])
      await manager.getByRole("button", { name: label, exact: true }).click();
  await manager.getByRole("button", { name: "单词临摹", exact: true }).click();
  const input = manager.getByRole("textbox", { name: "逐字拼写", exact: true });
  await input.pressSequentially("state");
  await expect.poll(async () => (await facts(manager)).practice.length).toBe(1);
  await expect(
    manager.getByRole("button", { name: "重新开始", exact: true }),
  ).toBeEnabled();
  await navigate(manager, "我的词库");
  await navigate(manager, "练习中心");
  const previousSession = (await facts(manager)).checkpoints?.library?.id;
  await manager.getByRole("button", { name: "重新开始", exact: true }).click();
  await expect
    .poll(async () => (await facts(manager)).checkpoints?.library?.id)
    .not.toBe(previousSession);
  await expect(
    manager.getByRole("button", { name: "重新开始", exact: true }),
  ).toBeEnabled();
  await expect(input).toBeEnabled();
  await input.pressSequentially("state");
  await expect.poll(async () => (await facts(manager)).practice.length).toBe(2);
  await expect(
    manager.getByRole("button", { name: "重新开始", exact: true }),
  ).toBeEnabled();
  await expect(manager.getByRole("alert")).toHaveCount(0);
});
