import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalLibrary, type PersonalWordSelection } from "../lib/local-database.ts";
import { learningLibrary, learningDaily } from "../lib/learning-workspace.ts";
import { primaryWordPos } from "../lib/library-filters.ts";
import type { CatalogMember } from "../lib/lexicon.ts";
import { MAX_ACTIVE_WORDS, type UserWord, type StudyPlan } from "../lib/local-model.ts";
const create = () => new LocalLibrary(`library-management-${crypto.randomUUID()}`);
const member = (word: string, pos = "noun"): CatalogMember => ({
  entryId: "entry-" + word,
  word,
  meaning: "实际词典释义",
  position: 1,
  senseIds: [],
  matchMethod: "dictionary",
  pos,
});
const resource = (m: CatalogMember): PersonalWordSelection => ({
  word: m.word,
  entryId: m.entryId,
  dictionaryHint: m.meaning,
  expectedRevision: null,
});
const selection = (w: UserWord): PersonalWordSelection => ({
  word: w.word,
  entryId: w.entryId || null,
  dictionaryHint: w.dictionaryHint,
  expectedRevision: w.revision,
});

test("未学习的只读目标回收后不重生，今日和自由范围排除，恢复原ID", async () => {
  const db = create(),
    target = [member("in", "preposition"), member("out")];
  const [trash] = await db.updatePersonalWords([resource(target[0]!)], {
    kind: "recycle",
  });
  assert.equal(trash!.collected, false);
  assert.equal(trash!.deletedAt !== null, true);
  assert.deepEqual(await db.encounters(), []);
  const all = await db.listWords(true);
  const list = learningLibrary(target, all, [], [], []);
  assert.deepEqual(
    list.map((i) => i.word),
    ["out"],
  );
  const plan: StudyPlan = {
    id: "plan",
    sourceKind: "catalog",
    sourceId: "words",
    sourceVersion: "0.0.3",
    dailyNew: 10,
    dailyReview: 20,
    startedOn: "2026-10-04",
    timeZone: "UTC",
    savedAt: new Date().toISOString(),
    paused: false,
  };
  assert.deepEqual(
    learningDaily(list, [], [], plan).unique.map((i) => i.word),
    ["out"],
  );
  await db.setDeleted(trash!.id, false);
  const restored = learningLibrary(target, await db.listWords(true), [], [], []);
  assert.equal(restored[0]!.word, "in");
  assert.equal(restored[0]!.personal?.id, trash!.id);
  assert.equal((await db.listWords(true)).length, 1);
});

test("公共条目的大小写身份和entryId都尊重回收事实", async () => {
  const db = create(),
    a = member("Resilient");
  const [word] = await db.updatePersonalWords([resource(a)], { kind: "recycle" });
  const target = [
    { ...a, word: "RESILIENT", entryId: "alternate-entry" },
    { ...a, word: "dictionary-alias" },
  ];
  assert.equal(learningLibrary(target, await db.listWords(true), [], [], []).length, 0);
  assert.equal((await db.word(word!.id))!.word, "Resilient");
});

test("批量加入多本保留原关联，一词只物化一次，不制造遇见", async () => {
  const db = create(),
    a = member("alpha"),
    b = member("beta");
  const first = (await db.listNotebooks())[0]!,
    second = await db.createNotebook("考试词");
  const existing = await db.addWord(
    a.word,
    { meaning: a.meaning, phonetic: "" },
    true,
    a.entryId,
  );
  const saved = await db.updatePersonalWords([selection(existing), resource(b)], {
    kind: "add-to-notebooks",
    notebookIds: [second.id],
  });
  assert.deepEqual(saved[0]!.notebookIds, [first.id, second.id]);
  assert.deepEqual(saved[1]!.notebookIds, [second.id]);
  assert.equal(saved[1]!.collected, true);
  assert.equal((await db.listWords()).length, 2);
  assert.equal((await db.encounters()).length, 0);
  const again = await db.updatePersonalWords(saved.map(selection), {
    kind: "add-to-notebooks",
    notebookIds: [second.id],
  });
  assert.deepEqual(
    again.map((w) => w.id),
    saved.map((w) => w.id),
  );
  assert.equal(new Set(again[0]!.notebookIds).size, 2);
});

