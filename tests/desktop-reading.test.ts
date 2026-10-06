import test from "node:test";
import assert from "node:assert/strict";
import fixtures from "../lib/connector/contracts/contracts.json" with { type: "json" };
import { DesktopReading, projectDesktopEntry } from "../lib/desktop-reading.ts";
import type { DesktopConnection } from "../lib/desktop-connection.ts";
import type { Draft } from "../lib/types.ts";
import type { CoreEntry } from "../lib/lexicon.ts";
import { LmcpError, sameWord } from "../lib/connector/types.ts";
import type {
  MatchResult,
  NotebookRecord,
  WordRef,
  WordSummary,
} from "../lib/connector/types.ts";

// 仅验证读取适配模型；不把注入客户端当作真实 Desktop/Native 验收。
const FIRST = "11111111-1111-4111-8111-111111111111",
  SECOND = "22222222-2222-4222-8222-222222222222";
const copy = <T>(value: T): T => structuredClone(value);
const elapsed = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reference = (entryId = FIRST): WordRef => ({
  kind: "dictionary",
  entryId,
  release: "0.0.3",
  entrySchema: "leximeet.entry.v2",
});
const match = (
  word = reference(),
  headword = "system",
): MatchResult["results"][number]["matches"][number] => ({
  word,
  headword,
  inTarget: true,
  collected: false,
  learningStatus: "new",
  score: 10,
});
function summary(word = reference()): WordSummary {
  return {
    word,
    headword: "system",
    collected: false,
    inTarget: true,
    resourceStatus: "available",
    personal: null,
    learning: { status: "new", score: 10, asOf: new Date().toISOString() },
    refreshAfterMs: 30_000,
  };
}
function entry(): CoreEntry {
  const example = fixtures.find(
    (item) => item.name === "getPublicEntry-response",
  ) as unknown as { value: { result: { entry: CoreEntry } } };
  return copy(example.value.result.entry);
}
function notebook(entityId = FIRST): NotebookRecord {
  return {
    entityType: "notebook",
    entityId,
    revision: "1",
    deletedAt: null,
    data: { name: entityId, color: "#123456", position: 0 },
  };
}
function setup() {
  let ticket = "desktop:owner-A";
  const seen: string[][] = [],
    saved: { params: unknown; ticket: string }[] = [];
  const client = {
    connected: true,
    capabilities: ["desktop.notebooks/1"],
    leaseUntil: new Date(Date.now() + 30_000).toISOString(),
    get session() {
      return { readLeaseUntil: this.leaseUntil };
    },
    matches: [match()],
    complete: true,
    matchRefreshMs: 30_000,
    summaryRefreshMs: 30_000,
    beforeMatch: null as (() => void | Promise<void>) | null,
    beforeWord: null as (() => void | Promise<void>) | null,
    publicError: null as LmcpError | null,
    publicCalls: 0,
    wordCalls: 0,
    resourceStatus: "available" as WordSummary["resourceStatus"],
    beforePublic: null as (() => void | Promise<void>) | null,
    beforeNotebooks: null as (() => void | Promise<void>) | null,
    pages: [
      {
        items: [notebook()],
        nextCursor: null as string | null,
        complete: true,
        revision: "1",
      },
    ],
    pageCalls: [] as unknown[],
    async matchWords(params: { kind: "tokens"; tokens: string[] }): Promise<MatchResult> {
      seen.push([...params.tokens]);
      await this.beforeMatch?.();
      return {
        results: params.tokens.map((_, inputIndex) => ({
          inputIndex,
          matches: copy(this.matches),
          complete: this.complete,
        })),
        workspaceRevision: "1",
        asOf: new Date().toISOString(),
        refreshAfterMs: this.matchRefreshMs,
      };
    },
    async getWord(word: WordRef) {
      this.wordCalls++;
      await this.beforeWord?.();
      return {
        ...summary(word),
        resourceStatus: this.resourceStatus,
        refreshAfterMs: this.summaryRefreshMs,
      };
    },
    async getPublicEntry(word: WordRef) {
      this.publicCalls++;
      await this.beforePublic?.();
      if (this.publicError) throw this.publicError;
      const raw = entry();
      raw.entry_id = (word as Extract<WordRef, { kind: "dictionary" }>).entryId;
      return { release: "0.0.3", entry: raw };
    },
    async listNotebooks(params: unknown) {
      this.pageCalls.push(copy(params));
      await this.beforeNotebooks?.();
      return copy(
        this.pages[Math.min(this.pageCalls.length - 1, this.pages.length - 1)]!,
      );
    },
  };
  const connection = {
    ticket: () => ticket,
    assertTicket(value: string) {
      if (value !== ticket) throw new Error("资料归属已变化");
    },
    async active() {
      if (!client.connected) throw new LmcpError("DISCONNECTED", "桌面连接已断开");
      return client;
    },
    async capture(params: unknown, value: string) {
      this.assertTicket(value);
      saved.push({ params: copy(params), ticket: value });
      return { ok: true };
    },
  };
  const reading = new DesktopReading(connection as unknown as DesktopConnection);
  return {
    reading,
    client,
    seen,
    saved,
    connection,
    setTicket(value: string) {
      ticket = value;
    },
  };
}
function draft(word = reference(), ticket = "desktop:owner-A"): Draft {
  return {
    eventId: FIRST,
    surface: "system",
    selectedWordId: FIRST,
    originalSentence: "A system works.",
    savedExcerpt: "A system works.",
    occurrenceRanges: [{ start: 2, end: 8 }],
    excerptRanges: [{ start: 2, end: 8 }],
    annotation: { note: "" },
    source: {
      type: "browser",
      title: "Article",
      url: "https://example.invalid/article",
    },
    occurredAt: new Date().toISOString(),
    timeZone: "Asia/Shanghai",
    occurrenceId: "document:1",
    desktopWord: word,
    ownerTicket: ticket,
  };
}

