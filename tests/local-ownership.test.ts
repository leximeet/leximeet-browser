import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalLibrary } from "../lib/local-database.ts";
import { FSRS_ALGORITHM } from "../lib/fsrs.ts";
import { initializeLearning, type FrozenQuestion } from "../lib/learning-repository.ts";
import {
  beginIndependentWrite,
  independentWriteFailure,
  INDEPENDENT_OWNERSHIP_KEY,
  IndependentWorkspaceFrozenError,
} from "../lib/local-ownership.ts";
import { defaultWorkspacePreferences } from "../lib/workspace-model.ts";
import type { CaptureInput } from "../lib/local-model.ts";
import { localSnapshot } from "./helpers/local-snapshot.ts";

function setup() {
  const name = `ownership-${crypto.randomUUID()}`;
  return {
    name,
    first: new LocalLibrary(name),
    second: new LocalLibrary(name),
  };
}
function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const frozen = (error: unknown) => error instanceof IndependentWorkspaceFrozenError;
const question = (wordId: string, attemptId = crypto.randomUUID()): FrozenQuestion => ({
  attemptId,
  wordId,
  entryId: null,
  word: "resilient",
  meaning: "有韧性的",
  phonetic: "",
  mode: "recall",
  ignoreCase: true,
  options: [],
  correctChoiceId: null,
  sentence: "A resilient learner returns.",
});
function capture(): CaptureInput {
  return {
    eventId: crypto.randomUUID(),
    surface: "resilient",
    originalSentence: "A resilient learner returns.",
    savedExcerpt: "A resilient learner returns.",
    occurrenceRanges: [{ start: 2, end: 11 }],
    excerptRanges: [{ start: 2, end: 11 }],
    annotation: { note: "" },
    source: { title: "阅读页", url: "https://example.org/read" },
    occurredAt: new Date().toISOString(),
    timeZone: "Asia/Shanghai",
    dictionary: { meaning: "有韧性的", phonetic: "" },
  };
}
async function allRecords(db: IDBDatabase) {
  const result: Record<string, unknown> = {};
  for (const name of [...db.objectStoreNames]) {
    result[name] = await new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readonly"),
        store = tx.objectStore(name);
      const keys = store.getAllKeys(),
        values = store.getAll();
      tx.oncomplete = () => resolve(keys.result.map((key, i) => [key, values.result[i]]));
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }
  return result;
}

test("封存幂等、跨实例读取；只有匹配封存 token 才能恢复后一次连接", async () => {
  const { first, second } = setup();
  await first.addWord("resilient");
  assert.equal((await first.independentOwnership()).state, "independent");
  const archive = await first.freezeIndependent();
  assert.equal(archive.state, "frozen");
  assert.ok(archive.archiveId);
  assert.deepEqual(await second.independentOwnership(), archive);
  assert.deepEqual(await second.freezeIndependent(), archive);
  await assert.rejects(second.resumeIndependent(crypto.randomUUID()), /封存标识已变化/);
  const resumed = await second.resumeIndependent(archive.archiveId!);
  assert.equal(resumed.state, "independent");
  assert.equal(resumed.generation, archive.generation + 1);
  const later = await second.freezeIndependent();
  await assert.rejects(first.resumeIndependent(archive.archiveId!), /封存标识已变化/);
  assert.deepEqual(await first.independentOwnership(), later);
  await first.resumeIndependent(later.archiveId!);
  assert.equal((await second.addWord("system")).word, "system");
});

