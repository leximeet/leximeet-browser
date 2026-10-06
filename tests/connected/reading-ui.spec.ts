import { test, expect, type Page } from "@playwright/test";
import { readingServer } from "../helpers/extension.cjs";
import { captureReadingWorkspace } from "../helpers/reading-workspace";
import type { ConnectedLabSession } from "../../scripts/launch-connected-lab.mjs";
import {
  activeTabUrl,
  addWord,
  facts,
  editWord,
  nativePanel,
  pickWord,
  wordPoint,
} from "../browser/ui-helpers.ts";
import {
  connection,
  desktopQuery,
  disconnectThroughUi,
  independentFacts,
  pairThroughUi,
  withLab,
} from "./helpers.ts";

// 跳过实际教学 UI，业务用例不修改教学数据库或伪造已完成状态。
async function dismissGuide(lab: ConnectedLabSession) {
  const managerSkip = lab.workspace.getByRole("button", {
    name: "跳过引导",
    exact: true,
  });
  const lesson = lab.context
    .pages()
    .find((page) => page.url().endsWith("/tutorial.html"));
  if (lesson) {
    // 两个表面订阅同一教学状态，只操作一个真实入口；重复点击会追逐已消失的按钮。
    const skip = lesson.locator("#lesson-skip");
    await expect(skip).toBeVisible();
    await skip.click();
    await expect(lesson.locator("#lesson-status")).toHaveText(
      "教学已跳过 · 可以在设置重新进入",
    );
    await expect(skip).toBeHidden();
  } else {
    await expect(managerSkip).toBeVisible();
    await managerSkip.click();
  }
  // 后续业务开始前，确认管理页也已收到共享状态，不能靠计时或伪造完成状态。
  await expect(managerSkip).toHaveCount(0);
}

// 只读 Chrome 的真实扩展上下文；普通 sidepanel.html 标签不能满足此断言。
async function nativeContexts(lab: ConnectedLabSession) {
  return lab.worker.evaluate(async () =>
    (globalThis as any).chrome.runtime.getContexts({
      contextTypes: ["SIDE_PANEL"],
    }),
  );
}

async function expectGenericLocalAvatar(page: Page) {
  const user = page.locator(".mg-local-user");
  await expect(user).toContainText("本机使用");
  await expect(user.locator(".local-user-avatar > svg")).toHaveCount(1);
  await expect(user.locator(".local-user-avatar img")).toHaveCount(0);
  await expect(user.locator(".local-user-avatar")).toHaveAttribute("aria-hidden", "true");
}

/**
 * 同一次真实 pointermove 就显示词头，不把 Native 查询耗时算成 hover 停留门槛。
 * 观察器仅记录真实 DOM 变化，不替换浏览器 API、查词接口或产品事件。
 */
