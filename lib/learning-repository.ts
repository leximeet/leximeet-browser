import { beginIndependentWrite, independentWriteFailure } from "./local-ownership.ts";
import {
  LEARNING_VERSION,
  learningDay,
  projectLearning,
  orderedLearningEvents,
  type LearningEvent,
  type LearningSignal,
} from "./learning.ts";
import { initialFsrs, reviewFsrs, FSRS_ALGORITHM, type FsrsMemory } from "./fsrs.ts";
import type {
  UserWord,
  BookMeta,
  PracticeAttempt,
  ReviewFact,
  StudyPlan,
} from "./local-model.ts";
import { PRACTICE_MODES, type PracticeMode } from "./practice-session.ts";
const get = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
async function transaction<T>(
  db: IDBDatabase,
  stores: string[],
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = beginIndependentWrite(db, stores);
  let failure: unknown;
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(
        failure || independentWriteFailure(tx, new Error("学习事务失败，原资料未修改")),
      );
  });
  try {
    const result = await run(tx);
    await done;
    return result;
  } catch (e) {
    failure = independentWriteFailure(tx, e as Error);
    try {
      tx.abort();
    } catch {}
    await done.catch(() => {});
    throw failure;
  }
}
export type LearningState = {
  ruleVersion: typeof LEARNING_VERSION;
  revision: number;
  sequence: number;
};
export type FrozenQuestion = {
  attemptId: string;
  wordId: string | null;
  entryId: string | null;
  word: string;
  meaning: string;
  phonetic: string;
  mode: PracticeMode;
  ignoreCase: boolean;
  options: { id: string; text: string }[];
  correctChoiceId: string | null;
  sentence: string | null;
};
export type PracticeSubmission = {
  submissionId: string;
  attemptId: string;
  answer?: string;
  choiceId?: string;
  signal?: LearningSignal;
  assisted?: boolean;
  durationMs?: number;
};
export type LearningReceipt = {
  event: LearningEvent;
  duplicate: boolean;
  score: number;
  delta: number;
  status: string;
  effective: boolean;
};
export function learningEvents(attempts: PracticeAttempt[]): LearningEvent[] {
  if (
    attempts.some(
      (attempt) => attempt.learning && attempt.learning.ruleVersion !== LEARNING_VERSION,
    )
  )
    throw new Error("学习事件版本无法识别，原数据未修改");
  return attempts.flatMap((p) => (p.learning ? [p.learning] : []));
}
// 只解释当前发布算法；旧候选和未知算法原样保留并拒绝读取。
export function projectFsrs(createdAt: string, reviews: ReviewFact[]): FsrsMemory {
  if (reviews.some((fact) => fact.algorithmVersion !== FSRS_ALGORITHM))
    throw new Error("复习历史含未知算法，原记录保留");
  let state = initialFsrs(createdAt);
  for (const fact of [...reviews]
    .filter((item) => !item.undoneAt)
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        (a.logicalClock ?? 0) - (b.logicalClock ?? 0) ||
        a.id.localeCompare(b.id),
    ))
    state = reviewFsrs(state, fact.rating, fact.createdAt);
  return state;
}
// 新库在建库事务中保存；普通读取不会初始化、备份或转换已有行。
export const initialLearningState = (): LearningState => ({
  ruleVersion: LEARNING_VERSION,
  revision: 1,
  sequence: 0,
});
export function validLearningState(value: unknown): value is LearningState {
  const state = value as LearningState;
  return (
    !!state &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    Object.keys(state).every((key) =>
      ["ruleVersion", "revision", "sequence"].includes(key),
    ) &&
    state.ruleVersion === LEARNING_VERSION &&
    Number.isSafeInteger(state.revision) &&
    state.revision >= 1 &&
    Number.isSafeInteger(state.sequence) &&
    state.sequence >= 0
  );
}
// 每次写事务也复核业务标记，已经打开的窗口不能继续写入另一窗口引入的未知格式。
async function requireLearningState(meta: IDBObjectStore): Promise<LearningState> {
  const state = await get(meta.get("learning"));
  if (!validLearningState(state)) throw new Error("学习资料版本无法识别，原数据未修改");
  return state;
}
// 缺失或未知标记不当成首次安装；只读校验使封存库也能安全打开。
export async function initializeLearning(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(["meta", "reviews", "practice"], "readonly");
  const [state, reviews, attempts] = await Promise.all([
    get(tx.objectStore("meta").get("learning")),
    get<ReviewFact[]>(tx.objectStore("reviews").getAll()),
    get<PracticeAttempt[]>(tx.objectStore("practice").getAll()),
  ]);
  if (!validLearningState(state)) throw new Error("学习资料版本无法识别，原数据未修改");
  if (reviews.some((fact) => fact.algorithmVersion !== FSRS_ALGORITHM))
    throw new Error("复习历史含未知算法，原记录保留");
  if (
    attempts.some(
      (attempt) =>
        !PRACTICE_MODES.includes(attempt.mode as PracticeMode) ||
        (attempt.learning && attempt.learning.ruleVersion !== LEARNING_VERSION),
    )
  )
    throw new Error("练习资料版本无法识别，原数据未修改");
}
const validId = (s: string) =>
  typeof s === "string" && s.length > 0 && s.length <= 160 && !/[\u0000-\u001f]/.test(s);
