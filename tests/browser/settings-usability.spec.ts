import { test, expect } from "./fixtures";
import {
  workspace,
  navigate,
  addWord,
  facts,
  pickWord,
  closeNativePanel,
} from "./ui-helpers";
import { readingServer } from "../helpers/extension.cjs";

test("跳过教学跨页和重启保留，普通网页永不出现未渲染指引框", async ({ extension }) => {
  const lesson = extension.context
    .pages()
    .find((page) => page.url().endsWith("tutorial.html"))!;
  const coach = lesson.locator("leximeet-page-ui .page-guide");
  await expect(coach).toBeVisible();
  await coach.getByRole("button", { name: "跳过教学", exact: true }).click();
  await expect(coach).toBeHidden();
  const server = await readingServer(
    "<!doctype html><title>普通阅读页</title><p>A resilient reader keeps a simple system.</p>",
  );
  try {
    let reading = await extension.context.newPage();
    await reading.goto(server.url);
    await expect(reading.locator("leximeet-page-ui .ball")).toBeVisible();
    await expect(reading.locator("leximeet-page-ui .page-guide")).toHaveCount(0);
    await reading.reload();
    await expect(reading.locator("leximeet-page-ui .ball")).toBeVisible();
    await expect(reading.locator("leximeet-page-ui .page-guide")).toHaveCount(0);
    await lesson.reload();
    await expect(coach).toBeHidden();
    await extension.restart();
    const guide = await extension.worker.evaluate(
      async () =>
        (await (globalThis as any).chrome.storage.local.get("leximeet-onboarding-v2"))[
          "leximeet-onboarding-v2"
        ],
    );
    expect(guide.active).toBe(false);
    reading = await extension.context.newPage();
    await reading.goto(server.url);
    await expect(reading.locator("leximeet-page-ui .ball")).toBeVisible();
    await expect(reading.locator("leximeet-page-ui .page-guide")).toHaveCount(0);
  } finally {
    await server.close();
  }
});