async function hoverCard(page: Page, word: string) {
  const point = await wordPoint(page, word);
  const card = page.locator("leximeet-page-ui .card");
  await expect(card).toBeHidden();
  await card.evaluate((element, target) => {
    const sample = { pointerAt: 0, visibleAt: 0, word: "" };
    (globalThis as any).__readingUiHover = sample;
    const begin = (event: PointerEvent) => {
      if (
        !sample.pointerAt &&
        Math.abs(event.clientX - target.x) < 3 &&
        Math.abs(event.clientY - target.y) < 3
      )
        sample.pointerAt = performance.now();
    };
    document.addEventListener("pointermove", begin, {
      passive: true,
      capture: true,
    });
    const observe = new MutationObserver(() => {
      if (sample.pointerAt && !sample.visibleAt && !(element as HTMLElement).hidden) {
        sample.visibleAt = performance.now();
        sample.word = element.querySelector(".word")?.textContent || "";
      }
    });
    observe.observe(element, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    (globalThis as any).__disposeReadingUiHover = () => {
      observe.disconnect();
      document.removeEventListener("pointermove", begin, true);
    };
  }, point);
  try {
    await page.mouse.move(point.x, point.y);
    await expect(card.locator(".word")).toHaveText(word);
    await expect(card).toBeVisible();
    const sample = await page.evaluate(() => (globalThis as any).__readingUiHover);
    expect(sample.pointerAt).toBeGreaterThan(0);
    expect(sample.visibleAt).toBeGreaterThanOrEqual(sample.pointerAt);
    expect(sample.word).toBe(word);
    // 原实现有 600ms 固定停留；新卡先同步显示 surface，保留渲染余量但不能延续旧延迟。
    expect(sample.visibleAt - sample.pointerAt).toBeLessThan(500);
    const button = card.getByRole("button", {
      name: `发音 ${word}`,
      exact: true,
    });
    await expect(button).toBeVisible();
    await expect(card.locator(".card-head .speak")).toHaveCount(1);
    await expect(button.locator("svg")).toHaveCount(1);
    await expect(button).toHaveText("");
    await expect(card.getByRole("button", { name: /^朗读/ })).toHaveCount(0);
    const head = await card.locator(".word").boundingBox();
    const sound = await button.boundingBox();
    expect(head).not.toBeNull();
    expect(sound).not.toBeNull();
    expect(sound!.y + sound!.height / 2).toBeGreaterThanOrEqual(head!.y - 4);
    expect(sound!.y + sound!.height / 2).toBeLessThanOrEqual(head!.y + head!.height + 4);
    return {
      visibleAfterMs: sample.visibleAt - sample.pointerAt,
      titlePronunciationButton: true,
    };
  } finally {
    await page.evaluate(() => (globalThis as any).__disposeReadingUiHover?.());
  }
}

async function encounterAndTogglePanel(lab: ConnectedLabSession, word: string) {
  const page = lab.reading;
  await page.bringToFront();
  const ball = page.locator("leximeet-page-ui .ball");
  await expect(ball).toBeVisible();
  // 跳过教学后，独立、连接和恢复归属的普通网页均不能创建空指引。
  await expect(page.locator("leximeet-page-ui .page-guide")).toHaveCount(0);
  await expect(ball).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => nativeContexts(lab)).toHaveLength(0);
  await ball.click();
  await expect(ball).toHaveAttribute("aria-busy", "false");
  await expect(ball).toHaveAttribute("aria-pressed", "true");
  const hover = await hoverCard(page, word);
  await ball.click();
  await expect(ball).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("leximeet-page-ui .card")).toBeHidden();
  await ball.click({ button: "right" });
  const panel = await nativePanel(lab.context);
  await expect(panel.getByRole("button", { name: "遇见", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "采集", exact: true })).toBeVisible();
  await expect.poll(() => nativeContexts(lab)).toHaveLength(1);
  await expect(ball).toBeVisible();
  await expect.poll(() => activeTabUrl(lab.worker)).toBe(page.url());
  // 两次独立右键手势越过产品防抖，第二次必须关闭真实侧栏，不能跳去管理页。
  await page.waitForTimeout(350);
  await ball.click({ button: "right" });
  await expect.poll(() => nativeContexts(lab)).toHaveLength(0);
  await expect(ball).toBeVisible();
  await expect.poll(() => activeTabUrl(lab.worker)).toBe(page.url());
  return hover;
}

// 采词只操作真实页面坐标和产品浮球，松手之后才核对正式事实。
async function dragCollect(lab: ConnectedLabSession, word: string) {
  const page = lab.reading;
  await page.bringToFront();
  const ball = page.locator("leximeet-page-ui .ball");
  await expect(ball).toBeVisible();
  // 原生侧栏展开会重排正文；先等待真实段落稳定，再从当前 Range 取点，不能复用展开前坐标。
  await page
    .locator("p")
    .filter({ hasText: new RegExp("\\b" + word + "\\b", "i") })
    .first()
    .scrollIntoViewIfNeeded();
  await ball.hover();
  const target = await wordPoint(page, word);
  await page.mouse.down();
  try {
    await page.mouse.move(target.x, target.y, { steps: 10 });
    await expect(page.locator("leximeet-page-ui .collector-card .word")).toHaveText(word);
    await expect(page.locator("leximeet-page-ui .word-collector")).toHaveAttribute(
      "data-word",
      word,
    );
    await expect(page.locator("leximeet-page-ui .word-target span")).toHaveCount(1);
  } finally {
    await page.mouse.up();
  }
  await expect(ball).toHaveAttribute("aria-busy", "false");
}

