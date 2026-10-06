import { localSnapshot } from "./helpers/local-snapshot.ts";
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalLibrary } from "../lib/local-database.ts";
import type { CaptureInput } from "../lib/local-model.ts";
import { defaultWorkspacePreferences } from "../lib/workspace-model.ts";
import { PERSONAL_FORMAT, PERSONAL_DB_VERSION } from "../lib/local-model.ts";

const library = () => new LocalLibrary(`leximeet-local-test-${crypto.randomUUID()}`);
function input(eventId: string = crypto.randomUUID()): CaptureInput {
  return {
    eventId,
    surface: "Resilient",
    originalSentence: "A Resilient learner returns.",
    savedExcerpt: "A Resilient learner returns.",
    occurrenceRanges: [{ start: 2, end: 11 }],
    excerptRanges: [{ start: 2, end: 11 }],
    annotation: { note: "练习" },
    source: {
      title: "阅读页",
      url: "https://example.org/read?q=secret#section",
    },
    occurredAt: "2026-09-28T08:00:00.000Z",
    timeZone: "Asia/Shanghai",
    dictionary: { meaning: "有韧性的", phonetic: "rɪˈzɪliənt" },
  };
}

test("只有一个稳定本地词本；重复词追加遇见，重复事件幂等", async () => {
  const db = library();
  await db.updateCapturePolicy({ duplicateWindowDays: 0 });
  const book = await db.book();
  assert.equal(book.name, "浏览器插件词库");
  const first = await db.capture(input());
  const duplicate = await db.capture(input(first.word.id));
  assert.equal(duplicate.duplicate, false);
  assert.equal((await db.listWords()).length, 1);
  assert.equal((await db.encounters(first.word.id)).length, 2);
  const repeated = await db.capture(input(first.word.id));
  assert.equal(repeated.duplicate, true);
  assert.equal((await db.encounters(first.word.id)).length, 2);
  await assert.rejects(
    db.capture({
      ...input(first.word.id),
      annotation: {
        note: "另一份内容",
      },
    }),
    /相同遇见事件 ID 的内容不一致/,
  );
  assert.equal((await db.encounters(first.word.id)).length, 2);
  assert.equal(
    (await db.encounters(first.word.id))[0]?.source.url,
    "https://example.org/read",
  );
  assert.equal((await db.book()).bookUid, book.bookUid);
});

test("首发采集批注只保存笔记，拒绝旧补充释义与私人标签", async () => {
  const db = library();
  for (const annotation of [
    { note: "", meaningSupplement: "" },
    { note: "", tags: [] },
    { note: null },
  ]) {
    await assert.rejects(db.capture({ ...input(), annotation } as any), /只支持笔记/);
  }
  assert.equal((await db.listWords()).length, 0);
  const saved = await db.capture(input());
  assert.deepEqual((await db.encounters(saved.word.id))[0]?.annotation, { note: "练习" });
});

test("复习与练习事实只能引用活动词条，事务完成后才报告保存", async () => {
  const db = library();
  const word = await db.addWord("resilient");
  const review = {
    id: crypto.randomUUID(),
    wordId: word.id,
    rating: "good" as const,
    createdAt: new Date().toISOString(),
    undoneAt: null,
    algorithmVersion: "fsrs-6/java-fsrs-1.0.0",
  };
  await db.addReview(review);
  assert.equal((await db.reviews(word.id)).length, 1);
  const practice = {
    id: crypto.randomUUID(),
    wordId: word.id,
    entryId: null,
    mode: "copy" as const,
    answer: "resilient",
    correct: true,
    durationMs: 1250,
    createdAt: new Date().toISOString(),
  };
  await db.addPractice(practice);
  assert.equal((await db.practice(word.id)).length, 1);
  await db.setDeleted(word.id, true);
  await assert.rejects(db.addReview({ ...review, id: crypto.randomUUID() }), /活动词条/);
  await assert.rejects(
    db.addPractice({ ...practice, id: crypto.randomUUID() }),
    /活动词条/,
  );
  assert.equal((await db.reviews(word.id)).length, 1);
  assert.equal((await db.practice(word.id)).length, 1);
});

test("主题与正式词卡偏好并行保存，各自字段不被另一操作覆盖", async () => {
  const db = library();
  const preferences = defaultWorkspacePreferences();
  preferences.card.level = "complete";
  await Promise.all([
    db.saveWorkspaceMeta("workspace", preferences),
    db.updateSettings({ theme: "dark" }),
  ]);
  assert.deepEqual(await db.workspaceMeta("workspace"), preferences);
  assert.deepEqual(await db.settings(), { theme: "dark" });
  await assert.rejects(db.updateSettings({ dailyPlanLimit: 20 } as never), /允许范围/);
});

