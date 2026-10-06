import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalLibrary } from "../lib/local-database.ts";
import {
  learningEvents,
  projectFsrs,
  type FrozenQuestion,
} from "../lib/learning-repository.ts";
import { projectLearning } from "../lib/learning.ts";
import {
  learningLibrary,
  learningDaily,
  learningPreview,
} from "../lib/learning-workspace.ts";
import { FSRS_ALGORITHM } from "../lib/fsrs.ts";
import type { PracticeMode } from "../lib/practice-session.ts";
const BASE = "2026-10-02T00:00:00.000Z";
function setup() {
  let now = new Date(BASE);
  const name = "learning-" + crypto.randomUUID(),
    db = new LocalLibrary(name, () => now);
  return {
    db,
    name,
    set: (s: string) => {
      now = new Date(s);
    },
  };
}
function q(
  id: string,
  mode: PracticeMode = "recall",
  wordId: string | null = null,
): FrozenQuestion {
  return {
    attemptId: id,
    wordId,
    entryId: "public-resilient",
    word: "resilient",
    meaning: "有韧性的",
    phonetic: "",
    mode,
    ignoreCase: true,
    options:
      mode === "meaning-choice"
        ? [
            { id: "right", text: "有韧性的" },
            { id: "wrong", text: "系统" },
          ]
        : [],
    correctChoiceId: mode === "meaning-choice" ? "right" : null,
    sentence: "A resilient learner.",
  };
}
async function answer(
  db: LocalLibrary,
  id: string,
  mode: PracticeMode = "recall",
  wordId: string | null = null,
  correct = true,
) {
  await db.learning.freeze(q(id, mode, wordId));
  return db.learning.submit({
    submissionId: crypto.randomUUID(),
    attemptId: id,
    ...(mode === "word-list"
      ? { signal: correct ? ("familiar" as const) : ("unfamiliar" as const) }
      : mode === "meaning-choice"
        ? { choiceId: correct ? "right" : "wrong" }
        : { answer: correct ? "resilient" : "wrong" }),
  });
}