test("遇见查询只交 Desktop 匹配，不先用插件 Lite 过滤未知词或改变大小写", async () => {
  const s = setup();
  const tokens = ["Polish", "polish", "photosynthesis", "NotInLite"];
  await s.reading.matches(tokens);
  assert.deepEqual(s.seen, [tokens]);
});
test("同拼写多个不同entryId必须显式选择，不能自动选第一项", async () => {
  const s = setup();
  s.client.matches = [
    match(reference(FIRST), "Polish"),
    match(reference(SECOND), "polish"),
  ];
  const card = await s.reading.card("Polish");
  assert.equal(card.selected, null);
  assert.equal(card.choices.length, 2);
  assert.equal(s.client.wordCalls, 0);
  await assert.rejects(s.reading.prepare("Polish"), /多个词条|选择/);
  await s.reading.select("Polish", reference(SECOND));
  const chosen = await s.reading.card("Polish");
  assert.equal(
    (chosen.selected as Extract<WordRef, { kind: "dictionary" }>).entryId,
    SECOND,
  );
  assert.equal(sameWord(await s.reading.prepare("Polish"), reference(SECOND)), true);
});
test("选择只属于匹配的稳定WordRef，换owner清掉原选择", async () => {
  const s = setup();
  s.client.matches = [match(reference(FIRST)), match(reference(SECOND))];
  await assert.rejects(
    s.reading.select("system", reference("33333333-3333-4333-8333-333333333333")),
    /不属于/,
  );
  await s.reading.select("system", reference(SECOND));
  s.setTicket("desktop:owner-B");
  assert.equal((await s.reading.card("system")).selected, null);
});
test("不完整匹配不当作唯一词条或空匹配自定义成功", async () => {
  const s = setup();
  s.client.complete = false;
  await assert.rejects(s.reading.card("system"), /完整/);
  await assert.rejects(s.reading.prepare("system"), /完整/);
});
test("缺公共资源保留稳定身份并明确提示，不捏造空词卡成功", async () => {
  const s = setup();
  s.client.resourceStatus = "missing";
  const missing = await s.reading.card("system");
  assert.equal(sameWord(missing.selected!, reference()), true);
  assert.equal(missing.entry, null);
  assert.match(missing.resourceMessage, /不可用/);
  assert.equal(s.client.publicCalls, 0);
  s.client.resourceStatus = "available";
  s.client.publicError = new LmcpError("RESOURCE_UNAVAILABLE", "resource missing");
  const unavailable = await s.reading.card("system");
  assert.equal(unavailable.entry, null);
  assert.match(unavailable.resourceMessage, /不可用/);
  assert.equal(sameWord(unavailable.selected!, reference()), true);
});
test("私人摘要读取后断线不允许返回旧词卡，稳定草稿ticket不等于连接租期", async () => {
  const s = setup();
  s.client.publicError = new LmcpError("DISCONNECTED", "lost");
  s.client.beforePublic = () => {
    s.client.connected = false;
  };
  await assert.rejects(s.reading.card("system"), /断开|lost|连接/);
});
test("词卡异步返回前owner变化时拒绝投影", async () => {
  const s = setup();
  s.client.beforePublic = () => s.setTicket("desktop:owner-B");
  await assert.rejects(s.reading.card("system"), /归属/);
});
test("采集保存发送DesktopWordRef，不上传独立词条id或客户端学习分", async () => {
  const s = setup(),
    word = reference(SECOND);
  await s.reading.save(draft(word), FIRST, "desktop:owner-A");
  const saved = s.saved[0]!.params as any;
  assert.deepEqual(saved.data.word, word);
  assert.equal(saved.mutationId, FIRST);
  assert.equal(saved.eventId, FIRST);
  assert.equal(saved.notebookId, FIRST);
  assert.equal(saved.data.source.kind, "web");
  for (const key of ["score", "occurredAt", "timeZone", "origin", "selectedWordId"])
    assert.equal(key in saved.data, false);
});
test("旧owner草稿和没有DesktopWordRef的独立草稿禁止改投", async () => {
  const s = setup();
  await assert.rejects(
    s.reading.save(draft(reference(), "desktop:old"), null, "desktop:owner-A"),
    /不属于/,
  );
  const independent = draft();
  delete independent.desktopWord;
  await assert.rejects(s.reading.save(independent, null, "desktop:owner-A"), /不属于/);
  assert.equal(s.saved.length, 0);
});
test("无匹配仅生成自定义WordRef，不替换为Lite中同拼写词条", async () => {
  const s = setup();
  s.client.matches = [];
  const word = await s.reading.prepare("untested");
  assert.equal(word.kind, "custom");
  if (word.kind === "custom") {
    assert.equal(word.headword, "untested");
    assert.equal(word.language, "en");
    assert.match(word.customId, /^[0-9a-f-]{36}$/);
  }
  const card = await s.reading.card("untested");
  assert.equal(card.entry, null);
  assert.equal(card.summary, null);
  assert.match(card.resourceMessage, /自定义/);
});
test("词本完整分页读取且过滤回收词本，不静默只拿前100项", async () => {
  const s = setup();
  s.client.pages = [
    {
      items: [notebook(FIRST)],
      nextCursor: "next",
      complete: false,
      revision: "1",
    },
    {
      items: [
        notebook(SECOND),
        {
          ...notebook("33333333-3333-4333-8333-333333333333"),
          deletedAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
      complete: true,
      revision: "1",
    },
  ];
  assert.deepEqual(
    (await s.reading.notebooks()).map((item) => item.entityId),
    [FIRST, SECOND],
  );
  assert.equal(s.client.pageCalls.length, 2);
});
test("词本分页owner或revision变化不得混合旧新资料", async () => {
  const s = setup();
  s.client.beforeNotebooks = () => s.setTicket("desktop:owner-B");
  await assert.rejects(s.reading.notebooks(), /归属/);
  const changed = setup();
  changed.client.pages = [
    { items: [notebook()], nextCursor: "next", complete: false, revision: "1" },
    {
      items: [notebook(SECOND)],
      nextCursor: null,
      complete: true,
      revision: "2",
    },
  ];
  await assert.rejects(changed.reading.notebooks(), /修订|变化|重新/);
});
test("未协商可选词本能力时不调用缺失方法", async () => {
  const s = setup();
  s.client.capabilities = [];
  assert.deepEqual(await s.reading.notebooks(), []);
  assert.equal(s.client.pageCalls.length, 0);
});
test("Desktop 公共词卡投影只展示词典字段，不改私人事实", () => {
  const raw = entry(),
    before = copy(raw),
    projected = projectDesktopEntry(raw);
  assert.equal(projected.entryId, raw.entry_id);
  assert.equal(projected.word, raw.headword);
  assert.equal(projected.audio, null);
  assert.deepEqual(raw, before);
  assert.ok(projected.translation);
});

test("私人词卡只读租期已过期时暂停展示，不靠稳定owner继续读取旧摘要", async () => {
  const s = setup();
  s.client.leaseUntil = new Date(Date.now() - 1).toISOString();
  await assert.rejects(s.reading.card("system"), /租期|连接/);
});

test("候选匹配带私人学习摘要，租期过期时不能继续投影", async () => {
  const s = setup();
  s.client.leaseUntil = new Date(Date.now() - 1).toISOString();
  await assert.rejects(s.reading.matches(["system"]), /租期|连接/);
});
test("多义候选带分数且未选词，也必须锁定过期私人摘要", async () => {
  const s = setup();
  s.client.matches = [match(reference(FIRST)), match(reference(SECOND))];
  s.client.leaseUntil = new Date(Date.now() - 1).toISOString();
  await assert.rejects(s.reading.card("system"), /租期|连接/);
});
test("词本读取晚到时连接失效或租期过期，不返回旧私人词本", async () => {
  const expired = setup();
  expired.client.leaseUntil = new Date(Date.now() - 1).toISOString();
  await assert.rejects(expired.reading.notebooks(), /租期|连接/);
  const lost = setup();
  lost.client.beforeNotebooks = () => {
    lost.client.connected = false;
  };
  await assert.rejects(lost.reading.notebooks(), /租期|连接/);
});

test("匹配1ms刷新预算在真实await中耗尽时拒绝返回带分数候选，不延为1ms", async () => {
  const s = setup();
  s.client.matchRefreshMs = 1;
  s.client.beforeMatch = () => elapsed(15);
  await assert.rejects(s.reading.matches(["system"]), /刷新期限|租期/);
  assert.deepEqual(s.seen, [["system"]]);
});
test("多义及零候选的卡片和采集入口同样拒绝已经耗尽的匹配预算", async () => {
  for (const choices of [[match(reference(FIRST)), match(reference(SECOND))], []]) {
    for (const method of ["card", "prepareSelection"] as const) {
      const s = setup();
      s.client.matches = choices;
      s.client.matchRefreshMs = 1;
      s.client.beforeMatch = () => elapsed(15);
      await assert.rejects(s.reading[method]("system"), /刷新期限|租期/);
      assert.equal(s.client.wordCalls, 0);
      assert.equal(s.client.publicCalls, 0);
    }
  }
});
test("选择词条的匹配超时不能存入选择，下次仍需明确选择多义词", async () => {
  const s = setup();
  s.client.matches = [match(reference(FIRST)), match(reference(SECOND))];
  s.client.matchRefreshMs = 1;
  s.client.beforeMatch = () => elapsed(15);
  await assert.rejects(s.reading.select("system", reference(SECOND)), /刷新期限|租期/);
  s.client.beforeMatch = null;
  s.client.matchRefreshMs = 30_000;
  assert.equal((await s.reading.card("system")).selected, null);
});
test("getWord读取消耗完匹配期限时停止后续公共资源请求，不返回旧分数", async () => {
  const s = setup();
  s.client.matchRefreshMs = 10;
  s.client.beforeWord = () => elapsed(25);
  await assert.rejects(s.reading.card("system"), /刷新期限|租期/);
  assert.equal(s.client.wordCalls, 1);
  assert.equal(s.client.publicCalls, 0);
});
test("getWord自身的1ms摘要预算在await中耗尽，不把旧摘要延长展示", async () => {
  const s = setup();
  s.client.summaryRefreshMs = 1;
  s.client.beforeWord = () => elapsed(15);
  await assert.rejects(s.reading.card("system"), /刷新期限|租期/);
  assert.equal(s.client.wordCalls, 1);
  assert.equal(s.client.publicCalls, 0);
});
test("公共词卡读取跨过匹配期限或摘要期限时均拒绝私人词卡投影", async () => {
  for (const budget of ["match", "summary"] as const) {
    const s = setup();
    if (budget === "match") s.client.matchRefreshMs = 10;
    else s.client.summaryRefreshMs = 10;
    s.client.beforePublic = () => elapsed(25);
    await assert.rejects(s.reading.card("system"), /刷新期限|租期/);
    assert.equal(s.client.wordCalls, 1);
    assert.equal(s.client.publicCalls, 1);
  }
});
test("缺公共资源的错误分支也不能返回已过期的摘要分数", async () => {
  const s = setup();
  s.client.summaryRefreshMs = 10;
  s.client.publicError = new LmcpError("RESOURCE_UNAVAILABLE", "resource missing");
  s.client.beforePublic = () => elapsed(25);
  await assert.rejects(s.reading.card("system"), /刷新期限|租期/);
});
test("词本页读取跨过开始时租期，即使期间重新续租也不返回原页私人资料", async () => {
  const s = setup();
  s.client.leaseUntil = new Date(Date.now() + 5).toISOString();
  s.client.beforeNotebooks = async () => {
    await elapsed(15);
    s.client.leaseUntil = new Date(Date.now() + 30_000).toISOString();
  };
  await assert.rejects(s.reading.notebooks(), /刷新期限|租期/);
  assert.equal(s.client.pageCalls.length, 1);
});
test("未协商词本能力的早返回也不得在租期到期后给出成功空列表", async () => {
  const s = setup();
  s.client.capabilities = [];
  s.client.leaseUntil = new Date(Date.now() - 1).toISOString();
  await assert.rejects(s.reading.notebooks(), /刷新期限|租期/);
  assert.equal(s.client.pageCalls.length, 0);
});
test("正常异步读取保留正预算且不超过原始匹配与摘要刷新时限", async () => {
  const s = setup();
  s.client.matchRefreshMs = 1_000;
  s.client.summaryRefreshMs = 500;
  s.client.beforeWord = () => elapsed(5);
  s.client.beforePublic = () => elapsed(5);
  const card = await s.reading.card("system");
  assert.equal(card.summary!.learning.score, 10);
  assert.equal(sameWord(card.selected!, reference()), true);
  assert.ok(card.entry);
  assert.ok(card.refreshAfterMs > 0);
  assert.ok(card.refreshAfterMs < 500);
  assert.ok(card.refreshAfterMs <= 30_000);
  s.client.matches = [match(reference(FIRST)), match(reference(SECOND))];
  const ambiguous = await s.reading.card("system");
  assert.equal(ambiguous.choices.length, 2);
  assert.ok(ambiguous.refreshAfterMs > 0 && ambiguous.refreshAfterMs <= 1_000);
  s.client.matches = [];
  const empty = await s.reading.card("untested");
  assert.equal(empty.choices.length, 0);
  assert.ok(empty.refreshAfterMs > 0 && empty.refreshAfterMs <= 1_000);
  const custom = await s.reading.prepareSelection("untested");
  assert.equal(custom.word!.kind, "custom");
  assert.ok(custom.refreshAfterMs > 0 && custom.refreshAfterMs <= 1_000);
});
