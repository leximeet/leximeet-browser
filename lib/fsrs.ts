import type { ReviewRating } from "./local-model.ts";
import { estimateMemory, type RecallGrade } from "./fsrs-memory.ts";

// 算法标识描述冻结的跨端排程规范与参考向量，不代表运行时依赖 Java 程序。
export const FSRS_PROFILE = "leximeet.fsrs6/1";
export const FSRS_ALGORITHM = "fsrs-6/java-fsrs-1.0.0";
export type FsrsMemory = {
  round: number;
  state: "learning" | "review" | "relearning";
  step: number | null;
  stability: number | null;
  difficulty: number | null;
  dueAt: string;
  lastReviewAt: string | null;
};

const dayMillis = 86_400_000;
const learningDelays = [60_000, 600_000];
const relearningDelays = [600_000];
const gradeByRating: Record<ReviewRating, RecallGrade> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};
type Schedule = Pick<FsrsMemory, "state" | "step"> & { delay: number };

// 首次排程未产生记忆估计；开始作答时才初始化 S/D。
export const initialFsrs = (at: string): FsrsMemory => ({
  round: 1,
  state: "learning",
  step: 0,
  stability: null,
  difficulty: null,
  dueAt: at,
  lastReviewAt: null,
});

// 目标回忆率固定为90%，公开遗忘曲线的逆函数在这个目标下就是 S 天。
function reviewSchedule(stability: number): Schedule {
  const days = Math.max(1, Math.min(36_500, Math.round(stability)));
  return { state: "review", step: null, delay: days * dayMillis };
}

/**
 * 自有步长排程：Again 回首步，Hard 留在当前步，Good 推进一步，Easy 直接毕业。
 * 初学首步的 Hard 取前两步平均值，保留5.5分钟；再学只有一步时取1.5倍。
 */
function nextSchedule(
  current: FsrsMemory,
  grade: RecallGrade,
  stability: number,
): Schedule {
  if (current.state === "review")
    return grade === 1
      ? { state: "relearning", step: 0, delay: relearningDelays[0]! }
      : reviewSchedule(stability);

  const delays = current.state === "learning" ? learningDelays : relearningDelays;
  const step = current.step ?? 0;
  if (grade === 4 || (grade !== 1 && step >= delays.length))
    return reviewSchedule(stability);
  if (grade === 1) return { state: current.state, step: 0, delay: delays[0]! };
  if (grade === 3) {
    const followingStep = step + 1;
    return followingStep >= delays.length
      ? reviewSchedule(stability)
      : { state: current.state, step: followingStep, delay: delays[followingStep]! };
  }
  const hardDelay =
    step > 0 ? delays[step]! : (delays[0]! + (delays[1] ?? delays[0]! * 2)) / 2;
  return { state: current.state, step, delay: hardDelay };
}

/**
 * 统一入口：检查输入 → 计算完整经过天数 → 估计记忆 → 选择步长 → 生成排程。
 * 练习记分、学习状态和时区的下一自然日限制由学习层处理，本模块不修改它们。
 */
export function reviewFsrs(
  before: FsrsMemory,
  rating: ReviewRating,
  at: string,
): FsrsMemory {
  const reviewedAt = Date.parse(at);
  const lastReviewedAt = before.lastReviewAt ? Date.parse(before.lastReviewAt) : null;
  if (
    !Number.isFinite(reviewedAt) ||
    (lastReviewedAt !== null &&
      (!Number.isFinite(lastReviewedAt) || reviewedAt < lastReviewedAt))
  )
    throw new Error("复习时间不能早于上一轮反馈");
  const grade = gradeByRating[rating];
  if (!grade) throw new Error("未知学习反馈");
  const previous =
    before.stability === null || before.difficulty === null
      ? null
      : { stability: before.stability, difficulty: before.difficulty };
  if (
    (before.stability === null) !== (before.difficulty === null) ||
    !Number.isSafeInteger(before.round) ||
    before.round < 1 ||
    (previous &&
      (!Number.isFinite(previous.stability) ||
        !Number.isFinite(previous.difficulty) ||
        previous.stability <= 0 ||
        previous.difficulty < 1 ||
        previous.difficulty > 10)) ||
    !["learning", "review", "relearning"].includes(before.state) ||
    (before.step !== null && (!Number.isSafeInteger(before.step) || before.step < 0))
  )
    throw new Error("复习记忆状态无效");
  const elapsedDays =
    lastReviewedAt === null ? 0 : Math.floor((reviewedAt - lastReviewedAt) / dayMillis);
  const memory = estimateMemory(previous, grade, elapsedDays);
  const schedule = nextSchedule(before, grade, memory.stability);
  return {
    ...memory,
    round: before.round + 1,
    state: schedule.state,
    step: schedule.step,
    dueAt: new Date(reviewedAt + schedule.delay).toISOString(),
    lastReviewAt: new Date(reviewedAt).toISOString(),
  };
}