test("批量任一版本冲突或单词本已回收时整批零提交", async () => {
  const db = create(),
    original = await db.addWord("alpha"),
    second = member("beta");
  await db.editWord(original.id, original.revision, { note: "另一窗口已保存" });
  await assert.rejects(
    db.updatePersonalWords([resource(second), selection(original)], { kind: "recycle" }),
    /另一窗口/,
  );
  assert.equal((await db.listWords(true)).length, 1);
  assert.equal((await db.word(original.id))!.deletedAt, null);
  const book = (await db.listNotebooks())[0]!;
  await db.updateNotebook(book.id, book.revision, { deleted: true });
  await assert.rejects(
    db.updatePersonalWords([resource(second)], {
      kind: "add-to-notebooks",
      notebookIds: [book.id],
    }),
    /已回收的单词本/,
  );
  assert.equal(await db.byNormalized("beta"), undefined);
});

test("个人编辑只写笔记和多本，封存时批量资源也不能新增", async () => {
  const db = create(),
    m = member("gamma");
  const first = (await db.listNotebooks())[0]!,
    second = await db.createNotebook("技术阅读");
  const [saved] = await db.updatePersonalWords([resource(m)], {
    kind: "edit",
    note: "我的笔记",
    notebookIds: [first.id, second.id],
  });
  assert.equal(saved!.note, "我的笔记");
  assert.deepEqual(saved!.notebookIds, [first.id, second.id]);
  assert.equal("personalMeaning" in saved!, false);
  assert.equal("tags" in saved!, false);
  assert.equal("manualMastered" in saved!, false);
  // 个人内容API拒绝旧自定义释义、标签和熟悉标记，不静默丢弃输入或覆盖公共词义。
  for (const patch of [
    { personalMeaning: "不能覆盖词义" },
    { tags: ["私人标签"] },
    { manualMastered: true },
  ])
    await assert.rejects(
      db.editWord(saved!.id, saved!.revision, patch as never),
      /仅支持/,
    );
  const rows = await db.listWords(true);
  assert.equal(learningLibrary([m], rows, [], [], [])[0]!.meaning, m.meaning);
  const before = await db.listWords(true);
  await db.freezeIndependent();
  await assert.rejects(
    db.updatePersonalWords([resource(member("delta"))], { kind: "recycle" }),
    /封存/,
  );
  assert.deepEqual(await db.listWords(true), before);
});

test("词性只按真实字段归一，缺资料不从词义猜测", () => {
  assert.equal(primaryWordPos({ pos: "n." }), "noun");
  assert.equal(primaryWordPos({ pos: "vt" }), "verb");
  assert.equal(primaryWordPos({ pos: "proper noun" }), "proper-noun");
  assert.equal(primaryWordPos(undefined), "unknown");
  assert.equal(primaryWordPos({ pos: "custom-real-pos" }), "custom-real-pos");
});

test("只编辑笔记的资源词在更换目标后仍可查看，不伪造采集与学习", async () => {
  const db = create(),
    m = member("note-only");
  const [saved] = await db.updatePersonalWords([resource(m)], {
    kind: "edit",
    note: "保留的个人笔记",
    notebookIds: [],
  });
  const projected = learningLibrary([], await db.listWords(true), [], [], []);
  assert.equal(projected.length, 1);
  assert.equal(projected[0]!.personal?.id, saved!.id);
  assert.equal(projected[0]!.personal?.note, "保留的个人笔记");
  assert.equal(projected[0]!.collected, false);
  assert.equal(projected[0]!.status, "new");
  assert.deepEqual(await db.encounters(), []);
  assert.deepEqual(await db.practice(), []);
});

test("回收公共词换目标后恢复仍显示，重复恢复不额外收录，ID和事实保留", async () => {
  const db = create(),
    oldTarget = member("original-target"),
    nextTarget = member("next-target");
  const [recycled] = await db.updatePersonalWords([resource(oldTarget)], {
    kind: "recycle",
  });
  const before = {
    encounters: await db.encounters(),
    reviews: await db.reviews(),
    practice: await db.practice(),
  };
  assert.equal(
    learningLibrary([nextTarget], await db.listWords(true), [], [], []).some(
      (i) => i.word === oldTarget.word,
    ),
    false,
  );
  const restored = await db.setDeleted(recycled!.id, false);
  const projected = learningLibrary([nextTarget], await db.listWords(true), [], [], []);
  const retained = projected.find((i) => i.word === oldTarget.word)!;
  assert.equal(retained.personal?.id, recycled!.id);
  assert.equal(retained.inTarget, false);
  assert.equal(retained.collected, true);
  assert.equal(retained.status, "new");
  assert.deepEqual(
    {
      encounters: await db.encounters(),
      reviews: await db.reviews(),
      practice: await db.practice(),
    },
    before,
  );
  assert.deepEqual(await db.setDeleted(restored.id, false), restored);
  const noteOnly = await db.addWord("active-uncollected", undefined, false);
  assert.deepEqual(await db.setDeleted(noteOnly.id, false), noteOnly);
  assert.equal((await db.word(noteOnly.id))!.collected, false);
});