test("连接封存后采集、偏好、练习、词条与词本修改全部拒绝，业务资料保持原值", async () => {
  const { first, second } = setup();
  const word = await first.addWord("resilient"),
    notebook = (await first.listNotebooks())[0]!;
  const prepared = await first.learning.freeze(question(word.id));
  const review = {
    id: crypto.randomUUID(),
    wordId: word.id,
    rating: "good" as const,
    createdAt: new Date().toISOString(),
    undoneAt: null,
    algorithmVersion: FSRS_ALGORITHM,
  };
  const practice = {
    id: crypto.randomUUID(),
    wordId: word.id,
    entryId: null,
    mode: "copy" as const,
    answer: "resilient",
    correct: true,
    durationMs: 100,
    createdAt: new Date().toISOString(),
  };
  await first.addReview(review);
  await first.addPractice(practice);
  const baseline = await localSnapshot(first);
  const archive = await first.freezeIndependent();
  const operations: (() => Promise<unknown>)[] = [
    () => second.capture(capture()),
    () => second.addWord("system"),
    () => second.editWord(word.id, word.revision, { note: "不应保存" }),
    () => second.setDeleted(word.id, true),
    () =>
      second.updatePersonalWords(
        [
          {
            word: word.word,
            entryId: word.entryId || null,
            dictionaryHint: word.dictionaryHint,
            expectedRevision: word.revision,
          },
        ],
        { kind: "recycle" },
      ),
    () => second.setWordNotebooks(word.id, word.revision, [notebook.id]),
    () => second.createNotebook("新词本"),
    () =>
      second.updateNotebook(notebook.id, notebook.revision, {
        name: "不可更名",
      }),
    () => second.updateSettings({ theme: "dark" }),
    () => second.saveWorkspaceMeta("workspace", defaultWorkspacePreferences()),
    () => second.saveWorkspaceMeta("checkpoints", {}),
    () => second.savePlan(null),
    () => second.addReview({ ...review, id: crypto.randomUUID() }),
    () => second.undoReview(review.id),
    () => second.addPractice({ ...practice, id: crypto.randomUUID() }),
    () => second.learning.freeze(question(word.id)),
    () =>
      second.learning.submit({
        attemptId: prepared.attemptId,
        submissionId: crypto.randomUUID(),
        answer: "resilient",
      }),
    () => second.learning.undo(practice.id),
  ];
  for (const operation of operations) await assert.rejects(operation(), frozen);
  assert.deepEqual(await localSnapshot(second), baseline);
  assert.deepEqual(await second.learning.question(prepared.attemptId), prepared);
  await first.resumeIndependent(archive.archiveId!);
  await second.updateSettings({ theme: "dark" });
  const submitted = await second.learning.submit({
    attemptId: prepared.attemptId,
    submissionId: crypto.randomUUID(),
    answer: "resilient",
  });
  assert.equal(submitted.score, 12);
  assert.equal((await second.capture(capture())).duplicate, false);
});

test("事务首请求校验与封存共用 meta 锁，跨实例在途业务先提交，后续业务全部回滚", async () => {
  const { name, first, second } = setup();
  await first.book();
  await second.book();
  const handle = await open(name);
  try {
    // 同一事务内排队写；封存不能穿插到归属检查和实际 put 中间。
    const earlier = new Promise<void>((resolve, reject) => {
      const tx = beginIndependentWrite(handle, "meta");
      tx.objectStore("meta").put(
        { ...defaultWorkspacePreferences(), insights: ["learned"] },
        "workspace",
      );
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(independentWriteFailure(tx, new Error("失败")));
    });
    const archivePromise = second.freezeIndependent();
    await earlier;
    await archivePromise;
    const baseline = await allRecords(handle);
    const writes = await Promise.allSettled(
      Array.from({ length: 12 }, (_unused, i) =>
        (i % 2 ? first : second).updateSettings({
          theme: i % 3 ? "dark" : "light",
        }),
      ),
    );
    assert.ok(
      writes.every((result) => result.status === "rejected" && frozen(result.reason)),
    );
    assert.deepEqual(await allRecords(handle), baseline);
    assert.deepEqual((await first.workspaceMeta<any>("workspace"))?.insights, [
      "learned",
    ]);
  } finally {
    handle.close();
  }
});

test("封存资料重新打开只读初始化；缺失学习状态时拒绝隐式初始化且不生成备份", async () => {
  const { name, first } = setup();
  await first.addWord("resilient");
  await first.freezeIndependent();
  const handle = await open(name);
  try {
    const baseline = await allRecords(handle);
    const reopened = new LocalLibrary(name);
    assert.equal((await reopened.listWords()).length, 1);
    await initializeLearning(handle);
    assert.deepEqual(await allRecords(handle), baseline);
    await new Promise<void>((resolve, reject) => {
      const tx = handle.transaction("meta", "readwrite");
      tx.objectStore("meta").delete("learning");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    const incomplete = await allRecords(handle);
    await assert.rejects(initializeLearning(handle), /学习资料版本无法识别/);
    await assert.rejects(new LocalLibrary(name).book(), /学习资料版本无法识别/);
    assert.deepEqual(await allRecords(handle), incomplete);
  } finally {
    handle.close();
  }
});

test("未知归属格式拒绝业务修改，原事实与控制记录保留", async () => {
  const { name, first } = setup();
  await first.addWord("resilient");
  const handle = await open(name);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = handle.transaction("meta", "readwrite");
      tx.objectStore("meta").put(
        { format: "unknown/99", state: "independent" },
        INDEPENDENT_OWNERSHIP_KEY,
      );
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    const baseline = await allRecords(handle);
    await assert.rejects(first.addWord("system"), /归属记录无法识别/);
    await assert.rejects(first.freezeIndependent(), /归属记录无法识别/);
    assert.deepEqual(await allRecords(handle), baseline);
  } finally {
    handle.close();
  }
});
