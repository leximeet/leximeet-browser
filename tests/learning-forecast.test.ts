import test from "node:test";
import assert from "node:assert/strict";
import { learningForecast, learningActivity } from "../lib/learning-forecast.ts";
import { learningLibrary } from "../lib/learning-workspace.ts";
import { LEARNING_VERSION, type LearningEvent } from "../lib/learning.ts";
import type { PracticeAttempt, StudyPlan } from "../lib/local-model.ts";
const now = new Date("2026-03-07T23:30:00Z");
const plan: StudyPlan = {
  id: "forecast",
  sourceKind: "catalog",
  sourceId: "demo",
  sourceVersion: "0.0.3",
  dailyNew: 3,
  dailyReview: 20,
  startedOn: "2026-03-01",
  timeZone: "America/New_York",
  savedAt: now.toISOString(),
  paused: false,
};
function items(count = 8) {
  return learningLibrary(
    Array.from({ length: count }, (_, i) => ({
      entryId: `id-${i}`,
      word: `word-${i}`,
      meaning: "词",
      position: i + 1,
      senseIds: [],
      matchMethod: "exact",
    })),
    [],
    [],
    [],
    [],
    now,
  );
}
test("额度推演采用规划日历、最后一天不超目标，预览不修改学习事实", () => {
  const source = items(),
    before = JSON.stringify(source),
    model = learningForecast(source, [], plan, now);
  assert.equal(model.total, 8);
  assert.equal(model.days, 3);
  assert.equal(model.endOn, "2026-03-09");
  assert.deepEqual(
    [0, 1, 2].map((n) => model.preview(n).map((i) => i.word)),
    [
      ["word-0", "word-1", "word-2"],
      ["word-3", "word-4", "word-5"],
      ["word-6", "word-7"],
    ],
  );
  assert.equal(model.states.find((state) => state.id === "new")!.count, 8);
  assert.equal(model.dayAt(1), "2026-03-08"); // 夏令时切换仍按自然日递增。
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(model.preview(-1), []);
  assert.deepEqual(model.preview(3), []);
});
test("只推演当前活动目标，已初学不重复排，暂停时不虚增覆盖", () => {
  const source = items();
  source[0]!.familiarity!.graduatedAt = now.toISOString();
  source[1]!.inTarget = false;
  const model = learningForecast(source, [], plan, now);
  assert.equal(model.total, 7);
  assert.equal(model.completed, 1);
  assert.equal(model.remaining, 6);
  assert.equal(model.preview(0)[0]!.word, "word-2");
  assert.equal(
    model.states.reduce((sum, state) => sum + state.count, 0),
    7,
  );
  const paused = learningForecast(source, [], { ...plan, paused: true }, now);
  assert.equal(paused.days, 0);
  assert.equal(paused.endOn, null);
  assert.deepEqual(paused.preview(0), []);
  assert.equal(paused.completed, 1);
});
test("不同每日额度比较只读，不改变目标；大目标、空目标、非法额度安全", () => {
  const source = items(5000),
    before = JSON.stringify(source),
    original = structuredClone(plan);
  const model = learningForecast(source, [], { ...plan, dailyNew: 1 }, now);
  assert.equal(model.days, 5000);
  const faster = learningForecast(source, [], plan, now, 20);
  assert.equal(faster.days, 250);
  assert.equal(faster.preview(0).length, 20);
  assert.equal(learningForecast(source, [], plan, now, NaN).daily, 3);
  assert.equal(learningForecast(source, [], plan, now, 51).daily, 3);
  assert.equal(learningForecast([], [], plan, now).days, 0);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(plan, original);
});
function attempt(
  sequence: number,
  changes: Partial<LearningEvent> = {},
): PracticeAttempt {
  const event: LearningEvent = {
    id: `event-${sequence}`,
    submissionId: `submission-${sequence}`,
    attemptId: `question-${sequence}`,
    wordId: "word-one",
    entryId: "entry-one",
    mode: "recall",
    signal: "answer",
    correct: true,
    assisted: false,
    createdAt: now.toISOString(),
    studyDay: "2026-03-07",
    zone: plan.timeZone,
    ruleVersion: LEARNING_VERSION,
    deviceId: "device-one",
    deviceSeq: sequence,
    logicalClock: sequence,
    origin: "practice",
    evidence: { expected: "word" },
    reviewCompleted: false,
    undoneAt: null,
    ...changes,
  };
  return {
    id: event.id,
    wordId: event.wordId,
    entryId: event.entryId,
    mode: event.mode,
    answer: "word",
    correct: event.correct,
    durationMs: 10,
    createdAt: event.createdAt,
    learning: event,
  };
}
test("真实作答按词和规划时区去重，答错及列表反馈计入，揭晓/撤销/未来不冒充成绩", () => {
  const first = attempt(1);
  const attempts = [
    first,
    first,
    attempt(2, { correct: false }),
    attempt(3, { wordId: "two", mode: "word-list", signal: "unfamiliar" }),
    attempt(4, { signal: "reveal", wordId: "reveal" }),
    attempt(5, { undoneAt: now.toISOString(), wordId: "undone" }),
    attempt(6, { createdAt: "2026-03-08T12:00:00Z", wordId: "future" }),
    attempt(7, { createdAt: "2026-02-01T12:00:00Z", wordId: "old" }),
    attempt(8, {
      createdAt: "2026-03-07T04:30:00Z",
      wordId: "previous-day",
      studyDay: "2026-03-07",
      zone: "UTC",
    }),
  ];
  const before = JSON.stringify(attempts);
  const activity = learningActivity([], attempts, plan, now);
  assert.equal(activity.todayAnswered, 2);
  assert.equal(activity.history.at(-1)!.operations, 3);
  assert.equal(activity.history.at(-2)!.count, 1); // 规划时区仍为3月6日。
  assert.equal(activity.activeDays, 2);
  assert.equal(activity.practiced, 3);
  assert.equal(activity.history.length, 14);
  assert.equal(JSON.stringify(attempts), before);
});
test("七日复习使用已知排程：逾期归今天、未初学不计、超额度提示而不模拟新FSRS", () => {
  const source = items();
  for (const [index, dueAt] of [
    "2026-03-06T12:00:00Z",
    "2026-03-08T03:00:00Z",
    "2026-03-08T16:00:00Z",
    "2026-03-10T16:00:00Z",
    "2026-03-15T16:00:00Z",
  ].entries()) {
    source[index]!.status = "review";
    source[index]!.dueAt = dueAt;
  }
  source[5]!.dueAt = now.toISOString(); // 未开始词不自动进入复习。
  source[6]!.status = "mastered";
  source[6]!.dueAt = now.toISOString();
  const activity = learningActivity(
    [...source, source[0]!],
    [],
    { ...plan, dailyReview: 1 },
    now,
  );
  assert.equal(activity.reviewTotal, 4);
  assert.deepEqual(
    activity.review.map((day) => day.count),
    [2, 1, 0, 1, 0, 0, 0],
  );
  assert.equal(activity.overCapacityDays, 1);
  assert.equal(
    learningActivity(source, [], { ...plan, dailyReview: 0 }, now).overCapacityDays,
    0,
  );
});
