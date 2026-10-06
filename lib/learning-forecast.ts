import type { LibraryItem } from "./workspace-model.ts";
import type { PracticeAttempt, StudyPlan } from "./local-model.ts";
import { learningPreview } from "./learning-workspace.ts";
import { learningEvents } from "./learning-repository.ts";
import { learningDay } from "./learning.ts";

// 日历加天只处理业务日期，避免跨夏令时用24小时推算而错一天。
function calendarDay(day: string, offset: number) {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

// 只推演初学额度与候选顺序；预览不同额度不保存计划、不模拟成绩。
export function learningForecast(
  items: LibraryItem[],
  practice: PracticeAttempt[],
  plan: StudyPlan,
  now = new Date(),
  previewDaily = plan.dailyNew,
) {
  const target = [
    ...new Map(items.filter((i) => i.inTarget).map((i) => [i.key, i])).values(),
  ];
  const pending = target
    .filter((i) => !i.familiarity?.graduatedAt)
    .sort(
      (a, b) =>
        Number(b.status === "learning") - Number(a.status === "learning") ||
        a.position - b.position,
    );
  const daily =
    Number.isSafeInteger(previewDaily) && previewDaily >= 1 && previewDaily <= 50
      ? previewDaily
      : plan.dailyNew;
  const base = learningPreview(target, practice, { ...plan, dailyNew: daily }, now);
  const today = base.firstDays[0]?.day ?? base.endOn;
  const todayCount = base.firstDays[0]?.count ?? 0;
  const days = plan.paused ? 0 : base.days;
  const dayAt = (offset: number) => calendarDay(today, offset);
  function preview(offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= days) return [];
    const start = offset ? todayCount + (offset - 1) * daily : 0;
    return pending.slice(start, start + (offset ? daily : todayCount));
  }
  const states = [
    { id: "new", label: "未开始", count: 0 },
    { id: "learning", label: "学习中", count: 0 },
    { id: "review", label: "待复习", count: 0 },
    { id: "mastered", label: "已熟悉", count: 0 },
  ];
  for (const item of target) {
    const id = item.status === "due" ? "review" : item.status;
    states.find((state) => state.id === id)!.count++;
  }
  return {
    total: target.length,
    completed: target.length - pending.length,
    remaining: pending.length,
    states,
    daily,
    days,
    todayCount,
    endOn: days ? dayAt(days - 1) : null,
    dayAt,
    preview,
  };
}

// 实际作答与已知到期分开统计；不把揭晓答案或未来模拟当成学习成绩。
export function learningActivity(
  items: LibraryItem[],
  practice: PracticeAttempt[],
  plan: StudyPlan,
  now = new Date(),
) {
  const today = learningDay(now, plan.timeZone);
  const history = Array.from({ length: 14 }, (_, index) => ({
    day: calendarDay(today, index - 13),
    words: new Set<string>(),
    operations: 0,
  }));
  const byDay = new Map(history.map((day) => [day.day, day]));
  // 历史计数保留曾练过的词，即使后来回收；撤销反馈不计入。
  const events = new Map(learningEvents(practice).map((event) => [event.id, event]));
  const practiced = new Set<string>();
  for (const event of events.values()) {
    if (
      event.undoneAt ||
      event.signal === "reveal" ||
      Date.parse(event.createdAt) > now.getTime()
    )
      continue;
    const day = byDay.get(learningDay(new Date(event.createdAt), plan.timeZone));
    if (!day) continue;
    day.words.add(event.wordId);
    day.operations++;
    practiced.add(event.wordId);
  }
  const review = Array.from({ length: 7 }, (_, index) => ({
    day: calendarDay(today, index),
    count: 0,
  }));
  const reviewByDay = new Map(review.map((day) => [day.day, day]));
  // 使用当前活动词的真实到期时间，逾期归今天；不推算后续答题会产生的新排程。
  for (const item of new Map(items.map((item) => [item.key, item])).values()) {
    if ((item.status !== "review" && item.status !== "due") || !item.dueAt) continue;
    const due = Date.parse(item.dueAt);
    if (!Number.isFinite(due)) continue;
    const day = learningDay(new Date(due), plan.timeZone);
    const bucket = reviewByDay.get(day < today ? today : day);
    if (bucket) bucket.count++;
  }
  const quota = plan.dailyReview;
  return {
    history: history.map((day) => ({
      day: day.day,
      count: day.words.size,
      operations: day.operations,
    })),
    practiced: practiced.size,
    activeDays: history.filter((day) => day.operations).length,
    todayAnswered: history.at(-1)!.words.size,
    review,
    reviewTotal: review.reduce((sum, day) => sum + day.count, 0),
    overCapacityDays: quota > 0 ? review.filter((day) => day.count > quota).length : 0,
  };
}
