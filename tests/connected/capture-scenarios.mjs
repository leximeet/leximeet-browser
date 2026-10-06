import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// 两条真实驱动共用业务断言：不导入 Playwright，不替换产品 API。
function readDatabase(lab, read) {
  const db = new DatabaseSync(path.join(lab.profileDir, "core/leximeet.sqlite"), {
    readOnly: true,
  });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
export function captureRows(lab) {
  return readDatabase(lab, (db) =>
    db
      .prepare(
        `SELECT e.id AS eventId,w.word,w.note,
    e.source_url AS sourceUrl,d.original_sentence AS originalSentence,d.source_type AS sourceKind,
    i.payload AS wordRef,entity.payload AS eventEntity
    FROM encounters e JOIN words w ON w.id=e.word_id
    JOIN encounter_details d ON d.encounter_id=e.id
    JOIN desktop_word_identity i ON i.word_id=e.word_id
    JOIN desktop_entities entity ON entity.entity_type='encounter' AND entity.entity_id=e.id
    ORDER BY e.id`,
      )
      .all()
      .map((row) => ({
        ...row,
        wordRef: JSON.parse(row.wordRef),
        eventEntity: JSON.parse(row.eventEntity),
      })),
  );
}
function membership(lab, bookId) {
  return readDatabase(lab, (db) =>
    db
      .prepare(
        "SELECT w.word FROM word_books wb JOIN words w ON w.id=wb.word_id WHERE wb.book_id=? ORDER BY w.word",
      )
      .all(bookId)
      .map((row) => row.word),
  );
}
function invitationStates(lab) {
  // 仅读取脱敏状态，不取票据哈希、secret 或配对 credential。
  return readDatabase(lab, (db) =>
    db
      .prepare(
        "SELECT json_extract(value,'$.state') AS state FROM lmcp_meta WHERE key LIKE 'invitation:%'",
      )
      .all()
      .map((row) => row.state),
  );
}
async function draftIds(lab) {
  return lab.workspace.evaluate(async () => {
    const { standaloneDrafts = {} } =
      await chrome.storage.session.get("standaloneDrafts");
    return Object.values(standaloneDrafts)
      .flat()
      .map((draft) => draft.eventId)
      .sort();
  });
}
async function captureNotificationCount(lab) {
  return lab.desktopPage.evaluate(async () => {
    const snapshot = (await window.leximeet.runtime()).pluginCaptureNotifications;
    if (!snapshot || !Number.isSafeInteger(snapshot.sentCount))
      throw new Error("当前 Desktop 没有插件采集通知统计，不能跳过本轮验证");
    return snapshot.sentCount;
  });
}
async function captureNotificationSetting(lab, enabled, expect) {
  const page = lab.desktopPage;
  await page.locator('[data-guide="nav-settings"]').click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "采集与快捷键", exact: true })
    .click();
  const checkbox = page.getByRole("checkbox", {
    name: "插件采集成功通知",
    exact: true,
  });
  await checkbox.setChecked(enabled);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.leximeet.desktopState()).settings
            .pluginCaptureNotificationsEnabled,
      ),
    )
    .toBe(enabled);
}
async function seedA(lab, expect) {
  const manager = lab.workspace;
  const skip = manager.getByRole("button", { name: "跳过引导", exact: true });
  if (await skip.count()) await skip.click();
  await manager
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: /^我的词库/ })
    .click();
  await manager.getByRole("button", { name: "添加单词", exact: true }).click();
  const dialog = manager.getByRole("dialog", { name: "查词与添加" });
  await dialog.getByRole("textbox", { name: "输入英文单词" }).fill("network");
  await expect(
    dialog.getByRole("heading", { name: "network", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "加入我的词库", exact: true }).click();
  // 点击回执并不代表异步保存已经结束；确认真实 Dialog 已关闭后再封存 A。
  await expect(dialog).toHaveCount(0);
}
async function seedB(lab, prepareDesktopSettings) {
  await prepareDesktopSettings(lab);
  return lab.desktopPage.evaluate(async () => {
    await window.leximeet.desktopCommand({
      action: "collect",
      word: "system",
      note: "桌面已有笔记 B，采集不能覆盖",
    });
    await window.leximeet.desktopCommand({
      action: "collect",
      word: "leximeetnovelword",
      note: "已有自定义笔记 B",
    });
    const state = await window.leximeet.desktopCommand({
      action: "createBook",
      name: "连接采集验收",
    });
    const book = state.books.find((book) => book.name === "连接采集验收");
    if (!book) throw new Error("真实 Desktop 未创建单词本");
    return book.id;
  });
}
async function beginCapture(panel, expect) {
  await panel.getByRole("button", { name: "采集", exact: true }).click();
  // 本轮产品点击采集标签即开始；不能用第二次点开始掩盖入口丢失意图。
  await expect(
    panel.getByRole("button", { name: "结束采集", exact: true }),
  ).toBeVisible();
}
async function point(lab, locator, expect) {
  await locator.scrollIntoViewIfNeeded();
  const rectangle = await locator.boundingBox();
  expect(rectangle).not.toBeNull();
  return {
    x: rectangle.x + rectangle.width / 2,
    y: rectangle.y + rectangle.height / 2,
  };
}
async function dragWord(lab, locator, expect, surface) {
  await lab.reading.bringToFront();
  const destination = await point(lab, locator, expect);
  const ball = lab.reading.locator("leximeet-page-ui .ball");
  await expect(ball).toBeVisible();
  await ball.hover();
  await lab.reading.mouse.down();
  await lab.reading.mouse.move(destination.x, destination.y, { steps: 12 });
  await expect(lab.reading.locator("leximeet-page-ui .collector-card .word")).toHaveText(
    surface,
  );
  await lab.reading.mouse.up();
  await expect(lab.reading.locator("leximeet-page-ui .notice")).toContainText(
    /已将.+加入单词本/,
  );
}
function assertRow(row, lab, expect) {
  expect(row.sourceKind).toBe("web");
  expect(row.sourceUrl).toBe(lab.reading.url());
  expect(row.eventEntity.word).toEqual(row.wordRef);
  expect(row.eventEntity.source).toMatchObject({
    kind: "web",
    url: lab.reading.url(),
  });
  expect(row.originalSentence).toBe(row.eventEntity.originalSentence);
  expect(row.eventEntity.occurrenceRanges).not.toHaveLength(0);
  for (const range of row.eventEntity.occurrenceRanges)
    expect(row.originalSentence.slice(range.start, range.end)).toBe(
      row.eventEntity.surface,
    );
  if (row.wordRef.kind === "dictionary") {
    expect(row.wordRef).toMatchObject({
      release: "0.0.3",
      entrySchema: "leximeet.entry.v2",
    });
    expect(row.wordRef.entryId).toMatch(/^[a-f0-9-]{36}$/);
  } else {
    expect(row.wordRef).toMatchObject({
      kind: "custom",
      headword: "leximeetnovelword",
      language: "en",
    });
    expect(row.wordRef.customId).toMatch(/^[a-f0-9-]{36}$/);
  }
}