test("编辑冲突保留原值；错误采集不产生半条词；回收可以恢复", async () => {
  const db = library();
  const word = (await db.capture(input())).word;
  const edited = await db.editWord(word.id, word.revision, {
    note: "个人笔记",
  });
  assert.equal(edited.note, "个人笔记");
  await assert.rejects(
    db.editWord(word.id, word.revision, { note: "过期窗口" }),
    /另一窗口/,
  );
  assert.equal((await db.word(word.id))?.note, "个人笔记");
  await assert.rejects(
    db.capture({
      ...input(),
      savedExcerpt: "wrong",
      excerptRanges: [{ start: 0, end: 9 }],
    }),
    /精确包含/,
  );
  assert.equal((await db.encounters()).length, 1);
  await db.setDeleted(word.id, true);
  assert.equal((await db.listWords()).length, 0);
  await db.setDeleted(word.id, false);
  assert.equal((await db.listWords()).length, 1);
});

test("手工保存词典短语只增加单一本词条，不伪造网页遇见", async () => {
  const db = library();
  const first = await db.addWord("$2 shop", {
    meaning: "廉价杂货店",
    phonetic: "",
  });
  const repeated = await db.addWord("$2 SHOP");
  assert.equal(repeated.id, first.id);
  assert.equal((await db.listWords()).length, 1);
  assert.deepEqual(await db.encounters(), []);
});

test("多单词本关联共用同一词条，回收单词本不丢词，计划与备份保留稳定 ID", async () => {
  const db = library();
  const word = await db.addWord("resilient");
  const first = (await db.listNotebooks())[0]!;
  const second = await db.createNotebook("考试积累");
  const linked = await db.setWordNotebooks(word.id, word.revision, [first.id, second.id]);
  assert.deepEqual(linked.notebookIds, [first.id, second.id]);
  await db.updateNotebook(second.id, second.revision, { deleted: true });
  assert.equal((await db.listWords()).length, 1);
  assert.equal((await db.listNotebooks()).length, 1);
  const plan = {
    id: crypto.randomUUID(),
    sourceKind: "catalog" as const,
    sourceId: "book:qwerty:CET4_T",
    sourceVersion: "0.0.3" as const,
    dailyNew: 12,
    dailyReview: 20,
    startedOn: "2026-09-29",
    timeZone: "Asia/Shanghai",
    savedAt: new Date().toISOString(),
    paused: false,
  };
  await db.savePlan(plan);
  const backup = await localSnapshot(db);
  assert.equal(backup.notebooks.length, 2);
  assert.equal(backup.plan?.id, plan.id);
  assert.deepEqual(await db.practice(), []); // 保存目标不会伪造完成事件。
});