test("完整与自定义先确认字段、取消不改设置，词卡无 JSON 且明暗窄窗再次保存有反馈", async ({
  extension,
}, info) => {
  const page = await workspace(extension);
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  await addWord(page, "government");
  await navigate(page, "设置");
  await page.getByLabel("词卡密度").selectOption("custom");
  const cardDialog = page.getByRole("dialog", { name: "词卡显示设置" });
  await expect(cardDialog).toBeVisible();
  await cardDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("词卡密度")).toHaveValue("moderate");
  await page.getByLabel("词卡密度").selectOption("custom");
  await cardDialog.getByRole("checkbox", { name: "候选音标", exact: true }).uncheck();
  await cardDialog.getByRole("button", { name: "保存词卡设置", exact: true }).click();
  await expect(cardDialog).toHaveCount(0);
  expect((await facts(page)).workspace.card.sections).not.toContain("pronunciations");
  const custom = (await facts(page)).workspace.card;
  await page.getByLabel("词卡密度").selectOption("complete");
  await expect(cardDialog).toBeVisible();
  await expect(
    cardDialog.getByRole("button", { name: "完整", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  for (const checkbox of await cardDialog.getByRole("checkbox").all())
    await expect(checkbox).toBeChecked();
  expect((await facts(page)).workspace.card).toEqual(custom);
  await cardDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("词卡密度")).toHaveValue("custom");
  expect((await facts(page)).workspace.card).toEqual(custom);

  // 从完整取消一个字段，确认后成为自定义；保存前正式资料仍不变。
  await page.getByLabel("词卡密度").selectOption("complete");
  await cardDialog.getByRole("checkbox", { name: "候选音标", exact: true }).uncheck();
  await expect(
    cardDialog.getByRole("button", { name: "自定义", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect((await facts(page)).workspace.card).toEqual(custom);
  await cardDialog.getByRole("button", { name: "保存词卡设置", exact: true }).click();
  await expect(cardDialog).toHaveCount(0);
  const selected = (await facts(page)).workspace.card;
  expect(selected.level).toBe("custom");
  expect(selected.sections).not.toContain("pronunciations");
  expect(selected.sections).toContain("articles");

  await page.getByLabel("词卡密度").selectOption("complete");
  await expect(cardDialog).toBeVisible();
  await cardDialog.getByRole("button", { name: "保存词卡设置", exact: true }).click();
  await expect(cardDialog).toHaveCount(0);
  await expect(page.getByLabel("词卡密度")).toHaveValue("complete");
  expect((await facts(page)).workspace.card.sections).toContain("pronunciations");
  await expect(page.locator(".v3-runtime-notice")).toHaveText("设置已保存");
  await navigate(page, "我的词库");
  const card = page.getByRole("article", { name: "单词词卡" });
  await expect(
    card.getByRole("heading", { name: "助记文章", exact: true }),
  ).toBeVisible();
  await expect(card.locator("pre")).toHaveCount(0);
  await expect(card).not.toContainText("schema_version");
  await expect(card).not.toContainText("source_payload");
  await navigate(page, "设置");
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await expect(page.locator("main")).toHaveAttribute("data-theme", theme);
    await page.setViewportSize({ width: 1440, height: 914 });
    await page.getByRole("button", { name: "发音设置", exact: true }).click();
    const voice = page.getByRole("dialog", { name: "发音设置" });
    await expect(voice).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`settings-pronunciation-wide-${theme}.png`),
    });
    await page.setViewportSize({ width: 390, height: 790 });
    for (const name of ["口音", "语速"]) {
      const control = voice.getByLabel(name, { exact: true });
      const label = control.locator("..").locator("span");
      const a = (await label.boundingBox())!,
        b = (await control.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(a.y + a.height + 6);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`settings-pronunciation-narrow-${theme}.png`),
    });
    await voice.getByRole("button", { name: "取消", exact: true }).click();
    const saved = page.getByRole("button", { name: "保存设置", exact: true });
    await saved.click();
    await expect(page.locator(".v3-runtime-notice")).toHaveText("设置已保存");
    const before = await page.locator(".v3-runtime-notice").elementHandle();
    await saved.click();
    await expect
      .poll(() => before!.evaluate((element: HTMLElement) => element.isConnected))
      .toBe(false);
    await expect(page.locator(".v3-runtime-notice")).toHaveText("设置已保存");
    expect(
      await page
        .locator(".v3-runtime-notice")
        .evaluate((element: HTMLElement) => getComputedStyle(element).animationName),
    ).not.toBe("none");
  }
});