export function registerCaptureScenarios(test, expect, helpers) {
  const {
    withLab,
    pairThroughUi,
    connection,
    independentFacts,
    facts,
    desktopQuery,
    prepareDesktopSettings,
    disconnectThroughUi,
    requestInvitation,
    invitationPopup,
  } = helpers;

  test("旧页面与原侧栏切换归属：目标、非目标与自定义词的原句、笔记、单词本和WordRef保留", async ({}, info) => {
    await withLab(info, async (lab) => {
      await seedA(lab, expect);
      const panel = await lab.openPanel();
      await panel.getByRole("button", { name: "分析本页", exact: true }).click();
      await expect(panel.getByRole("region", { name: "遇见单词列表" })).toContainText(
        /network/i,
      );
      await info.attach("独立模式已分析网页", {
        body: await lab.reading.screenshot(),
        contentType: "image/png",
      });
      const original = independentFacts(await facts(lab.workspace));
      const bookId = await seedB(lab, prepareDesktopSettings);
      expect(
        await lab.desktopPage.evaluate(
          async () =>
            (await window.leximeet.desktopState()).settings
              .pluginCaptureNotificationsEnabled,
        ),
      ).toBe(true);
      const noticesBefore = await captureNotificationCount(lab);
      await pairThroughUi(lab);
      // 保持同一 document 和同一 SIDE_PANEL，不以重载或关闭重开规避归属切换。
      await expect(panel.getByRole("contentinfo", { name: "运行状态" })).toContainText(
        "已连接桌面端",
      );
      await beginCapture(panel, expect);
      for (const selector of ["mixed-case-word", "target-word", "unknown-word"])
        await lab.reading.getByTestId(selector).click();
      await expect(panel.locator(".lm-row")).toHaveCount(3);
      await panel
        .getByRole("combobox", { name: "选择单词本", exact: true })
        .selectOption(bookId);
      await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
      await expect(
        panel.getByRole("status").filter({ hasText: "已将 3 条语境加入单词本" }),
      ).toBeVisible();
      await expect.poll(() => captureRows(lab).length).toBe(3);
      await expect.poll(() => captureNotificationCount(lab)).toBe(noticesBefore + 3);
      for (const row of captureRows(lab)) {
        assertRow(row, lab, expect);
        expect(row.originalSentence).toContain(
          "🙂 Resilient SYSTEM, network and leximeetnovelword",
        );
      }
      expect(
        membership(lab, bookId)
          .map((word) => word.toLowerCase())
          .sort(),
      ).toEqual(["leximeetnovelword", "resilient", "system"]);
      expect(
        (await desktopQuery(lab, { scope: "manual", search: "system" })).words[0].note,
      ).toBe("桌面已有笔记 B，采集不能覆盖");
      expect(
        (
          await desktopQuery(lab, {
            scope: "manual",
            search: "leximeetnovelword",
          })
        ).words[0].note,
      ).toBe("已有自定义笔记 B");
      expect(independentFacts(await facts(lab.workspace))).toEqual(original);
      await lab.desktopPage
        .getByRole("button", { name: "断开连接", exact: true })
        .click();
      await expect
        .poll(() => connection(lab.workspace))
        .toMatchObject({ mode: "independent", status: "independent" });
      expect(independentFacts(await facts(lab.workspace))).toEqual(original);
      expect(captureRows(lab)).toHaveLength(3);
      lab.evidence.captureScenarios = {
        originalPageAndPanel: true,
        unicodeRanges: true,
        targetAndOtherWords: true,
        customDesktopIdentity: true,
        notebookPreserved: true,
        notesPreserved: true,
        desktopDisconnectRestoresA: true,
        defaultCaptureNotifications: 3,
      };
    });
  });

  test("真实浮球与网页词卡采集；临时失联可见提示、不写A，同草稿恢复重试只入库一次", async ({}, info) => {
    await withLab(info, async (lab) => {
      await seedA(lab, expect);
      await dragWord(
        lab,
        lab.reading.locator("strong").filter({ hasText: "resilient" }).first(),
        expect,
        "resilient",
      );
      const original = independentFacts(await facts(lab.workspace));
      expect(original.encounters).toHaveLength(1);
      await seedB(lab, prepareDesktopSettings);
      const noticesBefore = await captureNotificationCount(lab);
      await pairThroughUi(lab, "plugin");
      await dragWord(
        lab,
        lab.reading.getByTestId("mixed-case-word"),
        expect,
        "Resilient",
      );
      await expect.poll(() => captureRows(lab).length).toBe(1);
      await expect.poll(() => captureNotificationCount(lab)).toBe(noticesBefore + 1);
      const panel = await lab.openPanel();
      // SIDE_PANEL 上下文出现并不等于异步当前窗口状态已装载，按真实运行状态开始操作。
      await expect(panel.getByRole("contentinfo", { name: "运行状态" })).toContainText(
        "已连接桌面端",
      );
      await panel.getByRole("button", { name: "分析本页", exact: true }).click();
      const readingState = await panel.evaluate(async () => {
        const window = await chrome.windows.getCurrent();
        const response = await chrome.runtime.sendMessage({
          channel: "leximeet",
          action: "state",
          data: { windowId: window.id },
        });
        if (!response.ok) throw new Error(response.error);
        const { currentPage, page, storage, connection } = response.result;
        // 只保存当前正文投影与归属，不记录 credential、连接票据或私人库完整数据。
        return {
          currentPage,
          storage,
          connectionStatus: connection.status,
          page: page && {
            phase: page.phase,
            resultMode: page.resultMode,
            message: page.message,
            occurrenceSurfaces: page.occurrences.map((item) => item.surface),
          },
        };
      });
      await info.attach("safe-reading-analysis", {
        body: Buffer.from(JSON.stringify(readingState, null, 2)),
        contentType: "application/json",
      });
      await expect(panel.getByRole("region", { name: "遇见单词列表" })).toContainText(
        /system/i,
      );
      const destination = await point(
        lab,
        lab.reading.getByTestId("target-word"),
        expect,
      );
      await lab.reading.mouse.move(destination.x, destination.y);
      const card = lab.reading.locator("leximeet-page-ui .card");
      await expect(card.locator("button.capture")).toHaveText("采集");
      await card.locator("button.capture").click();
      await expect(card.locator("button.capture")).toHaveText("已采集");
      await expect.poll(() => captureRows(lab).length).toBe(2);
      await expect.poll(() => captureNotificationCount(lab)).toBe(noticesBefore + 2);
      await beginCapture(panel, expect);
      await lab.reading.getByTestId("unknown-word").click();
      await lab.reading.getByTestId("unknown-word").click();
      await expect(panel.locator(".lm-row")).toHaveCount(1);
      const before = await draftIds(lab);
      expect(before).toHaveLength(1);
      await lab.stopDesktop();
      await expect
        .poll(() => connection(lab.workspace))
        .toMatchObject({ mode: "desktop", status: "reconnecting" });
      await expect(
        panel.getByRole("status").filter({ hasText: "桌面连接暂不可用" }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "加入单词本", exact: true }),
      ).toBeDisabled();
      expect(captureRows(lab)).toHaveLength(2);
      expect(independentFacts(await facts(lab.workspace))).toEqual(original);
      expect(await draftIds(lab)).toEqual(before);
      await lab.restartDesktop();
      await expect
        .poll(() => connection(lab.workspace))
        .toMatchObject({ mode: "desktop", status: "connected" });
      const noticesAfterRestart = await captureNotificationCount(lab);
      expect(noticesAfterRestart).toBe(0);
      await expect(
        panel.getByRole("button", { name: "加入单词本", exact: true }),
      ).toBeEnabled();
      await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
      await expect.poll(() => captureRows(lab).length).toBe(3);
      await expect
        .poll(() => captureNotificationCount(lab))
        .toBe(noticesAfterRestart + 1);
      expect(captureRows(lab).filter((row) => row.eventId === before[0])).toHaveLength(1);
      for (const row of captureRows(lab)) assertRow(row, lab, expect);
      await disconnectThroughUi(lab.workspace);
      await expect
        .poll(() => connection(lab.workspace))
        .toMatchObject({ mode: "independent", status: "independent" });
      expect(independentFacts(await facts(lab.workspace))).toEqual(original);
      expect(captureRows(lab)).toHaveLength(3);
      lab.evidence.captureScenarios = {
        floatingIndependentAndConnected: true,
        actualWebCardCapture: true,
        visibleOfflineFeedback: true,
        noLocalFallback: true,
        originalPanelAfterRestart: true,
        sameEventIdRetry: true,
        duplicatePickIdempotent: true,
        floatingAndCardNotifications: 2,
        originalDraftNotificationAfterRestart: 1,
      };
    });
  });

  test("自动发现与取消邀请；两端分别主动连接和断开，A恢复而Desktop的B+C保留", async ({}, info) => {
    await withLab(info, async (lab) => {
      await seedA(lab, expect);
      const original = independentFacts(await facts(lab.workspace));
      await seedB(lab, prepareDesktopSettings);
      await requestInvitation(lab, "desktop");
      const popup = await invitationPopup(lab);
      await popup
        .getByRole("dialog", { name: "连接桌面端", exact: true })
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await expect.poll(() => invitationStates(lab)).toContain("cancelled");
      await expect
        .poll(() => connection(lab.workspace))
        .toMatchObject({ mode: "independent", status: "independent" });
      expect(independentFacts(await facts(lab.workspace))).toEqual(original);
      expect(captureRows(lab)).toHaveLength(0);
      await pairThroughUi(lab, "plugin");
      await captureNotificationSetting(lab, false, expect);
      const noticesDisabled = await captureNotificationCount(lab);
      await dragWord(
        lab,
        lab.reading.getByTestId("mixed-case-word"),
        expect,
        "Resilient",
      );
      await expect.poll(() => captureRows(lab).length).toBe(1);
      expect(await captureNotificationCount(lab)).toBe(noticesDisabled);
      await prepareDesktopSettings(lab);
      await lab.desktopPage
        .getByRole("button", { name: "断开连接", exact: true })
        .click();
      await expect
        .poll(() => connection(lab.workspace))
        .toMatchObject({ mode: "independent", status: "independent" });
      expect(independentFacts(await facts(lab.workspace))).toEqual(original);
      expect(captureRows(lab)).toHaveLength(1);
      await captureNotificationSetting(lab, true, expect);
      expect(await captureNotificationCount(lab)).toBe(noticesDisabled);
      await pairThroughUi(lab, "desktop");
      await dragWord(lab, lab.reading.getByTestId("target-word"), expect, "SYSTEM");
      await expect.poll(() => captureRows(lab).length).toBe(2);
      await expect.poll(() => captureNotificationCount(lab)).toBe(noticesDisabled + 1);
      await disconnectThroughUi(lab.workspace);
      await expect
        .poll(() => connection(lab.workspace))
        .toMatchObject({ mode: "independent", status: "independent" });
      expect(independentFacts(await facts(lab.workspace))).toEqual(original);
      expect(captureRows(lab)).toHaveLength(2);
      expect(
        (await desktopQuery(lab, { scope: "manual", search: "system" })).words[0].note,
      ).toBe("桌面已有笔记 B，采集不能覆盖");
      lab.evidence.captureScenarios = {
        actualCancel: true,
        pluginInitiated: true,
        desktopInitiated: true,
        bothDirectionsDisconnectRestoreA: true,
        noImportA: true,
        desktopBAndCRetained: true,
        captureNotificationPreference: true,
        disabledCaptureNotSentLater: true,
      };
    });
  });
}
