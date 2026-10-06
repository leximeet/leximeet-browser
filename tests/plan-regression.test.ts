import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalLibrary } from "../lib/local-database.ts";
import {
  learningDaily,
  learningLibrary,
  learningPreview,
  learningProgress,
} from "../lib/learning-workspace.ts";
import { LEARNING_VERSION, learningDay, type LearningEvent } from "../lib/learning.ts";
import type { PracticeAttempt, StudyPlan } from "../lib/local-model.ts";
import type { CatalogMember } from "../lib/lexicon.ts";

const member = (word: string, position = 1): CatalogMember => ({
  word,
  position,
  entryId: "entry-" + word,
  meaning: "词义",
  senseIds: [],
  matchMethod: "dictionary",
});
const now = new Date("2026-10-01T08:00:00Z");
const plan: StudyPlan = {
  id: "plan",
  sourceId: "target",
  sourceKind: "catalog",
  sourceVersion: "0.0.3",
  dailyNew: 2,
  dailyReview: 1,
  startedOn: "2026-10-01",
  timeZone: "Asia/Shanghai",
  savedAt: now.toISOString(),
  paused: false,
};
// 构造当前学习事件，避免用旧的四档评价冒充已完成学习。
function attempt(
  wordId: string,
  sequence: number,
  at = now.toISOString(),
  changes: Partial<LearningEvent> = {},
): PracticeAttempt {
  const id = `${wordId}-${sequence}`;
  const event: LearningEvent = {
    id,
    submissionId: id,
    attemptId: id,
    wordId,
    entryId: null,
    mode: "recall",
    signal: "answer",
    correct: true,
    assisted: false,
    createdAt: at,
    studyDay: learningDay(new Date(at), plan.timeZone),
    zone: plan.timeZone,
    ruleVersion: LEARNING_VERSION,
    deviceId: "plan-regression",
    deviceSeq: sequence,
    logicalClock: sequence,
    origin: "practice",
    evidence: { expected: "word", answer: "word" },
    reviewCompleted: false,
    undoneAt: null,
    ...changes,
  };
  return {
    id,
    wordId,
    entryId: null,
    mode: event.mode,
    answer: "word",
    correct: event.correct,
    durationMs: 0,
    createdAt: at,
    learning: event,
  };
}
const graduate = (wordId: string, at = now.toISOString()) =>
  Array.from({ length: 5 }, (_, index) => attempt(wordId, index + 1, at));

test("跨目标、回收和同题重复共享当天毕业额度，撤销毕业事件重新计算", async () => {
  const db = new LocalLibrary("daily-quota-" + crypto.randomUUID());
  const first = await db.addWord("book", null, false);
  const previous = await db.addWord("attention", null, false);
  const practice = [
    ...graduate(first.id),
    ...graduate(previous.id, "2026-09-29T07:00:00Z"),
    attempt(previous.id, 6, now.toISOString(), { reviewCompleted: true }),
  ];
  practice.push(practice[4]!); // 同题重放不会重复毕业和扣额度。
  const target = [member("resource"), member("system")];
  const list = learningLibrary(target, await db.listWords(), [], [], practice, now);
  const daily = learningDaily(list, [], practice, plan, now);
  assert.equal(daily.newDone, 1);
  assert.equal(daily.reviewDone, 1);
  assert.equal(daily.completed, 2);
  assert.equal(daily.planned.length, 1);
  await db.setDeleted(first.id, true);
  const recycled = learningLibrary(
    target,
    await db.listWords(true),
    [],
    [],
    practice,
    now,
  );
  assert.equal(learningDaily(recycled, [], practice, plan, now).newDone, 1);
  const undone = practice.map((p) =>
    p.learning?.attemptId === `${first.id}-5`
      ? { ...p, learning: { ...p.learning, undoneAt: now.toISOString() } }
      : p,
  );
  const restored = learningLibrary(target, await db.listWords(true), [], [], undone, now);
  assert.equal(learningDaily(restored, [], undone, plan, now).remainingNew, 2);
  assert.equal(
    learningProgress(graduate("future", "2026-10-02T08:00:00Z"), plan.timeZone, now)
      .newDone,
    0,
  );
  assert.equal(
    learningProgress([attempt("just-started", 1)], plan.timeZone, now).newDone,
    0,
  );
});

test("毕业与复习按规划时区自然日分类，午夜前后不重复扣额度", () => {
  const practice = [
    ...graduate("one", "2026-09-30T15:59:59Z"),
    attempt("one", 6, "2026-09-30T16:00:01Z", { reviewCompleted: true }),
  ];
  const afterMidnight = new Date("2026-09-30T16:00:02Z");
  const shanghai = learningProgress(practice, "Asia/Shanghai", afterMidnight);
  assert.equal(shanghai.today, "2026-10-01");
  assert.equal(shanghai.newDone, 0);
  assert.equal(shanghai.reviewDone, 1);
  const utc = learningProgress(practice, "UTC", afterMidnight);
  assert.equal(utc.newDone, 1);
  assert.equal(utc.reviewDone, 0);
});

test("复习上限保留最早已具资格的到期词，而非词书顺序", async () => {
  const db = new LocalLibrary("due-order-" + crypto.randomUUID());
  const late = await db.addWord("book", null, false);
  const early = await db.addWord("system", null, false);
  const practice = [
    ...graduate(late.id, "2026-09-30T10:00:00Z"),
    ...graduate(early.id, "2026-09-29T09:00:00Z"),
  ];
  const list = learningLibrary(
    [member("book", 1), member("system", 2)],
    await db.listWords(),
    [],
    [],
    practice,
    now,
  );
  assert.deepEqual(
    learningDaily(list, [], practice, plan, now).review.map((i) => i.key),
    ["system"],
  );
});

test("规划预览按真正毕业和当天额度计算，与今日候选一致", async () => {
  const db = new LocalLibrary("plan-forecast-" + crypto.randomUUID());
  const first = await db.addWord("book", null, false);
  const practice = graduate(first.id);
  const list = learningLibrary(
    [member("book"), member("system"), member("resource")],
    await db.listWords(),
    [],
    [],
    practice,
    now,
  );
  const preview = learningPreview(list, practice, plan, now);
  assert.equal(preview.remaining, 2);
  assert.equal(preview.days, 2);
  assert.deepEqual(preview.firstDays, [
    { day: "2026-10-01", count: 1 },
    { day: "2026-10-02", count: 1 },
  ]);
  assert.equal(
    preview.firstDays[0]!.count,
    learningDaily(list, [], practice, plan, now).planned.length,
  );
  assert.equal(preview.endOn, "2026-10-02");
  const exhausted = learningPreview(
    list,
    [...practice, ...graduate("other-target")],
    plan,
    now,
  );
  assert.equal(exhausted.firstDays[0]!.count, 0);
  assert.equal(exhausted.firstDays[1]!.count, 2);
});

test("夏令时规划按自然日推进，空范围不显示虚假的未来计划", () => {
  const list = learningLibrary(
    ["book", "system", "resource"].map((word) => member(word)),
    [],
    [],
    [],
    [],
    now,
  );
  const preview = learningPreview(
    list,
    [],
    { dailyNew: 1, timeZone: "America/New_York" },
    new Date("2026-11-01T04:30:00Z"),
  );
  assert.deepEqual(
    preview.firstDays.map((d) => d.day),
    ["2026-11-01", "2026-11-02", "2026-11-03"],
  );
  assert.equal(learningPreview([], [], plan, now).days, 0);
  assert.deepEqual(learningPreview([], [], plan, now).firstDays, []);
});