test("真实采集语境按字段隐藏，当前页不空白且重开及恢复不改变事实", async ({
  extension,
}) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  const sentence = "A resilient reader keeps a quiet notebook beside the window.";
  const server = await readingServer(
    `<!doctype html><title>字段显示验收</title><style>body{margin:48px;font:22px/1.9 Georgia}</style><p>${sentence}</p>`,
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await pickWord(reading, "resilient");
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect.poll(async () => (await facts(manager)).encounters.length).toBe(1);
    await closeNativePanel(panel);
    await manager.reload();
    await navigate(manager, "我的词库");
    const card = manager.getByRole("article", { name: "单词词卡" });
    const contextTab = card.getByRole("button", { name: /^语境(?: \d+)?$/ });
    await contextTab.click();
    await expect(card.locator("blockquote")).toHaveText(sentence);
    const before = await facts(manager);
    const unchanged = async () => {
      const current = await facts(manager);
      for (const key of [
        "words",
        "encounters",
        "reviews",
        "practice",
        "notebooks",
      ] as const)
        expect(current[key]).toEqual(before[key]);
    };

    await card.getByRole("button", { name: "词卡显示设置", exact: true }).click();
    const dialog = manager.getByRole("dialog", { name: "词卡显示设置" });
    await dialog.getByRole("checkbox", { name: "我的阅读语境", exact: true }).uncheck();
    await dialog.getByRole("button", { name: "保存词卡设置", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(contextTab).toHaveCount(0);
    await expect(card.getByText(sentence, { exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "释义", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(card.locator(".lm-sense").first()).toBeVisible();
    await unchanged();
    await manager.reload();
    // load 只代表入口文件已载入；词库和词条分片仍会异步读取。
    // 先确认实际词卡已出现、读取结束，再检查隐藏字段，避免空 DOM 提前通过。
    await expect(
      card.getByRole("heading", { name: "resilient", exact: true }),
    ).toBeVisible();
    await expect(card.getByText("正在读取词条…", { exact: true })).toHaveCount(0);
    await expect(contextTab).toHaveCount(0);
    await expect(card.locator(".lm-sense").first()).toBeVisible();
    await unchanged();

    await navigate(manager, "设置");
    await manager.getByLabel("词卡密度").selectOption("complete");
    await dialog.getByRole("button", { name: "保存词卡设置", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await navigate(manager, "我的词库");
    await contextTab.click();
    await expect(card.locator("blockquote")).toHaveText(sentence);
    await unchanged();
  } finally {
    await server.close();
  }
});

test("非法采集设置保留草稿且再次保存不误报成功，修正后保存真实政策", async ({
  extension,
}) => {
  const page = await workspace(extension);
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  await navigate(page, "设置");
  const days = page.getByLabel("相同语境去重天数", { exact: true });
  const length = page.getByLabel("单句语境长度上限", { exact: true });
  const section = page.getByLabel("采集隐私与重复语境", { exact: true });
  const save = page.getByRole("button", { name: "保存设置", exact: true });
  const storedPolicy = () =>
    page.evaluate(async () => {
      const response = await (globalThis as any).chrome.runtime.sendMessage({
        channel: "leximeet",
        action: "capture-policy",
        data: {},
      });
      if (!response.ok) throw new Error(response.error);
      return response.result;
    });
  const original = await storedPolicy();
  for (const [control, invalid, message] of [
    [days, "1000", "去重天数需为 0–365 的整数"],
    [days, "", "去重天数需为 0–365 的整数"],
    [length, "119.5", "语境长度上限需为 120–2000 的整数"],
  ] as const) {
    await control.fill(invalid);
    await save.click();
    await expect(section.getByRole("alert")).toContainText(message);
    await expect(control).toHaveValue(invalid);
    await expect(page.locator(".v3-runtime-notice")).toHaveCount(0);
    expect(await storedPolicy()).toEqual(original);
    await control.fill(
      String(control === days ? original.duplicateWindowDays : original.contextMaxLength),
    );
    await control.press("Tab");
    await expect(section.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".v3-runtime-notice")).toHaveText("设置已保存");
  }
  await days.fill("14");
  await days.press("Tab");
  await expect.poll(async () => (await storedPolicy()).duplicateWindowDays).toBe(14);
  await save.click();
  await expect(page.locator(".v3-runtime-notice")).toHaveText("设置已保存");
  await page.reload();
  await expect(page.getByLabel("相同语境去重天数", { exact: true })).toHaveValue("14");
});

test("网站列表真实多来源分页、筛选及隐藏状态保留", async ({ extension }) => {
  const servers = await Promise.all(
    Array.from({ length: 7 }, () =>
      readingServer(
        "<!doctype html><title>分页测试</title><p>A reader can return tomorrow.</p>",
      ),
    ),
  );
  try {
    for (const server of servers) {
      const page = await extension.context.newPage();
      await page.goto(server.url);
      await expect(page.locator("leximeet-page-ui .ball")).toBeVisible();
      await expect(page.locator("leximeet-page-ui .page-guide")).toHaveCount(0);
    }
    const manager = await workspace(extension);
    await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
    await navigate(manager, "设置");
    const sites = manager.getByLabel("网站授权列表", { exact: true });
    await expect(sites.locator(".site-row")).toHaveCount(6);
    await expect(sites.getByLabel("网站授权分页")).toContainText("1 / 2 · 7 个网站");
    await sites.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(sites.locator(".site-row")).toHaveCount(1);
    const selected = (await sites.locator(".site-row > span").first().innerText()).trim();
    await sites.getByLabel("查找网站", { exact: true }).fill(selected);
    await expect(sites.locator(".site-row")).toHaveCount(1);
    await expect(sites.getByLabel("网站授权分页")).toContainText("1 / 1 · 1 个网站");
    await sites.getByRole("button", { name: "隐藏悬浮球", exact: true }).click();
    await expect(sites.getByText("悬浮球已隐藏", { exact: true })).toBeVisible();
    await expect(manager.locator(".v3-runtime-notice")).toHaveText("设置已保存");
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});