for (const version of [1, 2, 3])
  test(`预发布 IndexedDB ${version} 拒绝转换，版本、表结构与原事实完整保留`, async () => {
    const source = library();
    const word = (await source.capture(input())).word;
    const backup = await localSnapshot(source);
    const name = `leximeet-unsupported-${version}-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open(name, version);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        const meta = db.createObjectStore("meta");
        const words = db.createObjectStore("words", { keyPath: "id" });
        words.createIndex("normalized", "normalized", { unique: true });
        const encounters = db.createObjectStore("encounters", { keyPath: "id" });
        encounters.createIndex("wordId", "wordId");
        const reviews = db.createObjectStore("reviews", { keyPath: "id" });
        reviews.createIndex("wordId", "wordId");
        const practice = db.createObjectStore("practice", { keyPath: "id" });
        practice.createIndex("wordId", "wordId");
        if (version >= 2) db.createObjectStore("notebooks", { keyPath: "id" });
        if (version === 2) {
          db.createObjectStore("planCompletions", { keyPath: "id" }).put({
            id: "legacy-completion",
          });
        }
        meta.put(
          {
            ...backup.book,
            format: `leximeet-browser-personal/${version}`,
            name: version === 3 ? "浏览器插件词库" : "我的词本",
          },
          "book",
        );
        meta.put(backup.settings, "settings");
        const { notebookIds: _ids, ...oldWord } = backup.words[0]!;
        words.put(oldWord);
        encounters.put({
          ...backup.encounters[0]!,
          annotation: { note: "原笔记", meaningSupplement: "旧试验补充释义" },
        });
      };
      opening.onsuccess = () => {
        opening.result.close();
        resolve();
      };
      opening.onerror = () => reject(opening.error);
    });
    async function rawSnapshot() {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open(name);
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      const stores = Array.from(db.objectStoreNames);
      const tx = db.transaction(stores, "readonly");
      const rows = await Promise.all(
        stores.map(
          (store) =>
            new Promise((resolve, reject) => {
              const read = tx.objectStore(store).getAll();
              read.onsuccess = () => resolve(read.result);
              read.onerror = () => reject(read.error);
            }),
        ),
      );
      const result = { version: db.version, stores, rows };
      db.close();
      return result;
    }
    const original = await rawSnapshot();
    await assert.rejects(new LocalLibrary(name).book(), /版本不受支持/);
    assert.deepEqual(await rawSnapshot(), original);
    assert.equal(original.version, version);
    assert.equal(original.stores.includes("notebooks"), version >= 2);
  });

test("当前格式含多余旧表时拒绝打开，原词条和旧表不被清空", async () => {
  const name = `leximeet-unexpected-store-${crypto.randomUUID()}`;
  await new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open(name, PERSONAL_DB_VERSION);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      for (const store of [
        "meta",
        "words",
        "encounters",
        "reviews",
        "practice",
        "notebooks",
        "planCompletions",
      ]) {
        db.createObjectStore(store);
      }
      const tx = opening.transaction!;
      tx.objectStore("meta").put(
        { format: PERSONAL_FORMAT, name: "浏览器插件词库" },
        "book",
      );
      tx.objectStore("words").put(
        { id: "original-word", note: "须保留的原笔记" },
        "original-word",
      );
      tx.objectStore("planCompletions").put({ id: "legacy" }, "legacy");
    };
    opening.onsuccess = () => {
      opening.result.close();
      resolve();
    };
    opening.onerror = () => reject(opening.error);
  });
  await assert.rejects(new LocalLibrary(name).book(), /格式不完整/);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(name);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  try {
    assert.equal(db.version, PERSONAL_DB_VERSION);
    assert.equal(db.objectStoreNames.length, 7);
    const tx = db.transaction(["words", "planCompletions"]);
    const read = (store: string, key: string) =>
      new Promise<unknown>((resolve, reject) => {
        const request = tx.objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    assert.deepEqual(await read("words", "original-word"), {
      id: "original-word",
      note: "须保留的原笔记",
    });
    assert.deepEqual(await read("planCompletions", "legacy"), { id: "legacy" });
  } finally {
    db.close();
  }
});

test("加入指定单词本原子提交，幂等重放不会重复语境，无效本拒绝且保留原事实", async () => {
  const db = library();
  const notebook = await db.createNotebook("采集练习");
  const draft = { ...input(), notebookId: notebook.id };
  const first = await db.capture(draft);
  assert.deepEqual(first.word.notebookIds, [notebook.id]);
  await db.capture(draft);
  assert.equal((await db.encounters()).length, 1);
  const other = await db.createNotebook("第二本");
  await assert.rejects(db.capture({ ...draft, notebookId: other.id }), /内容不一致/);
  await db.setWordNotebooks(first.word.id, first.word.revision, [notebook.id, other.id]);
  assert.deepEqual(
    new Set((await db.listWords())[0]!.notebookIds),
    new Set([notebook.id, other.id]),
  );
  const before = await localSnapshot(db);
  await assert.rejects(
    db.capture({ ...input(), notebookId: crypto.randomUUID() }),
    /单词本不可用/,
  );
  const after = await localSnapshot(db);
  assert.deepEqual(after.words, before.words);
  assert.deepEqual(after.encounters, before.encounters);
});

test("规划只接受当前词书/词典和必填额度，旧大配额拒绝且原规划保留", async () => {
  const name = `current-plan-${crypto.randomUUID()}`,
    db = new LocalLibrary(name);
  const plan = {
    id: "plan",
    sourceKind: "catalog" as const,
    sourceId: "cet4",
    sourceVersion: "0.0.3" as const,
    dailyNew: 10,
    dailyReview: 20,
    startedOn: "2026-10-03",
    timeZone: "Asia/Shanghai",
    savedAt: "2026-10-03T00:00:00Z",
    paused: false,
  };
  await db.savePlan(plan, 0);
  const original = await db.plan();
  const missing = { ...plan } as any;
  delete missing.dailyReview;
  for (const invalid of [
    missing,
    { ...plan, dailyNew: 51 },
    { ...plan, dailyReview: 501 },
    { ...plan, sourceVersion: "0.0.2" },
    { ...plan, sourceKind: "notebook", sourceVersion: null },
  ]) {
    await assert.rejects(db.savePlan(invalid as any, 1), /学习规划内容无效/);
    assert.deepEqual(await db.plan(), original);
  }
  const handle = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(name);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  const oldQuota = { ...original, dailyNew: 100 };
  await new Promise<void>((resolve, reject) => {
    const tx = handle.transaction("meta", "readwrite");
    tx.objectStore("meta").put(oldQuota, "studyPlan");
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
  await assert.rejects(db.plan(), /原数据未修改/);
  await assert.rejects(db.savePlan(null), /原数据未修改/);
  const preserved = await new Promise((resolve, reject) => {
    const read = handle
      .transaction("meta", "readonly")
      .objectStore("meta")
      .get("studyPlan");
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
  assert.deepEqual(preserved, oldQuota);
  handle.close();
});
