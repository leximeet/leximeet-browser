import type { CatalogMember } from "./lexicon.ts";
import type {
  UserWord,
  LocalEncounter,
  ReviewFact,
  PracticeAttempt,
  StudyPlan,
} from "./local-model.ts";
import type { LibraryItem } from "./workspace-model.ts";
import { learningEvents, projectFsrs } from "./learning-repository.ts";
import { projectLearning, learningDay, type LearningEvent } from "./learning.ts";

// 公共词保持只读；学习过但已离开目标的词仍可继续。个人行仅在实际反馈时建立。
export function learningLibrary(
  target: CatalogMember[],
  words: UserWord[],
  encounters: LocalEncounter[],
  reviews: ReviewFact[],
  practice: PracticeAttempt[],
  now = new Date(),
): LibraryItem[] {
  const events = new Map<string, LearningEvent[]>(),
    facts = new Map<string, ReviewFact[]>(),
    counts = new Map<string, number>();
  for (const f of learningEvents(practice)) {
    const fs = events.get(f.wordId) || [];
    fs.push(f);
    events.set(f.wordId, fs);
  }
  for (const f of reviews)
    if (Date.parse(f.createdAt) <= now.getTime()) {
      const fs = facts.get(f.wordId) || [];
      fs.push(f);
      facts.set(f.wordId, fs);
    }
  for (const e of encounters)
    if (!e.undoneAt && Date.parse(e.occurredAt) <= now.getTime())
      counts.set(e.wordId, (counts.get(e.wordId) || 0) + 1);
  // 回收是个人排除事实；只读目标成员不能把同词重新物化为未学习。
  const recycled = words.filter((w) => w.deletedAt),
    excludedKeys = new Set(recycled.map((w) => w.normalized)),
    excludedEntries = new Set(recycled.map((w) => w.entryId).filter(Boolean)),
    active = words.filter((w) => !w.deletedAt),
    byEntry = new Map(active.filter((w) => w.entryId).map((w) => [w.entryId, w])),
    byKey = new Map(active.map((w) => [w.normalized, w]));
  const targetIds = new Set(target.map((m) => m.entryId)),
    seen = new Set<string>();
  const members = [
    ...target,
    ...active
      .filter(
        (w) =>
          w.collected !== false ||
          events.has(w.id) ||
          !!w.note.trim() ||
          !!w.notebookIds.length,
      )
      .map((w, i) => ({
        entryId: w.entryId || w.id,
        word: w.word,
        meaning: w.dictionaryHint,
        position: target.length + i + 1,
        senseIds: [],
        matchMethod: "personal",
      })),
  ];
  return members.flatMap((m) => {
    const key = m.word.normalize("NFC").toLowerCase();
    if (seen.has(key) || excludedKeys.has(key) || excludedEntries.has(m.entryId))
      return [];
    seen.add(key);
    const personal = byEntry.get(m.entryId) || byKey.get(key) || null;
    const familiarity = projectLearning(
      personal ? events.get(personal.id) || [] : [],
      now,
    );
    const fs = personal ? facts.get(personal.id) || [] : [],
      memory = personal && fs.length ? projectFsrs(personal.createdAt, fs) : null;
    const recall = memory?.dueAt || familiarity.firstRecallDueAt;
    const dueAt =
      familiarity.status === "review" && recall && familiarity.reviewEligibleAt
        ? new Date(
            Math.max(Date.parse(recall), Date.parse(familiarity.reviewEligibleAt)),
          ).toISOString()
        : null;
    return [
      {
        ...m,
        key,
        personal,
        inTarget: targetIds.has(m.entryId),
        collected: !!personal && personal.collected !== false,
        meaning: m.meaning || personal?.dictionaryHint || "",
        encounterCount: personal ? counts.get(personal.id) || 0 : 0,
        status: familiarity.status,
        dueAt,
        familiarity,
      },
    ];
  });
}
// 当天额度来自真实毕业/已具资格的独立成功，按词去重；FSRS 到期只筛选自动候选。
export function learningProgress(
  practice: PracticeAttempt[],
  zone: string | undefined,
  now = new Date(),
) {
  const today = learningDay(
      now,
      zone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    ),
    events = learningEvents(practice).filter(
      (f) => !f.undoneAt && Date.parse(f.createdAt) <= now.getTime(),
    );
  const groups = new Map<string, LearningEvent[]>();
  for (const f of events) {
    const group = groups.get(f.wordId) || [];
    group.push(f);
    groups.set(f.wordId, group);
  }
  const newIds = new Set<string>(),
    reviewIds = new Set<string>();
  for (const [id, fs] of groups)
    if (projectLearning(fs, now).graduatedDay === today) newIds.add(id);
  for (const f of events)
    if (f.reviewCompleted && f.studyDay === today && !newIds.has(f.wordId))
      reviewIds.add(f.wordId);
  return {
    today,
    newIds,
    reviewIds,
    newDone: newIds.size,
    reviewDone: reviewIds.size,
    completed: newIds.size + reviewIds.size,
  };
}
export function learningDaily(
  items: LibraryItem[],
  encounters: LocalEncounter[],
  practice: PracticeAttempt[],
  plan: StudyPlan | null,
  now = new Date(),
) {
  const progress = learningProgress(practice, plan?.timeZone, now),
    byId = new Map(items.filter((i) => i.personal).map((i) => [i.personal!.id, i]));
  const done = new Set(
    [...progress.newIds, ...progress.reviewIds].flatMap((id) =>
      byId.get(id)?.key ? [byId.get(id)!.key] : [],
    ),
  );
  const encounteredIds = new Set(
    encounters
      .filter((e) => !e.undoneAt && Date.parse(e.occurredAt) <= now.getTime())
      .map((e) => e.wordId),
  );
  const encountered = items
    .filter(
      (i) =>
        i.familiarity &&
        !i.familiarity.graduatedAt &&
        i.personal &&
        encounteredIds.has(i.personal.id),
    )
    .slice(0, 200);
  const continued = items.filter((i) => i.status === "learning").slice(0, 200),
    seen = new Set([...encountered, ...continued].map((i) => i.key));
  const remainingNew = Math.max(0, (plan?.dailyNew || 0) - progress.newDone);
  const extra =
    plan && !plan.paused
      ? items
          .filter((i) => i.inTarget && !i.familiarity?.graduatedAt && !seen.has(i.key))
          .slice(0, Math.max(0, remainingNew - seen.size))
      : [];
  const planned = [...new Map([...continued, ...extra].map((i) => [i.key, i])).values()];
  const quota = Math.max(0, (plan?.dailyReview ?? 20) - progress.reviewDone);
  const due = items
    .filter(
      (i) => i.status === "review" && i.dueAt && Date.parse(i.dueAt) <= now.getTime(),
    )
    .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!) || a.position - b.position);
  // 今天已完成又答错的词允许短期巩固；不会重复扣当天额度。
  const review = [
    ...due.filter((i) => !done.has(i.key)).slice(0, quota),
    ...due.filter((i) => done.has(i.key)),
  ];
  const unique = [
    ...new Map([...encountered, ...planned, ...review].map((i) => [i.key, i])).values(),
  ];
  return {
    ...progress,
    encountered,
    planned,
    review,
    unique,
    pending: unique,
    done,
    remainingNew,
  };
}
export function learningPreview(
  items: LibraryItem[],
  practice: PracticeAttempt[],
  plan: Pick<StudyPlan, "dailyNew" | "timeZone"> | null,
  now = new Date(),
) {
  const { today, newDone } = learningProgress(practice, plan?.timeZone, now),
    remaining = items.filter((i) => !i.familiarity?.graduatedAt).length,
    daily =
      Number.isSafeInteger(plan?.dailyNew) && plan!.dailyNew >= 1 ? plan!.dailyNew : 10;
  const todayCount = Math.min(remaining, Math.max(0, daily - newDone)),
    after = remaining - todayCount,
    days = remaining ? 1 + Math.ceil(after / daily) : 0;
  const add = (n: number) => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  return {
    remaining,
    days,
    endOn: add(Math.max(0, days - 1)),
    firstDays: Array.from({ length: Math.min(7, days) }, (_, i) => ({
      day: add(i),
      count: i ? Math.min(daily, Math.max(0, after - (i - 1) * daily)) : todayCount,
    })),
  };
}
