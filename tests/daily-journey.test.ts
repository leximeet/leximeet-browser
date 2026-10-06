import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalLibrary } from "../lib/local-database.ts";
import { learningEvents, type FrozenQuestion } from "../lib/learning-repository.ts";
import { projectLearning } from "../lib/learning.ts";
import { learningLibrary, learningDaily } from "../lib/learning-workspace.ts";
import { localSnapshot } from "./helpers/local-snapshot.ts";
import { PRACTICE_MODES, type PracticeMode } from "../lib/practice-session.ts";

test("首装3学1休3学七天旅程：六模式、查重、笔记、换目标、FSRS队列与当前格式重开完整保留", async () => {
  let now = new Date("2026-10-01T08:00:00Z");
  const name = "daily-journey-" + crypto.randomUUID();
  let db = new LocalLibrary(name, () => now);
  const book = await db.book(),
    notebook = await db.createNotebook("一周阅读");
  const member = {
    entryId: "public-resilient",
    word: "resilient",
    meaning: "有韧性的",
    position: 1,
    senseIds: [],
    matchMethod: "test",
  };
  const initialPlan = {
    id: "week-plan",
    sourceKind: "catalog" as const,
    sourceId: "ielts",
    sourceVersion: "0.0.3" as const,
    dailyNew: 10,
    dailyReview: 20,
    startedOn: "2026-10-01",
    timeZone: "UTC",
    savedAt: now.toISOString(),
    paused: false,
  };
  await db.savePlan(initialPlan, 0);
  const captured = await db.capture({
    eventId: crypto.randomUUID(),
    surface: "resilient",
    originalSentence: "A resilient reader returns.",
    savedExcerpt: "A resilient reader returns.",
    occurrenceRanges: [{ start: 2, end: 11 }],
    excerptRanges: [{ start: 2, end: 11 }],
    annotation: { note: "第一天" },
    source: { title: "阅读", url: "https://example.test/week" },
    occurredAt: now.toISOString(),
    timeZone: "UTC",
    dictionary: {
      word: "resilient",
      meaning: "有韧性的",
      phonetic: "",
      entryId: member.entryId,
    },
    notebookId: notebook.id,
  });
  const word = await db.word(captured.word.id);
  await db.editWord(word!.id, word!.revision, { note: "七天保留的个人笔记" });
  const answer = async (id: string, mode: PracticeMode, correct = true) => {
    const q: FrozenQuestion = {
      attemptId: id,
      wordId: word!.id,
      entryId: member.entryId,
      word: member.word,
      meaning: member.meaning,
      phonetic: "",
      mode,
      ignoreCase: true,
      options:
        mode === "meaning-choice"
          ? [
              { id: "yes", text: member.meaning },
              { id: "no", text: "系统" },
            ]
          : [],
      correctChoiceId: mode === "meaning-choice" ? "yes" : null,
      sentence: "A resilient reader returns.",
    };
    await db.learning.freeze(q);
    return db.learning.submit({
      submissionId: id + "/receipt",
      attemptId: id,
      ...(mode === "word-list"
        ? { signal: correct ? ("familiar" as const) : ("unfamiliar" as const) }
        : mode === "meaning-choice"
          ? { choiceId: correct ? "yes" : "no" }
          : { answer: correct ? "resilient" : "wrong" }),
    });
  };
  const fresh = learningLibrary(
    [member],
    await db.listWords(),
    await db.encounters(),
    await db.reviews(),
    await db.practice(),
    now,
  );
  assert.equal(fresh[0]?.familiarity?.score, 10);
  assert.equal(fresh[0]?.status, "new");
  assert.equal(
    learningDaily(fresh, await db.encounters(), await db.practice(), await db.plan(), now)
      .unique.length,
    1,
  );
  let restSnapshot: unknown;
  for (let day = 0; day < 7; day++) {
    now = new Date(`2026-10-${String(day + 1).padStart(2, "0")}T08:00:00Z`);
    if (day === 3) {
      restSnapshot = await localSnapshot(db);
      const factsBefore = await db.practice();
      const items = learningLibrary(
        [member],
        await db.listWords(),
        await db.encounters(),
        await db.reviews(),
        factsBefore,
        now,
      );
      const queue = learningDaily(
        items,
        await db.encounters(),
        factsBefore,
        await db.plan(),
        now,
      );
      assert.equal(items[0]?.status, "mastered");
      assert.equal(queue.review.length, 0);
      assert.deepEqual(await localSnapshot(db), restSnapshot); // 被动读取不会伪造休息日练习。
      continue;
    }
    for (const mode of PRACTICE_MODES) {
      const receipt = await answer(`day-${day}/${mode}`, mode);
      assert.equal(receipt.event.mode, mode);
      assert.ok(receipt.score >= 0 && receipt.score <= 30);
    }
    const repeated = await db.capture({
      eventId: crypto.randomUUID(),
      surface: "resilient",
      originalSentence: "A resilient reader returns.",
      savedExcerpt: "A resilient reader returns.",
      occurrenceRanges: [{ start: 2, end: 11 }],
      excerptRanges: [{ start: 2, end: 11 }],
      annotation: { note: "重复不会覆盖原笔记" },
      source: { title: "另一页面", url: "https://other.test/week" },
      occurredAt: now.toISOString(),
      timeZone: "UTC",
      dictionary: {
        word: member.word,
        meaning: member.meaning,
        phonetic: "",
        entryId: member.entryId,
      },
    });
    assert.equal(repeated.captureStatus, "duplicate-context");
    assert.equal((await db.encounters()).length, 1);
    if (day === 0) {
      const items = learningLibrary(
        [member],
        await db.listWords(),
        await db.encounters(),
        await db.reviews(),
        await db.practice(),
        now,
      );
      assert.equal(items[0]?.familiarity?.score, 18);
      assert.equal(items[0]?.status, "learning");
    }
    if (day === 1) {
      const items = learningLibrary(
        [member],
        await db.listWords(),
        await db.encounters(),
        await db.reviews(),
        await db.practice(),
        now,
      );
      assert.equal(items[0]?.status, "review");
      assert.equal(
        learningDaily(
          items,
          await db.encounters(),
          await db.practice(),
          await db.plan(),
          now,
        ).review.length,
        0,
      ); // 当日毕业，明日以后才进入提醒队列。
    }
    if (day === 4) {
      const plan = await db.plan();
      await db.savePlan(
        {
          ...initialPlan,
          id: "changed-goal",
          sourceId: "cet4",
          savedAt: now.toISOString(),
        },
        plan!.revision!,
      );
    }
    // 每天重新建立业务仓库，保留同资料名称，等价于进程重开而不是复制事实到新库。
    const before = await localSnapshot(db);
    db = new LocalLibrary(name, () => now);
    assert.deepEqual(await localSnapshot(db), before);
  }
  assert.equal((await db.practice()).length, 36);
  assert.equal((await db.reviews()).length, 2); // FSRS只在首次/到期独立反馈更新，不按主动练习次数累加。
  const byEvent = new Map((await db.practice()).map((p) => [p.id, p]));
  assert.ok(
    (await db.reviews()).every(
      (r) => byEvent.get(r.sourceSubmissionId!)?.mode !== "copy",
    ),
  );
  assert.equal((await db.listWords())[0]?.note, "七天保留的个人笔记");
  assert.equal((await db.book()).bookUid, book.bookUid);
  const beforeUpgrade = await localSnapshot(db);
  db = new LocalLibrary(name, () => now);
  assert.deepEqual(await localSnapshot(db), beforeUpgrade);
  assert.equal((await db.plan())?.id, "changed-goal");
  assert.equal((await db.capturePolicy()).duplicateWindowDays, 7);
  // 超过七天的衰减边界仍由同一模型推导，绝不调系统时间或写假失败事件。
  const events = learningEvents(await db.practice());
  const lastCycle = projectLearning(events, now).masteryCycleAt!;
  assert.equal(
    projectLearning(events, new Date(Date.parse(lastCycle) + 23 * 86400000)).status,
    "review",
  );
  assert.equal((await db.practice()).length, 36);
});