test("六方式判题由仓库执行：不同加分、同题防重、错误订正不补分、临摹不写 FSRS", async () => {
  for (const mode of [
    "word-list",
    "meaning-choice",
    "copy",
    "recall",
    "listening",
    "cloze",
  ] as PracticeMode[]) {
    const { db } = setup();
    const first = await answer(db, "a", mode);
    assert.equal(first.delta, ["recall", "cloze"].includes(mode) ? 2 : 1);
    assert.equal((await db.reviews()).length, mode === "copy" ? 0 : 1);
    const again = await db.learning.submit({
      submissionId: "second",
      attemptId: "a",
      ...(mode === "word-list"
        ? { signal: "familiar" as const }
        : mode === "meaning-choice"
          ? { choiceId: "right" }
          : { answer: "resilient" }),
    });
    assert.equal(again.delta, 0);
    assert.equal((await db.reviews()).length, mode === "copy" ? 0 : 1);
  }
  const { db } = setup();
  const failed = await answer(db, "mistake", "recall", null, false);
  assert.equal(failed.score, 9);
  const correction = await db.learning.submit({
    submissionId: "correction",
    attemptId: "mistake",
    answer: "resilient",
  });
  assert.equal(correction.score, 9);
  assert.equal(correction.effective, false);
  await assert.rejects(
    db.learning.submit({
      submissionId: "fake",
      attemptId: "mistake",
      answer: "resilient",
      correct: true,
    } as any),
    /未知字段/,
  );
  const events = learningEvents(await db.practice());
  assert.equal(projectLearning(events, new Date(BASE)).independent, 0);
});
test("揭示先减一分：辅助成功不补分；同提交重传只返回回执，冲突不写半条记录", async () => {
  const { db } = setup();
  await db.learning.freeze(q("hint", "cloze"));
  const reveal = await db.learning.submit({
    submissionId: "reveal",
    attemptId: "hint",
    signal: "reveal",
  });
  assert.equal(reveal.score, 9);
  const correction = await db.learning.submit({
    submissionId: "answer",
    attemptId: "hint",
    answer: "resilient",
    assisted: true,
  });
  assert.equal(correction.delta, 0);
  assert.equal((await db.reviews()).length, 0);
  const replay = await db.learning.submit({
    submissionId: "answer",
    attemptId: "hint",
    answer: "resilient",
    assisted: true,
  });
  assert.equal(replay.duplicate, true);
  await assert.rejects(
    db.learning.submit({
      submissionId: "answer",
      attemptId: "hint",
      answer: "wrong",
      assisted: true,
    }),
    /提交标识/,
  );
  assert.equal((await db.practice()).length, 2);
  assert.equal((await db.listWords()).length, 1);
  await db.learning.freeze(q("bad-choice", "meaning-choice"));
  await assert.rejects(
    db.learning.submit({
      submissionId: "not-offered",
      attemptId: "bad-choice",
      choiceId: "invented",
    }),
    /本题提供/,
  );
  assert.equal((await db.practice()).length, 2);
});
test("临摹毕业、明日回忆、完成额度与目标去重；暂停计划仍能继续，离线衰减不伪造失败", async () => {
  const { db, set } = setup();
  const target = [
    {
      entryId: "public-resilient",
      word: "resilient",
      meaning: "有韧性的",
      position: 1,
      senseIds: [],
      matchMethod: "test",
    },
  ];
  const plan = {
    id: "plan",
    sourceKind: "catalog" as const,
    sourceId: "cet4",
    sourceVersion: "0.0.3" as const,
    dailyNew: 10,
    dailyReview: 20,
    startedOn: "2026-10-02",
    timeZone: "Asia/Shanghai",
    savedAt: BASE,
    paused: false,
  };
  await db.savePlan(plan, 0);
  for (let i = 0; i < 10; i++) await answer(db, "copy" + i, "copy");
  const all = () =>
    Promise.all([db.listWords(true), db.encounters(), db.reviews(), db.practice()]);
  let [w, e, r, p] = await all(),
    items = learningLibrary(target, w, e, r, p, new Date(BASE));
  assert.equal(items[0]!.status, "review");
  assert.equal(items[0]!.familiarity!.score, 20);
  assert.equal(r.length, 0);
  assert.equal(items[0]!.dueAt, "2026-10-02T16:00:00.000Z");
  assert.equal(learningDaily(items, e, p, plan, new Date(BASE)).newDone, 1);
  assert.equal(learningDaily(items, e, p, plan, new Date(BASE)).review.length, 0);
  assert.equal(learningPreview(items, p, plan, new Date(BASE)).remaining, 0);
  set("2026-10-02T16:00:00.000Z");
  [w, e, r, p] = await all();
  items = learningLibrary(target, w, e, r, p, new Date("2026-10-02T16:00:00Z"));
  assert.equal(
    learningDaily(items, e, p, plan, new Date("2026-10-02T16:00:00Z")).review.length,
    1,
  );
  await answer(db, "next-day", "recall");
  [w, e, r, p] = await all();
  items = learningLibrary(target, w, e, r, p, new Date("2026-10-02T16:00:00Z"));
  assert.equal(
    learningDaily(items, e, p, plan, new Date("2026-10-02T16:00:00Z")).reviewDone,
    1,
  );
  for (let i = 0; i < 4; i++) await answer(db, "master" + i);
  [w, e, r, p] = await all();
  items = learningLibrary(target, w, e, r, p, new Date("2026-10-02T16:00:00Z"));
  assert.equal(items[0]!.status, "mastered");
  const count = r.length;
  items = learningLibrary(target, w, e, r, p, new Date("2026-10-25T16:00:00Z"));
  assert.equal(items[0]!.familiarity!.score, 20);
  assert.equal(items[0]!.status, "review");
  assert.equal((await db.reviews()).length, count);
  // 目标切换仍保留实际学习行，公共目标预览不创建个人词。
  assert.equal(
    learningLibrary([], w, e, r, p, new Date("2026-10-25T16:00:00Z")).length,
    1,
  );
  const untouched = learningLibrary(
    [{ ...target[0]!, entryId: "system", word: "system" }],
    w,
    e,
    r,
    p,
    new Date(BASE),
  );
  assert.equal(
    learningDaily(
      untouched,
      e,
      p,
      { ...plan, paused: true },
      new Date(BASE),
    ).planned.some((i) => i.word === "system"),
    false,
  );
});
test("提前答对不改 FSRS 到期；时钟回退事务回滚；最新撤销回退分数和关联调度", async () => {
  const { db, set } = setup();
  const first = await answer(db, "one");
  const due = (await db.reviews())[0]!.afterState!.dueAt;
  await answer(db, "two");
  assert.equal((await db.reviews()).length, 1);
  assert.equal(projectFsrs(BASE, await db.reviews()).dueAt, due);
  set("2026-10-01T23:59:59Z");
  await db.learning.freeze(q("back"));
  await assert.rejects(
    db.learning.submit({
      submissionId: "back",
      attemptId: "back",
      answer: "resilient",
    }),
    /系统时间/,
  );
  assert.equal((await db.practice()).length, 2);
  set(BASE);
  const third = await answer(db, "three", "recall", null, false);
  assert.equal((await db.reviews()).length, 2);
  await assert.rejects(db.learning.undo(first.event.id), /最新/);
  await db.learning.undo(third.event.id);
  assert.equal(
    projectLearning(learningEvents(await db.practice()), new Date(BASE)).score,
    14,
  );
  assert.equal((await db.reviews()).filter((f) => !f.undoneAt).length, 1);
});
test("规划同事务校验版本：冲突或无效额度不覆盖目标；单独调整保留计划身份", async () => {
  const { db } = setup();
  const plan = {
    id: "plan",
    sourceKind: "catalog" as const,
    sourceId: "cet4",
    sourceVersion: "0.0.3" as const,
    dailyNew: 10,
    dailyReview: 20,
    startedOn: "2026-10-02",
    timeZone: "Asia/Shanghai",
    savedAt: BASE,
    paused: false,
  };
  await db.savePlan(plan, 0);
  const before = await db.plan();
  assert.equal(before!.revision, 1);
  await assert.rejects(db.savePlan({ ...plan, sourceId: "ielts" }, 0), /另一窗口/);
  assert.deepEqual(await db.plan(), before);
  await assert.rejects(db.savePlan({ ...plan, dailyNew: 51 }, 1), /1–50/);
  assert.deepEqual(await db.plan(), before);
  await db.savePlan({ ...plan, dailyNew: 15, paused: true }, 1);
  assert.equal((await db.plan())!.id, "plan");
  assert.equal((await db.plan())!.revision, 2);
});
test("缺失、未知及旧候选学习标记拒绝保留，不建立备份或确认流程", async () => {
  for (const marker of [
    undefined,
    { ruleVersion: "unknown", revision: 1, sequence: 0 },
    {
      ruleVersion: "leximeet.learning/2",
      pending: true,
      legacyWords: 1,
      revision: 1,
      sequence: 0,
    },
  ]) {
    const { db, name } = setup();
    const word = await db.addWord("resilient");
    await answer(db, "current", "recall", word.id);
    const reviews = await db.reviews(),
      practice = await db.practice();
    const handle = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = handle.transaction("meta", "readwrite"),
        meta = tx.objectStore("meta");
      if (marker === undefined) meta.delete("learning");
      else meta.put(marker, "learning");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    await assert.rejects(new LocalLibrary(name).book(), /无法识别/);
    await assert.rejects(db.learning.state(), /无法识别/);
    await assert.rejects(
      db.learning.freeze(q("after-invalid", "recall", word.id)),
      /无法识别/,
    );
    const read = (key: string) =>
      new Promise((resolve, reject) => {
        const request = handle
          .transaction("meta", "readonly")
          .objectStore("meta")
          .get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    assert.deepEqual(await read("learning"), marker);
    assert.equal(await read("learning-backup"), undefined);
    assert.deepEqual(await db.reviews(), reviews);
    assert.deepEqual(await db.practice(), practice);
    assert.equal((await db.word(word.id))!.word, "resilient");
    handle.close();
  }
});

test("当前 FSRS 跨实例重放；旧候选与未知算法拒绝且原评价不改写", async () => {
  for (const algorithmVersion of ["fsrs-6/browser-1", "unknown-fsrs/99"]) {
    const { db, name } = setup();
    const word = await db.addWord("resilient");
    await answer(db, "current", "recall", word.id);
    assert.equal(projectFsrs(BASE, await db.reviews()).round, 2);
    assert.equal(
      (await new LocalLibrary(name).reviews())[0]!.algorithmVersion,
      FSRS_ALGORITHM,
    );
    const fact = {
      id: "unknown",
      wordId: word.id,
      rating: "good" as const,
      createdAt: BASE,
      undoneAt: null,
      algorithmVersion,
    };
    await assert.rejects(db.addReview(fact), /事实无效/);
    const handle = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = handle.transaction("reviews", "readwrite");
      tx.objectStore("reviews").put(fact);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    const original = await db.reviews();
    assert.throws(() => projectFsrs(BASE, original), /未知算法/);
    await assert.rejects(new LocalLibrary(name).book(), /未知算法/);
    assert.deepEqual(await db.reviews(), original);
    handle.close();
  }
});

test("并发重复提交只有一条事实；同题订正不会重复调度，揭示不可自报为独立答案", async () => {
  const { db } = setup();
  await db.learning.freeze(q("concurrent", "recall"));
  const input = {
    submissionId: "same-command",
    attemptId: "concurrent",
    answer: "resilient",
  };
  const receipts = await Promise.all([
    db.learning.submit(input),
    db.learning.submit(input),
  ]);
  assert.equal(receipts.filter((r) => r.duplicate).length, 1);
  assert.equal((await db.practice()).length, 1);
  assert.equal((await db.reviews()).length, 1);
  await db.learning.freeze(q("assisted", "recall"));
  await db.learning.submit({
    submissionId: "hint",
    attemptId: "assisted",
    signal: "reveal",
  });
  const correction = await db.learning.submit({
    submissionId: "guess",
    attemptId: "assisted",
    answer: "resilient",
    assisted: false,
  });
  assert.equal(correction.event.assisted, true);
  assert.equal(correction.delta, 0);
  assert.equal(correction.score, 11);
  assert.equal((await db.reviews()).length, 1);
});

test("确认遇见优先不限于今日；无效预览不抛日期错误", async () => {
  const { db } = setup();
  const word = await db.addWord("resilient");
  const encounters = [
    { wordId: word.id, occurredAt: "2026-09-30T00:00:00Z", undoneAt: null },
  ] as any;
  const items = learningLibrary(
    [],
    await db.listWords(),
    encounters,
    [],
    [],
    new Date(BASE),
  );
  assert.equal(
    learningDaily(items, encounters, [], null, new Date(BASE)).encountered.length,
    1,
  );
  assert.equal(
    learningPreview(items, [], { dailyNew: NaN, timeZone: "UTC" }, new Date(BASE))
      .firstDays[0]!.count,
    1,
  );
});

test("词典资源切回后保留公共关联与私人学习，题目冻结不随当前字典重复生成", async () => {
  const { LearningService } = await import("../lib/learning-service.ts");
  const { db } = setup();
  const word = await db.addWord(
    "resilient",
    { meaning: "有韧性的", phonetic: "" },
    true,
    "core-only-id",
  );
  const item = learningLibrary([], await db.listWords(), [], [], [], new Date(BASE))[0]!;
  const service = new LearningService(db.learning, {
    lookupAll: async () => [],
    lookup: async () => null,
  } as any);
  const question = await service.prepare("private-round", item, "copy", true);
  assert.equal(question.entryId, "core-only-id");
  assert.equal(question.wordId, word.id);
  assert.equal(
    (await service.prepare("private-round", item, "copy", false)).ignoreCase,
    true,
  );
  const receipt = await db.learning.submit({
    submissionId: "missing-card",
    attemptId: question.attemptId,
    answer: "resilient",
  });
  assert.equal(receipt.score, 11);
  assert.equal((await db.reviews()).length, 0);
  const choice = await service.prepare("choice-round", item, "meaning-choice", true);
  assert.equal(choice.options.length, 0);
  await assert.rejects(
    db.learning.submit({
      submissionId: "fake-options",
      attemptId: choice.attemptId,
      choiceId: "invented",
    }),
    /提供的释义/,
  );
  assert.equal((await db.practice()).length, 1);
});

test("资格生效后提前独立成功计当日一次完成，FSRS不延长、自动队列仍等实际到期", async () => {
  const { db, set } = setup();
  await db.savePlan(
    {
      id: "due-plan",
      sourceKind: "catalog",
      sourceId: "cet4",
      sourceVersion: "0.0.3",
      dailyNew: 10,
      dailyReview: 20,
      startedOn: "2026-10-02",
      timeZone: "Asia/Shanghai",
      savedAt: BASE,
      paused: false,
    },
    0,
  );
  let now = new Date(BASE);
  for (let i = 0; i < 5; i++) {
    await answer(db, "graduation-" + i);
    if (i < 4) {
      const word = (await db.listWords())[0]!;
      now = new Date(projectFsrs(word.createdAt, await db.reviews()).dueAt);
      set(now.toISOString());
    }
  }
  const word = (await db.listWords())[0]!,
    graduated = projectLearning(learningEvents(await db.practice()), now),
    memory = projectFsrs(word.createdAt, await db.reviews()),
    earlyAt = new Date(Date.parse(graduated.reviewEligibleAt!) + 1000);
  assert.equal(graduated.score, 20);
  assert.ok(earlyAt.getTime() < Date.parse(memory.dueAt));
  const beforeEarlyReviews = await db.reviews();
  set(earlyAt.toISOString());
  const early = await answer(db, "early-review");
  assert.equal(early.delta, 2);
  assert.equal(early.score, 22);
  assert.equal(early.event.reviewCompleted, true);
  assert.equal(projectFsrs(word.createdAt, await db.reviews()).dueAt, memory.dueAt);
  assert.deepEqual(await db.reviews(), beforeEarlyReviews);
  const plan = await db.plan();
  const projection = async (at: Date) => {
    const practice = await db.practice(),
      encounters = await db.encounters();
    const items = learningLibrary(
      [],
      await db.listWords(),
      encounters,
      await db.reviews(),
      practice,
      at,
    );
    return learningDaily(items, encounters, practice, plan, at);
  };
  assert.equal((await projection(earlyAt)).reviewDone, 1);
  assert.equal((await projection(earlyAt)).review.length, 0);
  const sameDay = await answer(db, "same-day-early-question");
  assert.equal(sameDay.event.reviewCompleted, true);
  assert.equal(sameDay.score, 24);
  assert.equal((await projection(earlyAt)).reviewDone, 1);
  assert.deepEqual(await db.reviews(), beforeEarlyReviews);
  const correction = await answer(db, "same-day-early-question");
  assert.equal(correction.event.reviewCompleted, false);
  assert.equal(correction.delta, 0);
  assert.equal((await projection(earlyAt)).reviewDone, 1);
  await db.learning.undo(correction.event.id);
  await db.learning.undo(sameDay.event.id);
  assert.equal((await projection(earlyAt)).reviewDone, 1);
  assert.deepEqual(await db.reviews(), beforeEarlyReviews);
  set(memory.dueAt);
  const due = await answer(db, "actual-due-review");
  assert.equal(due.delta, 2);
  assert.equal(due.event.reviewCompleted, true);
  assert.equal((await projection(new Date(memory.dueAt))).reviewDone, 1);
  const repeated = await answer(db, "same-day-new-question");
  assert.equal(repeated.delta, 2);
  assert.equal(repeated.event.reviewCompleted, true);
  assert.equal((await projection(new Date(memory.dueAt))).reviewDone, 1);
  const scheduled = projectFsrs(word.createdAt, await db.reviews());
  await db.learning.undo(repeated.event.id);
  assert.equal((await projection(new Date(memory.dueAt))).reviewDone, 1);
  assert.deepEqual(projectFsrs(word.createdAt, await db.reviews()), scheduled);
  await db.learning.undo(due.event.id);
  assert.equal((await projection(new Date(memory.dueAt))).reviewDone, 0);
  assert.equal((await projection(earlyAt)).reviewDone, 1);
  assert.equal(projectFsrs(word.createdAt, await db.reviews()).dueAt, memory.dueAt);
});

test("复习完成仍排除资格前、同日初学、临摹、提示订正和满分休息中的词", async () => {
  const { db, set } = setup();
  await db.savePlan(
    {
      id: "eligibility-plan",
      sourceKind: "catalog",
      sourceId: "cet4",
      sourceVersion: "0.0.3",
      dailyNew: 10,
      dailyReview: 20,
      startedOn: "2026-10-02",
      timeZone: "UTC",
      savedAt: BASE,
      paused: false,
    },
    0,
  );
  for (let i = 0; i < 10; i++) await answer(db, "copy-graduate-" + i, "copy");
  const sameLearningDay = await answer(db, "same-graduation-day");
  assert.equal(sameLearningDay.event.reviewCompleted, false);
  set("2026-10-03T00:00:01.000Z");
  const copy = await answer(db, "qualified-copy", "copy");
  assert.equal(copy.event.reviewCompleted, false);
  await db.learning.freeze(q("qualified-reveal", "word-list"));
  const reveal = await db.learning.submit({
    submissionId: "reveal-id",
    attemptId: "qualified-reveal",
    signal: "reveal",
  });
  assert.equal(reveal.event.reviewCompleted, false);
  const assisted = await answer(db, "qualified-reveal", "word-list");
  assert.equal(assisted.event.reviewCompleted, false);
  const wrong = await answer(db, "wrong-before-correction", "recall", null, false);
  const corrected = await answer(db, "wrong-before-correction");
  assert.equal(wrong.event.reviewCompleted, false);
  assert.equal(corrected.event.reviewCompleted, false);
  const qualified = await answer(db, "qualified-independent");
  assert.equal(qualified.event.reviewCompleted, true);
  for (let i = 0; i < 10; i++) await answer(db, "copy-to-rest-" + i, "copy");
  assert.equal(
    projectLearning(learningEvents(await db.practice()), new Date("2026-10-03T00:00:01Z"))
      .status,
    "mastered",
  );
  const resting = await answer(db, "resting-independent");
  assert.equal(resting.event.reviewCompleted, false);
});

test("单日可以练习一百次以上，分数只夹在零到三十，同题重复点击仍不加分", async () => {
  const { db } = setup();
  for (let i = 0; i < 100; i++) {
    const result = await answer(db, "copy-unlimited-" + i, "copy");
    assert.equal(result.effective, true);
    assert.equal(result.score, Math.min(30, 11 + i));
  }
  const same = await db.learning.submit({
    submissionId: crypto.randomUUID(),
    attemptId: "copy-unlimited-99",
    answer: "resilient",
  });
  assert.equal(same.score, 30);
  assert.equal(same.delta, 0);
  assert.equal(same.effective, false);
  for (let i = 0; i < 100; i++) {
    const result = await answer(
      db,
      "unfamiliar-unlimited-" + i,
      "word-list",
      null,
      false,
    );
    assert.equal(result.effective, true);
    assert.equal(result.score, Math.max(0, 29 - i));
  }
  assert.equal((await db.practice()).length, 201);
});