test("恢复未采集资源词也遵守活动容量上限，失败保留回收原行", async () => {
  const db = create(),
    [recycled] = await db.updatePersonalWords([resource(member("restore-at-limit"))], {
      kind: "recycle",
    });
  const notebook = (await db.listNotebooks())[0]!;
  const active = await db.updatePersonalWords(
    Array.from({ length: MAX_ACTIVE_WORDS }, (_, i) => resource(member("capacity-" + i))),
    { kind: "add-to-notebooks", notebookIds: [notebook.id] },
  );
  await assert.rejects(db.setDeleted(recycled!.id, false), /活动词条上限/);
  assert.deepEqual(await db.word(recycled!.id), recycled);
  assert.equal((await db.listWords()).length, MAX_ACTIVE_WORDS);
  await db.setDeleted(active[0]!.id, true);
  const restored = await db.setDeleted(recycled!.id, false);
  assert.equal(restored.id, recycled!.id);
  assert.equal(restored.collected, true);
  assert.equal((await db.listWords()).length, MAX_ACTIVE_WORDS);
});

test("手动重新加入回收资源词保留同ID和释义；内部物化false不意外收录", async () => {
  const db = create(),
    first = member("re-add-collected"),
    second = member("re-add-uncollected");
  const recycled = await db.updatePersonalWords([resource(first), resource(second)], {
    kind: "recycle",
  });
  const before = {
    encounters: await db.encounters(),
    practice: await db.practice(),
    reviews: await db.reviews(),
  };
  const added = await db.addWord(
    first.word,
    { meaning: "不能覆盖公开提示", phonetic: "different" },
    true,
    "different-entry-id",
  );
  assert.equal(added.id, recycled[0]!.id);
  assert.equal(added.entryId, recycled[0]!.entryId);
  assert.equal(added.dictionaryHint, recycled[0]!.dictionaryHint);
  assert.equal(added.collected, true);
  assert.equal(
    learningLibrary([], await db.listWords(true), [], [], [])[0]!.personal?.id,
    added.id,
  );
  const materialized = await db.addWord(second.word, undefined, false, second.entryId);
  assert.equal(materialized.id, recycled[1]!.id);
  assert.equal(materialized.collected, false);
  assert.equal(materialized.deletedAt, null);
  assert.deepEqual(
    {
      encounters: await db.encounters(),
      practice: await db.practice(),
      reviews: await db.reviews(),
    },
    before,
  );
});

test("现有未采集词升级收藏也先检查活动容量，不从快速返回路径绕过", async () => {
  const db = create(),
    uncollected = await db.addWord("promote-at-limit", undefined, false);
  const notebook = (await db.listNotebooks())[0]!;
  const active = await db.updatePersonalWords(
    Array.from({ length: MAX_ACTIVE_WORDS }, (_, i) =>
      resource(member("promotion-capacity-" + i)),
    ),
    { kind: "add-to-notebooks", notebookIds: [notebook.id] },
  );
  await assert.rejects(db.addWord(uncollected.word, undefined, true), /活动词条上限/);
  assert.deepEqual(await db.word(uncollected.id), uncollected);
  // 内部物化不增加活动收藏数；现有活动收藏的幂等读取同样不扣额度。
  assert.deepEqual(await db.addWord(uncollected.word, undefined, false), uncollected);
  assert.equal((await db.addWord(active[0]!.word)).id, active[0]!.id);
  await db.setDeleted(active[0]!.id, true);
  const promoted = await db.addWord(uncollected.word, undefined, true);
  assert.equal(promoted.id, uncollected.id);
  assert.equal(promoted.collected, true);
  assert.equal(
    (await db.listWords()).filter((w) => w.collected !== false).length,
    MAX_ACTIVE_WORDS,
  );
});
