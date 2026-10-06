import { activeTabUrl } from "./ui-helpers";
import { test, expect } from "./fixtures";
import { readingServer } from "../helpers/extension.cjs";
import { workspace, facts, wordPoint, nativePanel } from "./ui-helpers";

// 不调用工具栏、不打开侧栏：验证安装后的常驻入口与真实 Range、真实词典/IndexedDB。
test("悬浮采词：默认入口、收集器单词选择、松手落盘、取消和非正文不保存", async ({
  extension,
}, info) => {
  const server = await readingServer(
    '<!doctype html><meta charset="utf-8"><title>Collector reading</title><style>body{margin:40px;font:22px/1.9 Georgia}p{width:650px}</style><p id="text">📚 A res<em>ilient</em> reader returns. A careful learner reads a book.</p><p contenteditable="true">editorsecret</p><pre>codesecret</pre><button>Site action</button><p><a id="site-link" href="#moved">resource</a></p>',
  );
  try {
    const manager = await workspace(extension);
    await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const ball = reading.locator("leximeet-page-ui .ball");
    await expect(ball).toBeVisible();
    expect(
      await extension.worker.evaluate(() =>
        (globalThis as any).chrome.runtime.getContexts({
          contextTypes: ["SIDE_PANEL"],
        }),
      ),
    ).toHaveLength(0);
    // 真正停止 Worker，再由第一次拖拽恢复；不刷新网页、不先点工具栏。
    const cdp = await extension.context.newCDPSession(manager);
    await cdp.send("ServiceWorker.enable");
    const target = (await cdp.send("Target.getTargets")).targetInfos.find(
      (item) => item.type === "service_worker" && item.url === extension.worker.url(),
    );
    expect(target).toBeTruthy();
    await extension.worker.evaluate(() => {
      (globalThis as any).__collectorBeforeStop = true;
    });
    await cdp.send("ServiceWorker.stopAllWorkers");
    await expect
      .poll(async () =>
        (await cdp.send("Target.getTargets")).targetInfos.some(
          (item) => item.targetId === target!.targetId,
        ),
      )
      .toBe(false);
    await cdp.detach();
    const original = await reading.locator("#text").evaluate((el) => el.outerHTML);
    const p = await reading.locator("#text em").boundingBox();
    await ball.hover();
    const origin = await ball.boundingBox();
    await reading.mouse.down();
    await reading.mouse.move(p!.x + 4, p!.y + 8, { steps: 10 });
    await expect(ball).toHaveClass(/collector-active/);
    const preview = reading.locator("leximeet-page-ui .collector-card");
    await expect(preview.locator(".word")).toHaveText("resilient");
    await expect(preview.locator(".meaning")).toContainText("弹性");
    const collector = reading.locator("leximeet-page-ui .word-collector");
    await expect(collector).toBeVisible();
    await expect(collector).toHaveAttribute("data-word", "resilient");
    await expect(reading.locator("leximeet-page-ui .word-magnifier")).toHaveCount(0);
    // 不放大文字；跨内联元素的同一个词仍只有一圈选择框，原网页字体不变。
    await expect(reading.locator("#text em")).toHaveCSS("font-style", "italic");
    await expect(reading.locator("#text")).toHaveCSS("font-size", "22px");
    const outline = reading.locator("leximeet-page-ui .word-target");
    await expect(outline.locator("span")).toHaveCount(1);
    await expect(outline.locator("span")).toHaveCSS("border-width", "2px");
    const source = await reading.locator("#text").evaluate((el) => {
      const r = document.createRange();
      r.setStart(el.firstChild!, el.firstChild!.textContent!.indexOf("res"));
      r.setEnd(el.querySelector("em")!.firstChild!, "ilient".length);
      return r.getBoundingClientRect().toJSON();
    });
    const edge = (await outline.locator("span").boundingBox())!;
    const small = (await collector.boundingBox())!;
    expect(small.width).toBe(32);
    expect(small.height).toBe(32);
    expect(edge.x).toBeCloseTo(source.x - 3, 0);
    expect(edge.width).toBeCloseTo(source.width + 6, 0);
    expect(small.y >= edge.y + edge.height || small.y + small.height <= edge.y).toBe(
      true,
    );
    await reading.screenshot({
      path: info.outputPath("collector-preview-light.png"),
    });
    // 移过相邻词时只有当前一词被选中，未松手不能提前保存。
    const other = await wordPoint(reading, "reader");
    await reading.mouse.move(other.x, other.y, { steps: 8 });
    await expect(preview.locator(".word")).toHaveText("reader");
    await expect(collector).toHaveAttribute("data-word", "reader");
    await expect(outline.locator("span")).toHaveCount(1);
    await reading.mouse.move(p!.x + 4, p!.y + 8, { steps: 8 });
    await expect(preview.locator(".word")).toHaveText("resilient");
    expect(
      await extension.worker.evaluate(() => (globalThis as any).__collectorBeforeStop),
    ).toBeUndefined();
    // 停留超过旧提示框收起时间，预览仍在；这里只验证持续按住，不增加超时预算。
    await reading.waitForTimeout(350);
    await expect(preview).toBeVisible();
    expect((await facts(manager)).encounters).toHaveLength(0);
    await reading.mouse.up();
    await expect(preview).toBeHidden();
    await expect(outline).toBeHidden();
    await expect(collector).toBeHidden();
    await expect(ball).toHaveAttribute("aria-busy", "false");
    await expect(reading.locator("leximeet-page-ui .notice")).toHaveText(
      "已将 resilient 加入单词本",
    );
    await expect.poll(async () => (await facts(manager)).encounters.length).toBe(1);
    let data = await facts(manager);
    expect(data.encounters[0].originalSentence).toBe("📚 A resilient reader returns.");
    expect(data.encounters[0].occurrenceRanges).toEqual([{ start: 5, end: 14 }]);
    expect(data.words[0].notebookIds).toHaveLength(1);
    expect(data.encounters[0].source.url).toBe(server.url + "/");
    expect(
      await ball.evaluate((el) => parseFloat((el as HTMLElement).style.top)),
    ).toBeCloseTo(origin!.y, 0);
    expect(await reading.locator("#text").evaluate((el) => el.outerHTML)).toBe(original);
    // 系统深色下选择框与收集篮仍可用，原网页排版和字形不受影响。
    await reading.emulateMedia({ colorScheme: "dark" });
    // Esc 取消与空白松开不产生事实，也不能误触发一次遇见分析。
    await ball.hover();
    await reading.mouse.down();
    await reading.mouse.move(p!.x + 4, p!.y + 8, { steps: 10 });
    await expect(preview).toBeVisible();
    await expect(collector).toHaveClass(/ready/);
    await expect(outline.locator("span")).toHaveCSS("border-color", "rgb(40, 137, 207)");
    await reading.screenshot({
      path: info.outputPath("collector-preview-dark.png"),
    });
    await reading.keyboard.press("Escape");
    await reading.mouse.up();
    await expect(preview).toBeHidden();
    await ball.hover();
    await reading.mouse.down();
    await reading.mouse.move(p!.x + 4, p!.y + 8, { steps: 10 });
    await expect(outline).toBeVisible();
    await reading.mouse.move(500, 500, { steps: 10 });
    await expect(outline).toBeHidden();
    await expect(preview).toBeHidden();
    await reading.mouse.up();
    await expect(ball).toHaveAttribute("aria-pressed", "false");
    for (const selector of ["[contenteditable]", "pre", "button"]) {
      const rect = await reading.locator(selector).first().boundingBox();
      await ball.hover();
      await reading.mouse.down();
      await reading.mouse.move(rect!.x + 90, rect!.y + 8, { steps: 10 });
      await expect(preview).toBeHidden();
      await reading.mouse.up();
    }
    const link = reading.locator("#site-link");
    const linkRect = await link.boundingBox();
    await ball.hover();
    await reading.mouse.down();
    await reading.mouse.move(linkRect!.x + linkRect!.width / 2, linkRect!.y + 8, {
      steps: 10,
    });
    await expect(preview.locator(".word")).toHaveText("resource");
    await reading.keyboard.press("Escape");
    await reading.mouse.up();
    expect(reading.url()).not.toContain("#moved");
    await link.click();
    await expect(reading).toHaveURL(/#moved$/);
    expect((await facts(manager)).encounters).toEqual(data.encounters);
    await reading.reload();
    await expect(ball).toBeVisible();
    await manager.reload();
    expect((await facts(manager)).encounters).toEqual(data.encounters);
    await reading.bringToFront();
    await ball.click({ button: "right" });
    const panel = await nativePanel(extension.context);
    await expect(panel.getByRole("button", { name: "遇见", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "采集", exact: true })).toBeVisible();
    await expect(ball).toBeVisible();
    // Chromium 调试页的 visibilityState 不代表原生选中标签；读取真实 tabs 状态。
    await expect.poll(() => activeTabUrl(extension.worker)).toBe(reading.url());
    expect((await facts(manager)).encounters).toEqual(data.encounters);
    expect(
      await extension.worker.evaluate(() =>
        (globalThis as any).chrome.runtime.getContexts({
          contextTypes: ["SIDE_PANEL"],
        }),
      ),
    ).toHaveLength(1);
    await info.attach("floating-collector-evidence", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          defaultEntryWithoutPanel: true,
          workerActuallyRestarted: true,
          collectorSize: small.width,
          noMagnifier: true,
          sourceFontUnchanged: true,
          preciseSingleWordOutline: true,
          collectorDoesNotCoverTarget: true,
          releaseOnlySave: true,
          savedRange: data.encounters[0].occurrenceRanges,
          cancelAndBlankKeepFacts: true,
          sourceDomUnchanged: true,
          rightClickOpensNativePanel: true,
          nativePanels: 1,
        }),
      ),
    });
  } finally {
    await server.close();
  }
});
