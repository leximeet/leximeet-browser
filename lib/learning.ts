import type { PracticeMode } from "./practice-session.ts";

// 与 Core LearningPolicy 同一业务版本；物理数据库版本和调度版本单独管理。
export const LEARNING_VERSION = "leximeet.learning/2" as const;
export type LearningStatus = "new" | "learning" | "review" | "mastered";
export type LearningSignal = "answer" | "familiar" | "unfamiliar" | "reveal";
export type LearningEvent = {
  id: string;
  submissionId: string;
  attemptId: string;
  wordId: string;
  entryId: string | null;
  mode: PracticeMode;
  signal: LearningSignal;
  correct: boolean;
  assisted: boolean;
  createdAt: string;
  studyDay: string;
  zone: string;
  ruleVersion: typeof LEARNING_VERSION;
  deviceId: string;
  deviceSeq: number;
  logicalClock: number;
  origin: "practice";
  evidence: {
    expected: string;
    answer?: string;
    choiceId?: string;
    options?: { id: string; text: string }[];
  };
  reviewCompleted: boolean;
  undoneAt: string | null;
};
export type LearningProjection = {
  ruleVersion: typeof LEARNING_VERSION;
  score: number;
  maximum: 30;
  samples: number;
  familiar: number;
  unfamiliar: number;
  independent: number;
  lastDelta: number;
  lastEffective: boolean;
  status: LearningStatus;
  label: string;
  needsReinforcement: boolean;
  unfamiliarWord: boolean;
  startedAt: string | null;
  graduatedAt: string | null;
  graduatedDay: string | null;
  reviewEligibleAt: string | null;
  firstRecallDueAt: string | null;
  masteryCycleAt: string | null;
  nextDecayAt: string | null;
  asOf: string;
};
export const learningDay = (at: Date, zone = "UTC") =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: zone }).format(at);
const DAY = 86_400_000;
// 找学习时区的下一自然日零点；二分真实时刻，支持 DST 和非整小时偏移。
export function nextLearningDay(at: string, zone: string): string {
  const now = Date.parse(at),
    day = learningDay(new Date(now), zone);
  let low = now,
    high = now + 3 * DAY;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (learningDay(new Date(middle), zone) === day) low = middle;
    else high = middle;
  }
  return new Date(high).toISOString();
}
export function orderedLearningEvents(events: LearningEvent[]) {
  return [...events].sort(
    (a, b) =>
      a.logicalClock - b.logicalClock ||
      a.deviceId.localeCompare(b.deviceId) ||
      a.deviceSeq - b.deviceSeq ||
      a.id.localeCompare(b.id),
  );
}
// 只投影 v2 事实；撤销、自然时间和学习经历分开，不改写旧事件或伪造答错。
export function projectLearning(
  events: LearningEvent[],
  asOf = new Date(),
): LearningProjection {
  let score = 10,
    samples = 0,
    familiar = 0,
    unfamiliar = 0,
    independent = 0,
    lastDelta = 0,
    lastEffective = false,
    decayed = 0;
  let started: string | null = null,
    graduated: string | null = null,
    graduatedDay: string | null = null;
  let eligible: string | null = null,
    firstRecall: string | null = null,
    cycle: string | null = null;
  const closed = new Set<string>();
  const decay = (at: string) => {
    if (!cycle) return;
    const count = Math.max(
      0,
      Math.trunc((Date.parse(at) - Date.parse(cycle) - 3 * DAY) / (2 * DAY)),
    );
    const pending = Math.max(0, count - decayed);
    if (!pending) return;
    const lost = Math.min(pending, Math.max(0, score - 20));
    score -= lost;
    if (score <= 20) {
      eligible = new Date(
        Date.parse(cycle) + 3 * DAY + (decayed + lost) * 2 * DAY,
      ).toISOString();
      cycle = null;
    }
    decayed = count;
  };
  for (const f of orderedLearningEvents(events)) {
    if (
      f.ruleVersion !== LEARNING_VERSION ||
      f.undoneAt ||
      Date.parse(f.createdAt) > asOf.getTime()
    )
      continue;
    decay(f.createdAt);
    lastDelta = 0;
    lastEffective = false;
    if (closed.has(f.attemptId)) continue;
    closed.add(f.attemptId);
    samples++;
    started ??= f.createdAt;
    const correct = f.signal === "familiar" || (f.signal === "answer" && f.correct);
    if (f.signal === "familiar") familiar++;
    if (f.signal === "unfamiliar" || f.signal === "reveal") unfamiliar++;
    const delta =
      f.signal === "reveal" || !correct
        ? -1
        : f.assisted
          ? 0
          : ["recall", "cloze"].includes(f.mode)
            ? 2
            : 1;
    const before = score;
    score = Math.min(30, Math.max(0, score + delta));
    lastDelta = score - before;
    lastEffective = !f.assisted && f.mode !== "copy" && f.signal !== "reveal";
    if (correct && lastEffective && f.mode !== "word-list") independent++;
    if (!graduated && score >= 20) {
      graduated = f.createdAt;
      graduatedDay = learningDay(new Date(f.createdAt), f.zone);
      eligible = nextLearningDay(f.createdAt, f.zone);
      firstRecall = eligible;
    }
    if (before < 30 && score === 30) {
      cycle = f.createdAt;
      decayed = 0;
    } else if (cycle && score <= 20) {
      cycle = null;
      eligible = f.createdAt;
    }
  }
  decay(asOf.toISOString());
  const status: LearningStatus = cycle
    ? "mastered"
    : graduated
      ? "review"
      : started
        ? "learning"
        : "new";
  return {
    ruleVersion: LEARNING_VERSION,
    score,
    maximum: 30,
    samples,
    familiar,
    unfamiliar,
    independent,
    lastDelta,
    lastEffective,
    status,
    label: {
      new: "未学习",
      learning: "学习中",
      review: "待复习",
      mastered: "已熟悉",
    }[status],
    needsReinforcement: score < 10,
    unfamiliarWord: score === 0,
    startedAt: started,
    graduatedAt: graduated,
    graduatedDay,
    reviewEligibleAt: eligible,
    firstRecallDueAt: firstRecall,
    masteryCycleAt: cycle,
    nextDecayAt: cycle
      ? new Date(Date.parse(cycle) + 3 * DAY + (decayed + 1) * 2 * DAY).toISOString()
      : null,
    asOf: asOf.toISOString(),
  };
}
