import test from "node:test";
import assert from "node:assert/strict";
import {
  documentSession,
  helloProjection,
  sameDocument,
  occurrencesForMode,
  captureResultNotice,
  validCaptureSwitch,
  restoredPageDrafts,
  assertDraftOwner,
  encounterRows,
} from "../lib/page-session.ts";
import type { Draft } from "../lib/types.ts";
const identity = {
  tabId: 7,
  documentId: "chrome-document",
  generation: "injection-generation",
};
const source = { title: "Reading", url: "https://example.org/article" };
const draft = {
  eventId: "event",
  occurrenceId: "old-range",
  surface: "book",
  originalSentence: "A book.",
  savedExcerpt: "A book.",
  annotation: { note: "私人笔记" },
  source: {
    type: "browser",
    title: "Old article",
    url: "https://example.org/old",
  },
} as Draft;
test("遇见按词归并大小写和重复位置，原位置和 Desktop 身份保持不变", () => {
  const occurrences = [
    { id: "node-first", surface: "Node", wordId: "desktop-node" },
    { id: "node-second", surface: "Node", wordId: "desktop-node" },
    { id: "the-upper", surface: "The", wordId: "desktop-the" },
    { id: "the-lower", surface: "the", wordId: "desktop-the" },
    { id: "system", surface: "system", wordId: "desktop-system" },
  ] as any;
  const original = structuredClone(occurrences);
  assert.deepEqual(
    encounterRows(occurrences).map((row) => row.id),
    ["node-first", "the-upper", "system"],
  );
  const selected = encounterRows(occurrences, "the-lower");
  assert.deepEqual(
    selected.map((row) => row.id),
    ["node-first", "the-lower", "system"],
  );
  assert.equal(selected[1], occurrences[3]);
  assert.equal(selected[1]!.surface, "the");
  assert.deepEqual(occurrences, original);
  assert.deepEqual(encounterRows([]), []);
});
test("重复 ping/hello 保留同文档正在分析、选中词、草稿与会话对象", () => {
  const page = documentSession(undefined, identity, source);
  page.phase = "capture";
  page.selectedId = "word";
  page.drafts = [draft];
  const repeated = documentSession(page, identity, source);
  assert.equal(repeated, page);
  assert.equal(repeated.phase, "capture");
  assert.equal(repeated.selectedId, "word");
  assert.equal(repeated.drafts[0]?.annotation.note, "私人笔记");
});
test("worker 丢失内存后重建当前文档，仅恢复草稿及原目标，不复活旧位置/采集锁", () => {
  const recreated = documentSession(undefined, identity, source, {
    drafts: [draft],
    target: { kind: "book", bookId: "original-book" },
  });
  assert.equal(recreated.phase, "idle");
  assert.deepEqual(recreated.occurrences, []);
  assert.equal(recreated.session, undefined);
  assert.equal(recreated.drafts[0]?.source.url, "https://example.org/old");
  assert.deepEqual(recreated.target, { kind: "book", bookId: "original-book" });
  assert.deepEqual(helloProjection(true, "dark"), {
    visible: true,
    theme: "dark",
  });
});
test("换文档或重新注入后旧身份不匹配，不可借同 tabId 操作新网页", () => {
  const page = documentSession(
    undefined,
    { ...identity, documentId: "new-document" },
    source,
  );
  assert.equal(sameDocument(page, identity), false);
  assert.equal(
    sameDocument(page, {
      ...identity,
      documentId: "new-document",
      generation: "old-generation",
    }),
    false,
  );
  assert.equal(sameDocument(page, { ...identity, documentId: "new-document" }), true);
});

test("切换模式不把采集候选当遇见，结束后的结果所属模式与未提交草稿保持独立", () => {
  const page = documentSession(undefined, identity, source, {
    drafts: [draft],
    target: { kind: "book", bookId: "old-book" },
  });
  page.resultMode = "capture";
  page.phase = "idle";
  page.occurrences = [{ id: "candidate", surface: "book" } as any];
  const original = structuredClone(page);
  assert.deepEqual(occurrencesForMode(page, "encounter"), []);
  assert.equal(occurrencesForMode(page, "capture"), page.occurrences);
  assert.deepEqual(page, original);
  page.resultMode = "encounter";
  assert.deepEqual(occurrencesForMode(page, "capture"), []);
  assert.equal(page.drafts[0]!.annotation.note, "私人笔记");
  assert.deepEqual(occurrencesForMode(undefined, "encounter"), []);
});
test("页内回执提示只表达本机保存状态，不携带私人详情或 Desktop 暗示", () => {
  assert.match(captureResultNotice("confirmed"), /已加入单词本/);
  assert.doesNotMatch(captureResultNotice("confirmed"), /等待|尚未/);
  assert.match(captureResultNotice("partial"), /部分条目/);
  assert.match(captureResultNotice("pending"), /正在保存到本机/);
  assert.doesNotMatch(captureResultNotice("confirmed"), /Desktop|桌面/);
});

test("切换确认只接受有界的原文档身份和草稿数量，拒绝损坏会话记录", () => {
  const valid = {
    id: "switch",
    tabId: 7,
    destinationTabId: 8,
    title: "Article",
    unsavedCount: 2,
    generation: "generation",
    documentId: "document",
  };
  assert.equal(validCaptureSwitch(valid), true);
  for (const bad of [
    null,
    { ...valid, tabId: -1 },
    { ...valid, documentId: "" },
    { ...valid, unsavedCount: 51 },
    { ...valid, title: "x".repeat(301) },
    { ...valid, id: false },
  ])
    assert.equal(validCaptureSwitch(bad), false);
});

test("明确断开时草稿恢复到仍打开的原文档，桌面草稿与换文档拒绝混入 A", () => {
  const page = documentSession(undefined, identity, source);
  const local = { ...draft, ownerTicket: "independent:A" };
  const desktop = { ...draft, eventId: "desktop-C", ownerTicket: "desktop:B" };
  const restored = restoredPageDrafts(page, identity, [local, desktop], "independent:A");
  assert.deepEqual(restored, [local]);
  restored[0]!.annotation.note = "新编辑";
  assert.equal(local.annotation.note, "私人笔记");
  assert.deepEqual(
    restoredPageDrafts(
      page,
      { ...identity, documentId: "other" },
      [local],
      "independent:A",
    ),
    [],
  );
  assert.deepEqual(
    restoredPageDrafts(
      page,
      { ...identity, generation: "other" },
      [local],
      "independent:A",
    ),
    [],
  );
  assert.deepEqual(restoredPageDrafts(page, undefined, [local], "independent:A"), []);
  assert.deepEqual(restoredPageDrafts(page, identity, [local], "independent:other"), []);
  assert.equal(page.phase, "idle");
  assert.deepEqual(page.occurrences, []);
});

test("断开部分完成时，未决多义桌面草稿也不能进入独立写入", () => {
  const unresolved = { ...draft, ownerTicket: "desktop:B" };
  assert.equal(unresolved.desktopWord, undefined);
  assert.throws(() => assertDraftOwner(unresolved, "independent:A"), /不属于当前资料/);
  assert.doesNotThrow(() => assertDraftOwner(unresolved, "desktop:B"));
  assert.throws(() => assertDraftOwner(draft, "independent:A"), /不属于当前资料/);
  assert.doesNotThrow(() =>
    assertDraftOwner({ ...draft, ownerTicket: "independent:A" }, "independent:A"),
  );
});