test("真实双端 UI：独立头像、立即悬停发音入口、连接及断开前后浮球右键开关侧栏", async ({}, info) => {
  await withLab(info, async (lab) => {
    await dismissGuide(lab);
    await expectGenericLocalAvatar(lab.workspace);
    await addWord(lab.workspace, "resilient");
    // 新编辑路径写入真实个人事实；连接期间封存，明确断开后笔记和多本关联原样恢复。
    for (const name of ["阅读练习", "考试复习"]) {
      await lab.workspace
        .getByRole("button", { name: "新建单词本", exact: true })
        .click();
      const dialog = lab.workspace.getByRole("dialog", { name: "新建单词本" });
      await dialog.getByLabel("单词本名称", { exact: true }).fill(name);
      await dialog.getByRole("button", { name: "保存单词本", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    await editWord(lab.workspace, "resilient");
    const edit = lab.workspace.getByRole("dialog", { name: "编辑个人内容" });
    await edit.getByLabel("我的笔记").fill("独立笔记和两个单词本");
    for (const name of ["阅读练习", "考试复习"])
      await edit.getByRole("checkbox", { name, exact: true }).check();
    await edit.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(edit).toHaveCount(0);
    const personal = (await facts(lab.workspace)).words[0];
    expect(personal.note).toBe("独立笔记和两个单词本");
    expect(personal.notebookIds).toHaveLength(3);
    const original = independentFacts(await facts(lab.workspace));
    await lab.desktopPage!.evaluate(() =>
      (globalThis as any).leximeet.desktopCommand({
        action: "collect",
        word: "resilient",
        note: "Desktop 独立 B",
      }),
    );
    const independent = await encounterAndTogglePanel(lab, "resilient");
    await pairThroughUi(lab, "desktop");
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    const connected = await encounterAndTogglePanel(lab, "resilient");
    await lab.workspace.bringToFront();
    await disconnectThroughUi(lab.workspace);
    await expect
      .poll(() => connection(lab.workspace))
      .toMatchObject({ mode: "independent", status: "independent" });
    await expectGenericLocalAvatar(lab.workspace);
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    const restored = await encounterAndTogglePanel(lab, "resilient");
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    lab.evidence.nativePanel = true;
    lab.evidence.readingUi = {
      genericLocalAvatar: true,
      independent,
      connected,
      restored,
      actualSidePanelAcrossOwners: true,
      floatingBallVisibleWithPanel: true,
      rightClickClosesWithoutManagerNavigation: true,
      standaloneFactsUnchanged: true,
    };
    await info.attach("reading-ui-connected", {
      body: Buffer.from(JSON.stringify(lab.evidence.readingUi, null, 2)),
      contentType: "application/json",
    });
  });
});

test("真实连接遇见按词归并：Node重复/The大小写一行，同句重复不写B，不同句仍保留", async ({}, info) => {
  await withLab(info, async (lab) => {
    await dismissGuide(lab);
    for (const word of ["node", "the", "system"]) {
      await addWord(lab.workspace, word);
      await lab.desktopPage!.evaluate(
        (word) =>
          (globalThis as any).leximeet.desktopCommand({ action: "collect", word }),
        word,
      );
    }
    const original = independentFacts(await facts(lab.workspace));
    await pairThroughUi(lab, "plugin");
    await expect(
      lab.desktopPage!.getByRole("region", { name: "插件连接设置" }),
    ).toBeVisible();
    await lab.desktopPage!.screenshot({
      path: info.outputPath("usage-connected-settings.png"),
      animations: "disabled",
    });
    const server = await readingServer(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Connected reading example</title><style>body{margin:0;background:#f5f6f3;color:#26352f;font:20px/1.8 Georgia}main{max-width:720px;margin:48px auto;padding:36px;background:white;border:1px solid #dfe5dd;border-radius:12px}h1{font-size:34px;line-height:1.25}small{font:13px/1.4 system-ui;color:#6c7a71}p{margin:24px 0}</style><main><small>ENGLISH READING · 本地示例文章</small><h1>A useful reading habit</h1><p>Node uses the system.</p><p>Node uses the system.</p><p>The system helps the reader and Node learns.</p><h2>Keep your words together</h2><p>Collect a useful sentence in your desktop notebook. Continue learning in the desktop application.</p></main></html>',
    );
    try {
      await lab.reading.goto(server.url);
      const panel = await lab.openPanel();
      await panel.getByRole("button", { name: "分析本页", exact: true }).click();
      await expect(panel.locator(".lm-row")).toHaveCount(3);
      expect(
        (await panel.locator(".lm-row strong").allTextContents())
          .map((x) => x.toLowerCase())
          .sort(),
      ).toEqual(["node", "system", "the"]);
      await panel.screenshot({
        path: info.outputPath("connected-word-list-deduplicated.png"),
      });
      await captureReadingWorkspace(
        lab.reading,
        panel,
        info.outputPath("usage-connected-workspace.png"),
      );
      expect((await desktopQuery(lab, { kind: "encounters" })).total).toBe(0);
      await panel.getByRole("button", { name: "采集", exact: true }).click();
      await pickWord(lab.reading, "Node", 0);
      await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
      await expect
        .poll(async () => (await desktopQuery(lab, { kind: "encounters" })).total)
        .toBe(1);
      for (const [position, count] of [
        [1, 1],
        [2, 2],
      ] as const) {
        await panel.getByRole("button", { name: "开始采集", exact: true }).click();
        await pickWord(lab.reading, "Node", position);
        await expect(panel.locator(".lm-row")).toHaveCount(1);
        await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
        await expect(
          panel.getByRole("button", { name: "开始采集", exact: true }),
        ).toBeVisible();
        expect((await desktopQuery(lab, { kind: "encounters" })).total).toBe(count);
      }
      expect(independentFacts(await facts(lab.workspace))).toEqual(original);
      const encounters = (await desktopQuery(lab, { kind: "encounters" })).encounters;
      expect(new Set(encounters.map((item: any) => item.context)).size).toBe(2);
      expect(new Set(encounters.map((item: any) => item.word.toLowerCase()))).toEqual(
        new Set(["node"]),
      );
      // 浏览器的真实采集落入 Desktop 后，再走桌面导航核对可见记录；不注入展示状态。
      await lab
        .desktopPage!.getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "遇见记录", exact: true })
        .click();
      await expect(lab.desktopPage!.locator(".encounter-list li")).toHaveCount(2);
      await expect(lab.desktopPage!.locator(".encounter-list")).toContainText(
        "Node uses the system.",
      );
      await expect(lab.desktopPage!.locator(".encounter-list")).toContainText(
        "The system helps the reader and Node learns.",
      );
      await lab.desktopPage!.screenshot({
        path: info.outputPath("usage-connected-desktop-encounters.png"),
        animations: "disabled",
      });
      lab.evidence.nativePanel = true;
      lab.evidence.readingWordGrouping = {
        rows: 3,
        sameSentenceEncounters: 1,
        differentSentences: 2,
        independentFactsUnchanged: true,
      };
    } finally {
      await server.close();
    }
  });
});

test("真实双端采集 UI：侧栏打开仍可浮球采词，两种采集只写桌面，断开恢复独立 A", async ({}, info) => {
  await withLab(info, async (lab) => {
    await dismissGuide(lab);
    await addWord(lab.workspace, "network");
    await dragCollect(lab, "resilient");
    await expect.poll(async () => (await facts(lab.workspace)).encounters.length).toBe(1);
    const original = independentFacts(await facts(lab.workspace));
    expect(original.encounters[0].surface).toBe("resilient");
    await lab.desktopPage!.evaluate(() =>
      (globalThis as any).leximeet.desktopCommand({
        action: "collect",
        word: "system",
        note: "Desktop 原有 B 必须保留",
      }),
    );
    await pairThroughUi(lab, "plugin");
    expect(
      (await desktopQuery(lab, { scope: "manual", search: "network" })).words,
    ).toHaveLength(0);
    expect((await desktopQuery(lab, { kind: "encounters" })).total).toBe(0);
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    const panel = await lab.openPanel();
    await expect(lab.reading.locator("leximeet-page-ui .ball")).toBeVisible();
    await dragCollect(lab, "resilient");
    await expect
      .poll(async () => (await desktopQuery(lab, { kind: "encounters" })).total)
      .toBe(1);
    await expect.poll(() => nativeContexts(lab)).toHaveLength(1);
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    await pickWord(lab.reading, "operation");
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    await expect(panel.locator(".lm-detail h2")).toHaveText("operation");
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect
      .poll(async () => (await desktopQuery(lab, { kind: "encounters" })).total)
      .toBe(2);
    const captured = (await desktopQuery(lab, { kind: "encounters" })).encounters;
    expect(captured.map((item: any) => item.word).sort()).toEqual([
      "operation",
      "resilient",
    ]);
    for (const item of captured) {
      expect(item.context).toContain(item.word);
      expect(item.sourceUrl).toBe(lab.url);
    }
    expect(
      (await desktopQuery(lab, { scope: "manual", search: "system" })).words[0]?.note,
    ).toBe("Desktop 原有 B 必须保留");
    expect(
      (await desktopQuery(lab, { scope: "manual", search: "network" })).words,
    ).toHaveLength(0);
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    // 最后一条草稿加入成功后会自动结束，确认真实采集已退出再切回管理页。
    await expect(
      panel.getByRole("button", { name: "开始采集", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toHaveCount(0);
    await lab.workspace.bringToFront();
    await disconnectThroughUi(lab.workspace);
    await expect
      .poll(() => connection(lab.workspace))
      .toMatchObject({ mode: "independent", status: "independent" });
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    expect((await desktopQuery(lab, { kind: "encounters" })).total).toBe(2);
    await expectGenericLocalAvatar(lab.workspace);
    await expect(lab.reading.locator("leximeet-page-ui .ball")).toBeVisible();
    lab.evidence.readingUiCapture = {
      independentFloatActuallySavedA: true,
      noImportOfA: true,
      floatVisibleWithRealPanel: true,
      connectedFloatAndPanelBothWriteDesktop: true,
      originalBPreserved: true,
      independentAFrozen: true,
      explicitDisconnectRestoresA: true,
      desktopBCRemainsDesktop: true,
    };
    await info.attach("reading-ui-capture-connected", {
      body: Buffer.from(JSON.stringify(lab.evidence.readingUiCapture, null, 2)),
      contentType: "application/json",
    });
  });
});
