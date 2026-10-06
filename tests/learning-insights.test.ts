import test from "node:test";
import assert from "node:assert/strict";
import { LEARNING_VERSION, type LearningEvent } from "../lib/learning.ts";
import { practiceInsights, learningTrend } from "../lib/learning-insights.ts";
import type { LocalEncounter } from "../lib/local-model.ts";

const asOf = new Date("2026-10-04T00:00:00.000Z");
function event(sequence: number, changes: Partial<LearningEvent> = {}): LearningEvent {
  return {
    id: `event-${sequence}`,
    submissionId: `event-${sequence}`,
    attemptId: `question-${sequence}`,
    wordId: "word-one",
    entryId: "entry-one",
    mode: "recall",
    signal: "answer",
    correct: true,
    assisted: false,
    createdAt: "2026-10-03T00:00:00.000Z",
    studyDay: "2026-10-03",
    zone: "Asia/Shanghai",
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
}
function encounter(
  id: string,
  occurredAt: string,
  undoneAt: string | null = null,
): LocalEncounter {
  return {
    id,
    wordId: "word-one",
    surface: "word",
    originalSentence: "Read this word.",
    savedExcerpt: "Read this word.",
    occurrenceRanges: [{ start: 10, end: 14 }],
    excerptRanges: [{ start: 10, end: 14 }],
    annotation: { note: "" },
    source: { title: "article", url: "https://example.org/" },
    occurredAt,
    timeZone: "America/Los_Angeles",
    undoneAt,
  };
}

test("先揭示再正确答题，不把后续答案当独立成绩", () => {
  const result = practiceInsights(
    [
      event(1, { signal: "reveal", correct: false }),
      event(2, { attemptId: "question-1", assisted: false }),
    ],
    asOf,
  );
  // 即使后续标记遗漏 assisted，完整首次反馈也应阻止误计。
  assert.equal(result.operations, 1);
  assert.equal(result.independentAnswers, 0);
  assert.equal(result.byMode.recall.independentCorrect, 0);
});

test("辅助首次作答后的独立标记订正仍不进入正确率", () => {
  const result = practiceInsights(
    [event(1, { assisted: true, correct: false }), event(2, { attemptId: "question-1" })],
    asOf,
  );
  assert.equal(result.operations, 2);
  assert.equal(result.independentAnswers, 0);
});

test("首次答错后订正只算一次独立失败，实际两次作答仍保留", () => {
  const input = [event(2, { attemptId: "question-1" }), event(1, { correct: false })];
  const result = practiceInsights(input, asOf);
  assert.equal(result.operations, 2);
  assert.equal(result.independentAnswers, 1);
  assert.equal(result.independentCorrect, 0);
  assert.equal(result.byMode.recall.independentAnswers, 1);
  assert.deepEqual(
    input.map((item) => item.id),
    ["event-2", "event-1"],
  );
});

test("六方式的作答数量与四方式的独立正确率分开，临摹列表不冒充回忆", () => {
  const result = practiceInsights(
    [
      event(1, { mode: "word-list", signal: "familiar" }),
      event(2, { mode: "word-list", signal: "unfamiliar", correct: false }),
      event(3, { mode: "copy" }),
      event(4, { mode: "meaning-choice" }),
      event(5, { mode: "recall", correct: false }),
      event(6, { mode: "listening" }),
      event(7, { mode: "cloze" }),
      event(8, { mode: "copy", signal: "reveal", correct: false }),
    ],
    asOf,
  );
  assert.equal(result.operations, 7);
  assert.equal(result.independentAnswers, 4);
  assert.equal(result.independentCorrect, 3);
  assert.equal(result.byMode["word-list"].operations, 2);
  assert.equal(result.byMode["word-list"].independentMode, false);
  assert.equal(result.byMode.copy.operations, 1);
  assert.equal(result.byMode.copy.independentAnswers, 0);
  assert.equal(result.byMode["meaning-choice"].independentCorrect, 1);
  assert.equal(result.byMode.recall.independentCorrect, 0);
});

test("撤销与未来事件不统计，撤销首次反馈后按剩余事实重新取首次", () => {
  const result = practiceInsights(
    [
      event(1, { correct: false, undoneAt: "2026-10-03T01:00:00Z" }),
      event(2, { attemptId: "question-1" }),
      event(3, { undoneAt: "2026-10-03T01:00:00Z" }),
      event(4, { createdAt: "2026-10-05T00:00:00Z" }),
    ],
    asOf,
  );
  assert.equal(result.operations, 1);
  assert.equal(result.independentAnswers, 1);
  assert.equal(result.independentCorrect, 1);
});

test("同一单词重新练习一百次均为真实独立结果，洞察没有每日次数上限", () => {
  const result = practiceInsights(
    Array.from({ length: 100 }, (_, index) => event(index + 1)),
    asOf,
  );
  assert.equal(result.operations, 100);
  assert.equal(result.independentAnswers, 100);
  assert.equal(result.independentCorrect, 100);
});

test("跨 UTC 日期和夏令时的趋势使用规划自然日，撤销及未来语境排除", () => {
  const now = new Date("2026-03-09T06:30:00Z"),
    savedDay = "2026-03-08",
    result = learningTrend(
      [
        event(1, { createdAt: "2026-03-09T06:20:00Z", studyDay: savedDay }),
        event(2, { createdAt: "2026-03-08T10:00:00Z", studyDay: savedDay }),
        event(3, { createdAt: "2026-03-09T08:00:00Z", studyDay: "2026-03-09" }),
        event(4, {
          createdAt: "2026-03-09T06:00:00Z",
          studyDay: savedDay,
          undoneAt: "2026-03-09T06:25:00Z",
        }),
      ],
      [
        encounter("one", "2026-03-09T06:20:00Z"),
        encounter("undo", "2026-03-09T06:20:00Z", "2026-03-09T06:25:00Z"),
        encounter("future", "2026-03-09T08:00:00Z"),
      ],
      now,
      "America/Los_Angeles",
    );
  assert.equal(result.length, 14);
  assert.equal(result[0]?.day, "2026-02-23");
  assert.deepEqual(result.at(-1), {
    day: savedDay,
    learning: 2,
    encounters: 1,
  });
  assert.equal(new Set(result.map((row) => row.day)).size, 14);
});

test("变更规划时区后，既有反馈保留事务保存的学习日", () => {
  const result = learningTrend(
    [event(1, { createdAt: "2026-10-03T01:00:00Z", studyDay: "2026-10-02" })],
    [],
    asOf,
    "Asia/Shanghai",
  );
  assert.deepEqual(
    result.find((row) => row.day === "2026-10-02"),
    {
      day: "2026-10-02",
      learning: 1,
      encounters: 0,
    },
  );
  assert.equal(result.find((row) => row.day === "2026-10-03")?.learning, 0);
});