export class LearningRepository {
  private readonly database: () => Promise<IDBDatabase>;
  private readonly clock: () => Date;
  constructor(
    database: () => Promise<IDBDatabase>,
    clock: () => Date = () => new Date(),
  ) {
    this.database = database;
    this.clock = clock;
  }
  async state(): Promise<LearningState> {
    const db = await this.database();
    return requireLearningState(db.transaction("meta").objectStore("meta"));
  }
  async question(id: string): Promise<FrozenQuestion | undefined> {
    const db = await this.database();
    return get(
      db
        .transaction("meta")
        .objectStore("meta")
        .get("question:" + id),
    );
  }
  async freeze(question: FrozenQuestion): Promise<FrozenQuestion> {
    if (
      !validId(question.attemptId) ||
      !PRACTICE_MODES.includes(question.mode) ||
      !question.word ||
      question.word.length > 120 ||
      (!question.wordId && !question.entryId) ||
      question.options.length > 4 ||
      (question.sentence && question.sentence.length > 4000)
    )
      throw new Error("练习题目无效");
    const plain = JSON.parse(JSON.stringify(question));
    const db = await this.database();
    return transaction(db, ["meta"], async (tx) => {
      const meta = tx.objectStore("meta"),
        state = await requireLearningState(meta);
      const old = await get<FrozenQuestion | undefined>(
        meta.get("question:" + question.attemptId),
      );
      if (old) {
        if (
          old.wordId !== question.wordId ||
          old.entryId !== question.entryId ||
          old.mode !== question.mode
        )
          throw new Error("同一尝试不能更换词条或方式");
        return old;
      }
      meta.add(plain, "question:" + question.attemptId);
      return plain;
    });
  }
  async submit(input: PracticeSubmission): Promise<LearningReceipt> {
    if (
      !input ||
      Object.keys(input).some(
        (k) =>
          ![
            "submissionId",
            "attemptId",
            "answer",
            "choiceId",
            "signal",
            "assisted",
            "durationMs",
          ].includes(k),
      )
    )
      throw new Error("学习提交含未知字段");
    if (
      !validId(input.submissionId) ||
      !validId(input.attemptId) ||
      (input.answer !== undefined &&
        (typeof input.answer !== "string" || input.answer.length > 120)) ||
      (input.assisted !== undefined && typeof input.assisted !== "boolean") ||
      (input.durationMs !== undefined &&
        (!Number.isFinite(input.durationMs) || input.durationMs < 0))
    )
      throw new Error("学习提交无效");
    const db = await this.database();
    return transaction(db, ["meta", "words", "practice", "reviews"], async (tx) => {
      const meta = tx.objectStore("meta"),
        state = await requireLearningState(meta);
      const question = await get<FrozenQuestion | undefined>(
        meta.get("question:" + input.attemptId),
      );
      if (!question) throw new Error("本题未准备好，请重试");
      const normal = (s: string) => {
        const n = s.normalize("NFKC").trim();
        return question.ignoreCase ? n.toLowerCase() : n;
      };
      const signal = input.signal ?? "answer";
      if (
        !["answer", "reveal", "familiar", "unfamiliar"].includes(signal) ||
        (question.mode === "word-list" && signal === "answer") ||
        (question.mode !== "word-list" && ["familiar", "unfamiliar"].includes(signal))
      )
        throw new Error("本模式不接受此反馈");
      if (
        signal === "answer" &&
        question.mode === "meaning-choice" &&
        !question.options.some((o) => o.id === input.choiceId)
      )
        throw new Error("请选择本题提供的释义");
      if (signal === "answer" && question.mode === "cloze" && !question.sentence)
        throw new Error("没有真实语境，不能提交填空");
      if (
        signal === "answer" &&
        question.mode !== "meaning-choice" &&
        !input.answer?.trim()
      )
        throw new Error("请输入本题答案");
      const correct =
        signal === "familiar" ||
        (signal === "answer" &&
          (question.mode === "meaning-choice"
            ? input.choiceId === question.correctChoiceId
            : normal(input.answer!) === normal(question.word)));
      const evidence = {
        expected: normal(question.word),
        ...(signal === "answer"
          ? question.mode === "meaning-choice"
            ? { choiceId: input.choiceId!, options: question.options }
            : { answer: normal(input.answer!) }
          : {}),
      };
      const attempts = await get<PracticeAttempt[]>(tx.objectStore("practice").getAll());
      const assisted =
        !!input.assisted ||
        attempts.some(
          (p) =>
            p.id !== input.submissionId &&
            p.learning?.attemptId === input.attemptId &&
            p.learning.signal === "reveal" &&
            !p.learning.undoneAt,
        );
      const duplicate = attempts.find((p) => p.id === input.submissionId);
      if (duplicate) {
        const f = duplicate.learning;
        if (
          !f ||
          f.undoneAt ||
          f.attemptId !== input.attemptId ||
          f.signal !== signal ||
          f.assisted !== assisted ||
          JSON.stringify(f.evidence) !== JSON.stringify(evidence)
        )
          throw new Error("提交标识已用于其他内容或已撤销");
        const p = projectLearning(
          learningEvents(attempts).filter((f) => f.wordId === duplicate.wordId),
          this.clock(),
        );
        return {
          event: f,
          duplicate: true,
          score: p.score,
          delta: 0,
          status: p.status,
          effective: false,
        };
      }
      const rows = await get<UserWord[]>(tx.objectStore("words").getAll());
      let word = rows.find((w) =>
        question.wordId ? w.id === question.wordId : w.entryId === question.entryId,
      );
      if (word?.deletedAt) throw new Error("词条已回收");
      // 公共词按 entryId 关联；同形的其他公共词不能静默合并到本题。
      if (!word) {
        const same = rows.find(
          (w) => w.normalized === question.word.normalize("NFC").toLowerCase(),
        );
        if (same && same.entryId && same.entryId !== question.entryId)
          throw new Error("同形词身份不同，请保留原词并选择明确词条");
        word = same;
      }
      if (word?.deletedAt) throw new Error("词条已回收");
      const now = this.clock().toISOString();
      if (!word) {
        const book = await get<BookMeta>(meta.get("book"));
        word = {
          id: crypto.randomUUID(),
          bookUid: book.bookUid,
          word: question.word,
          normalized: question.word.normalize("NFC").toLowerCase(),
          note: "",
          dictionaryHint: question.meaning,
          phoneticHint: question.phonetic,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          revision: 1,
          notebookIds: [],
          collected: false,
          entryId: question.entryId,
        };
        tx.objectStore("words").add(word);
      }
      const events = learningEvents(attempts).filter((f) => f.wordId === word!.id),
        latest = orderedLearningEvents(events.filter((f) => !f.undoneAt)).at(-1);
      if (latest && Date.parse(now) < Date.parse(latest.createdAt))
        throw new Error("系统时间早于上次练习，请校准后重试");
      const before = projectLearning(events, new Date(now));
      const reviews = await get<ReviewFact[]>(
        tx.objectStore("reviews").index("wordId").getAll(word.id),
      );
      const memory = projectFsrs(word.createdAt, reviews);
      if (memory.lastReviewAt && Date.parse(now) < Date.parse(memory.lastReviewAt))
        throw new Error("系统时间早于旧学习记录，请校准后重试");
      const plan = await get<StudyPlan | undefined>(meta.get("studyPlan")),
        zone =
          plan?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const book = await get<BookMeta>(meta.get("book")),
        first = !events.some((f) => f.attemptId === input.attemptId && !f.undoneAt),
        day = learningDay(new Date(now), zone);
      // 主动练习按已生效的复习资格计当日完成；FSRS 到期只控制自动候选与调度。
      // 未毕业、同日初学、休息中、提示/临摹/同题订正仍不能占复习完成额度。
      const event: LearningEvent = {
        id: input.submissionId,
        submissionId: input.submissionId,
        attemptId: input.attemptId,
        wordId: word.id,
        entryId: question.entryId,
        mode: question.mode,
        signal,
        correct,
        assisted,
        createdAt: now,
        studyDay: day,
        zone,
        ruleVersion: LEARNING_VERSION,
        deviceId: book.deviceId,
        deviceSeq: state.sequence + 1,
        logicalClock: state.sequence + 1,
        evidence,
        origin: "practice",
        undoneAt: null,
        reviewCompleted:
          first &&
          correct &&
          !assisted &&
          question.mode !== "copy" &&
          before.status === "review" &&
          before.graduatedDay !== day &&
          !!before.reviewEligibleAt &&
          Date.parse(now) >= Date.parse(before.reviewEligibleAt),
      };
      const after = projectLearning([...events, event], new Date(now));
      if (
        first &&
        after.lastEffective &&
        (!correct || !memory.lastReviewAt || Date.parse(now) >= Date.parse(memory.dueAt))
      ) {
        const next = reviewFsrs(memory, correct ? "good" : "again", now);
        tx.objectStore("reviews").add({
          id: crypto.randomUUID(),
          wordId: word.id,
          rating: correct ? "good" : "again",
          createdAt: now,
          undoneAt: null,
          algorithmVersion: FSRS_ALGORITHM,
          sourceSubmissionId: event.id,
          logicalClock: event.logicalClock,
          beforeState: memory,
          afterState: next,
        } satisfies ReviewFact);
      }
      tx.objectStore("practice").add({
        id: event.id,
        wordId: word.id,
        entryId: question.entryId,
        mode: question.mode,
        answer: (input.answer || input.choiceId || signal).slice(0, 120),
        correct,
        durationMs: input.durationMs ?? 0,
        createdAt: now,
        learning: event,
      } satisfies PracticeAttempt);
      meta.put(
        {
          ...state,
          sequence: state.sequence + 1,
          revision: state.revision + 1,
        },
        "learning",
      );
      return {
        event,
        duplicate: false,
        score: after.score,
        delta: after.lastDelta,
        status: after.status,
        effective: first,
      };
    });
  }
  // 后续接入所需命令；仅将最新未撤销事件连同其调度事实原子回退。
  async undo(submissionId: string) {
    const db = await this.database();
    await transaction(db, ["practice", "reviews", "meta"], async (tx) => {
      const store = tx.objectStore("practice"),
        all = await get<PracticeAttempt[]>(store.getAll()),
        current = all.find((p) => p.id === submissionId);
      if (!current?.learning) throw new Error("学习事件不存在");
      if (current.learning.undoneAt) return;
      const latest = all
        .filter((p) => p.wordId === current.wordId && p.learning && !p.learning.undoneAt)
        .sort((a, b) => b.learning!.logicalClock - a.learning!.logicalClock)[0];
      if (latest?.id !== submissionId) throw new Error("只能撤销该词最新练习");
      const at = this.clock().toISOString();
      store.put({
        ...current,
        learning: { ...current.learning, undoneAt: at },
      });
      const reviews = await get<ReviewFact[]>(tx.objectStore("reviews").getAll());
      for (const f of reviews)
        if (f.sourceSubmissionId === submissionId)
          tx.objectStore("reviews").put({ ...f, undoneAt: at });
      const state = await requireLearningState(tx.objectStore("meta"));
      tx.objectStore("meta").put({ ...state, revision: state.revision + 1 }, "learning");
    });
  }
}
