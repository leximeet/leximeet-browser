import {
  LEARNING_VERSION,
  orderedLearningEvents,
  learningDay,
  type LearningEvent,
} from "./learning.ts";
import { PRACTICE_MODES, type PracticeMode } from "./practice-session.ts";
import type { LocalEncounter } from "./local-model.ts";

const INDEPENDENT_MODES: readonly PracticeMode[] = [
  "meaning-choice",
  "recall",
  "listening",
  "cloze",
];
export type PracticeModeMetrics = {
  operations: number;
  independentAnswers: number;
  independentCorrect: number;
  independentMode: boolean;
};

function activeEvents(events: LearningEvent[], asOf: Date) {
  return events.filter(
    (event) =>
      event.ruleVersion === LEARNING_VERSION &&
      !event.undoneAt &&
      Number.isFinite(Date.parse(event.createdAt)) &&
      Date.parse(event.createdAt) <= asOf.getTime(),
  );
}

// 洞察仅汇总当前学习事实；操作次数与独立首次结果使用不同口径。
export function practiceInsights(events: LearningEvent[], asOf = new Date()) {
  const byMode = Object.fromEntries(
    PRACTICE_MODES.map((mode) => [
      mode,
      {
        operations: 0,
        independentAnswers: 0,
        independentCorrect: 0,
        independentMode: INDEPENDENT_MODES.includes(mode),
      },
    ]),
  ) as Record<PracticeMode, PracticeModeMetrics>;
  const firstAttempts = new Set<string>();
  let operations = 0,
    independentAnswers = 0,
    independentCorrect = 0;
  for (const event of orderedLearningEvents(activeEvents(events, asOf))) {
    const mode = byMode[event.mode];
    if (!mode) continue;
    // 揭示答案是学习反馈，不是作答；辅助答案与订正仍属于实际操作。
    if (
      event.signal === "answer" ||
      (event.mode === "word-list" && ["familiar", "unfamiliar"].includes(event.signal))
    ) {
      operations++;
      mode.operations++;
    }
    // 必须先关闭完整的首次反馈。先滤掉揭示/辅助会把后续订正误当独立答案。
    if (firstAttempts.has(event.attemptId)) continue;
    firstAttempts.add(event.attemptId);
    if (!mode.independentMode || event.signal !== "answer" || event.assisted) continue;
    independentAnswers++;
    mode.independentAnswers++;
    if (event.correct) {
      independentCorrect++;
      mode.independentCorrect++;
    }
  }
  return { operations, independentAnswers, independentCorrect, byMode };
}

// 按工作区自然日生成横轴；学习反馈保持事务已保存的 studyDay。
export function learningTrend(
  events: LearningEvent[],
  encounters: LocalEncounter[],
  asOf: Date,
  zone: string,
) {
  const learning = new Map<string, number>(),
    encounterCounts = new Map<string, number>();
  for (const event of activeEvents(events, asOf))
    learning.set(event.studyDay, (learning.get(event.studyDay) || 0) + 1);
  for (const encounter of encounters) {
    const at = Date.parse(encounter.occurredAt);
    if (encounter.undoneAt || !Number.isFinite(at) || at > asOf.getTime()) continue;
    const day = learningDay(new Date(at), zone);
    encounterCounts.set(day, (encounterCounts.get(day) || 0) + 1);
  }
  // 用 UTC 仅作日历加减，避免宿主时区和 DST 改变横轴的自然日。
  const today = `${learningDay(asOf, zone)}T12:00:00.000Z`;
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - 13 + index);
    const day = date.toISOString().slice(0, 10);
    return {
      day,
      learning: learning.get(day) || 0,
      encounters: encounterCounts.get(day) || 0,
    };
  });
}
