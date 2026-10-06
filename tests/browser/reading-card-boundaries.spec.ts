import { test, expect } from "./fixtures";
import { readingServer } from "../helpers/extension.cjs";
import { audioFixture } from "../helpers/audio-fixture";
import { workspace, addWord, wordPoint, pickWord, facts } from "./ui-helpers";

test("底部词的长词卡按实际高度放置，明暗主题的采集按钮可真实操作", async ({
  extension,
}, info) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  await addWord(manager, "resilient");
  const sentence =
    "A thoughtful reader reviews useful words and remembers each context ".repeat(8) +
    "resilient.";
  const server = await readingServer(
    `<!doctype html><meta charset="utf-8"><title>Bottom word card</title><style>body{margin:40px;font:22px/1.8 Georgia}p{position:absolute;left:60px;right:60px;bottom:20px;margin:0}</style><p>${sentence}</p>`,
  );
  try {
    const page = await extension.context.newPage();
    await page.goto(server.url);
    const ball = page.locator("leximeet-page-ui .ball");
    await expect(ball).toBeVisible();
    await ball.click();
    await expect(ball).toHaveAttribute("aria-pressed", "true");
    const point = await wordPoint(page, "resilient");
    await page.mouse.move(point.x, point.y);
    const card = page.locator("leximeet-page-ui .card");
    await expect(card).toBeVisible();
    await expect(card.locator(".meaning")).not.toHaveAttribute("aria-busy", "true");
    await page.screenshot({ path: info.outputPath("bottom-card-light.png") });
    const position = await card.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        viewport: document.documentElement.clientHeight,
      };
    });
    expect(position.height).toBeGreaterThan(240);
    expect(position.top).toBeGreaterThanOrEqual(12);
    expect(position.bottom).toBeLessThanOrEqual(position.viewport - 12);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: info.outputPath("bottom-card-dark.png") });
    const capture = card.getByRole("button", {
      name: "采集 resilient",
      exact: true,
    });
    await capture.click();
    await expect(capture).toHaveText("已采集");
    await expect.poll(async () => (await facts(manager)).encounters.length).toBe(1);
    const bounds = await capture.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(position.viewport - 12);
  } finally {
    await server.close();
  }
});

test("先选前词再悬停后词，S键真实音频请求只朗读当前悬停词", async ({
  extension,
}, info) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  await addWord(manager, "resilient");
  await addWord(manager, "system");
  const server = await readingServer(
    '<!doctype html><meta charset="utf-8"><title>Hovered word speech</title><style>body{margin:60px;font:24px/2 Georgia}p{max-width:650px}</style><p>A resilient reader keeps a useful system.</p>',
  );
  try {
    const page = await extension.context.newPage();
    const words: string[] = [];
    await page.route("https://dict.youdao.com/dictvoice?*", async (route) => {
      words.push(new URL(route.request().url()).searchParams.get("audio") || "");
      await route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: audioFixture(),
      });
    });
    await page.goto(server.url);
    const ball = page.locator("leximeet-page-ui .ball");
    await expect(ball).toBeVisible();
    await ball.click();
    await expect(ball).toHaveAttribute("aria-pressed", "true");
    await pickWord(page, "resilient");
    const point = await wordPoint(page, "system");
    await page.mouse.move(point.x, point.y);
    const card = page.locator("leximeet-page-ui .card");
    await expect(card.locator(".word")).toHaveText("system");
    await card.focus();
    await page.keyboard.press("s");
    await expect.poll(() => words).toEqual(["system"]);
    await page.screenshot({ path: info.outputPath("hovered-word-speech.png") });
  } finally {
    await server.close();
  }
});
