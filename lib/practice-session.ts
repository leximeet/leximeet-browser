import type { CoreEntry, LexiconEntry } from "./lexicon.ts";
import type { WorkspacePreferences } from "./workspace-model.ts";
// 六种方式共享范围，但各自保存位置、完成进度和逐词草稿。
export const PRACTICE_MODES = [
  "word-list",
  "meaning-choice",
  "copy",
  "recall",
  "listening",
  "cloze",
] as const;
export type PracticeMode = (typeof PRACTICE_MODES)[number];
export type ListRecall = {
  answer: "familiar" | "unfamiliar" | null;
  revealed: boolean;
};
export const PRACTICE_LABELS: [PracticeMode, string][] = [
  ["word-list", "单词列表"],
  ["meaning-choice", "看词选义"],
  ["copy", "单词临摹"],
  ["recall", "单词默写"],
  ["listening", "听音辨词"],
  ["cloze", "语境填空"],
];
export type PracticeTurn = {
  position: number;
  round: number;
  phase: "running" | "error" | "success" | "answered";
  answer: string | null;
  errors: number;
  hint: boolean;
  correct?: boolean;
  input?: string; // 听音 / 填空的真实输入。
};
// 今日队列绑定学习日期和目标；新目标/次日重新生成，不恢复另一规划的队列。
export type PracticeContext = {
  studyDay: string;
  goalKey: string | null;
};
export type PracticeSession = {
  schema: "leximeet.practice/3";
  id: string;
  scope: string;
  context?: PracticeContext;
  ids: string[];
  index: number;
  // index 是当前方式的位置；切换方式只恢复对应位置，不覆盖其他方式。
  indices?: Partial<Record<PracticeMode, number>>;
  mode: PracticeMode;
  preferences: WorkspacePreferences["practice"];
  turns: Partial<Record<PracticeMode, PracticeTurn>>;
  // 当前词由 turns 展示；切词时按词保存所有模式草稿，回到该词恢复。
  wordTurns?: Record<string, Partial<Record<PracticeMode, PracticeTurn>>>;
  results: { key: string; mode: PracticeMode; correct: boolean; completed?: boolean }[];
  savedAt?: string;
  listRecall?: Record<string, ListRecall>;
  listMask?: "word" | "meaning";
};
const modes: readonly PracticeMode[] = PRACTICE_MODES;
const blankTurn = (): PracticeTurn => ({
  position: 0,
  round: 0,
  phase: "running",
  answer: null,
  errors: 0,
  hint: false,
});
export const currentTurn = (s: PracticeSession): PracticeTurn =>
  s.turns[s.mode] || blankTurn();
export function createPracticeSession(
  ids: string[],
  scope: string,
  mode: PracticeMode,
  preferences: WorkspacePreferences["practice"],
  context?: PracticeContext,
): PracticeSession {
  return {
    schema: "leximeet.practice/3",
    id: crypto.randomUUID(),
    scope,
    ...(context ? { context: { ...context } } : {}),
    ids: [...new Set(ids)],
    index: 0,
    indices: Object.fromEntries(PRACTICE_MODES.map((mode) => [mode, 0])),
    mode,
    preferences: { ...preferences },
    turns: {},
    wordTurns: {},
    results: [],
  };
}
function setTurn(s: PracticeSession, t: PracticeTurn): PracticeSession {
  return { ...s, turns: { ...s.turns, [s.mode]: t } };
}
export function setPracticeMode(s: PracticeSession, mode: PracticeMode): PracticeSession {
  if (!modes.includes(mode)) throw new Error("不支持的练习方式");
  if (mode === s.mode) return s;
  const indices = { ...s.indices, [s.mode]: s.index };
  const next = movePracticeWord(s, indices[mode] ?? 0);
  return { ...next, mode, indices: { ...indices, [mode]: next.index } };
}
export function chooseMeaning(
  s: PracticeSession,
  answer: string,
  correctId: string,
): PracticeSession {
  const t = currentTurn(s);
  return t.answer !== null
    ? s
    : setTurn(s, {
        ...t,
        answer,
        correct: answer === correctId,
        phase: "answered",
      });
}
export function typeCharacter(
  s: PracticeSession,
  word: string,
  key: string,
): PracticeSession {
  const t = currentTurn(s);
  if (
    !["copy", "recall"].includes(s.mode) ||
    t.phase !== "running" ||
    !/^[\x20-\x7e]$/.test(key)
  )
    return s;
  const expected = word[t.position];
  if (!expected) return s;
  const correct = s.preferences.ignoreCase
    ? expected.toLowerCase() === key.toLowerCase()
    : key === expected;
  if (!correct)
    return setTurn(s, {
      ...t,
      phase: "error",
      errors: t.errors + 1,
      hint: false,
    });
  const position = t.position + 1,
    complete = position === word.length;
  return setTurn(s, {
    ...t,
    position,
    phase: complete ? "success" : "running",
    round: t.round + Number(complete),
    hint: false,
  });
}
export function backspaceCharacter(s: PracticeSession): PracticeSession {
  const t = currentTurn(s);
  return t.phase === "running" && t.position
    ? setTurn(s, { ...t, position: t.position - 1 })
    : s;
}
export function revealSpelling(s: PracticeSession): PracticeSession {
  return setTurn(s, { ...currentTurn(s), hint: !currentTurn(s).hint });
}
export function settleSpelling(s: PracticeSession): PracticeSession {
  const t = currentTurn(s);
  // 已确认完整结算的题只供重看；后来提高重复次数不会把它变回未完成题。
  if (practiceWordCompleted(s)) return s;
  return t.phase === "error"
    ? setTurn(s, { ...t, position: 0, phase: "running" })
    : t.phase === "success" && t.round < s.preferences.repeat
      ? setTurn(s, {
          ...t,
          position: 0,
          input: "",
          phase: "running",
          hint: false,
        })
      : s;
}
// 移动当前方式时冻结离开词的草稿，其他方式的位置保持原样。
function movePracticeWord(s: PracticeSession, index: number): PracticeSession {
  if (index === s.index) return s;
  const previous = s.ids[s.index],
    next = s.ids[index];
  const wordTurns = previous
    ? { ...s.wordTurns, [previous]: { ...s.turns } }
    : { ...s.wordTurns };
  const turns = next && Object.hasOwn(wordTurns, next) ? wordTurns[next] : {};
  return {
    ...s,
    index,
    indices: { ...s.indices, [s.mode]: index },
    wordTurns,
    turns: { ...turns },
  };
}
export const nextPracticeWord = (s: PracticeSession): PracticeSession =>
  movePracticeWord(s, Math.min(s.ids.length, s.index + 1));
export const previousPracticeWord = (s: PracticeSession): PracticeSession =>
  movePracticeWord(s, Math.max(0, s.index - 1));

// 词条回收后只裁剪练习草稿；已结算事实留在学习仓库，各模式位置按剩余词序重定位。
export function retainPracticeWords(
  s: PracticeSession,
  active: Set<string>,
): PracticeSession {
  const ids = s.ids.filter((key) => active.has(key));
  if (ids.length === s.ids.length) return s;
  const oldCurrent = s.ids[s.index],
    drafts = {
      ...s.wordTurns,
      ...(oldCurrent ? { [oldCurrent]: { ...s.turns } } : {}),
    },
    remap = (index: number) =>
      s.ids.slice(0, index).filter((key) => active.has(key)).length,
    index = remap(s.index),
    indices = Object.fromEntries(
      PRACTICE_MODES.map((mode) => [
        mode,
        remap(mode === s.mode ? s.index : (s.indices?.[mode] ?? 0)),
      ]),
    );
  return {
    ...s,
    ids,
    index,
    indices,
    turns: { ...(drafts[ids[index]!] || {}) },
    wordTurns: Object.fromEntries(
      Object.entries(drafts).filter(([key]) => active.has(key)),
    ),
    ...(s.listRecall
      ? {
          listRecall: Object.fromEntries(
            Object.entries(s.listRecall).filter(([key]) => active.has(key)),
          ),
        }
      : {}),
    results: s.results.filter((result) => active.has(result.key)),
  };
}

// 回执证明当时已完成全部重复；设置变化不能撤销这道题的已完成记录。
export function practiceWordCompleted(s: PracticeSession, key = s.ids[s.index]): boolean {
  return (
    !!key &&
    s.results.some(
      (result) => result.key === key && result.mode === s.mode && result.completed,
    )
  );
}
// 完成数量依据本方式的完整结算回执，不用游标或后来修改的重复次数重算。
export function practiceCompletedCount(s: PracticeSession): number {
  const confirmed = new Set(
    s.results
      .filter((result) => result.mode === s.mode && result.completed)
      .map((result) => result.key),
  );
  // 完成回执是权威记录；输入草稿或展示阶段变化不能让已完成的词倒退。
  return s.ids.filter((key) => confirmed.has(key)).length;
}
function validTurns(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([mode, t]) =>
      modes.includes(mode as PracticeMode) &&
      !!t &&
      typeof t === "object" &&
      !Array.isArray(t) &&
      Object.keys(t).every((k) =>
        [
          "position",
          "round",
          "phase",
          "answer",
          "errors",
          "hint",
          "correct",
          "input",
        ].includes(k),
      ) &&
      Number.isInteger(t.position) &&
      t.position >= 0 &&
      t.position <= 120 &&
      Number.isInteger(t.round) &&
      t.round >= 0 &&
      t.round <= 10 &&
      ["running", "error", "success", "answered"].includes(t.phase) &&
      (t.answer === null || typeof t.answer === "string") &&
      Number.isInteger(t.errors) &&
      t.errors >= 0 &&
      typeof t.hint === "boolean" &&
      (t.correct === undefined || typeof t.correct === "boolean") &&
      (t.input === undefined || (typeof t.input === "string" && t.input.length <= 120)),
  );
}
export function validPracticeSession(value: unknown): value is PracticeSession {
  const s = value as PracticeSession;
  const knownIds = new Set(Array.isArray(s?.ids) ? s.ids : []);
  return (
    !!s &&
    Object.keys(s).every((k) =>
      [
        "schema",
        "id",
        "scope",
        "context",
        "ids",
        "index",
        "indices",
        "mode",
        "preferences",
        "turns",
        "wordTurns",
        "results",
        "savedAt",
        "listRecall",
        "listMask",
      ].includes(k),
    ) &&
    s.schema === "leximeet.practice/3" &&
    typeof s.id === "string" &&
    s.id.length <= 120 &&
    typeof s.scope === "string" &&
    s.scope.length <= 160 &&
    (s.context === undefined ||
      (!!s.context &&
        typeof s.context === "object" &&
        !Array.isArray(s.context) &&
        Object.keys(s.context).every((k) => ["studyDay", "goalKey"].includes(k)) &&
        typeof s.context.studyDay === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(s.context.studyDay) &&
        Number.isFinite(Date.parse(s.context.studyDay + "T00:00:00Z")) &&
        new Date(s.context.studyDay + "T00:00:00Z").toISOString().slice(0, 10) ===
          s.context.studyDay &&
        (s.context.goalKey === null ||
          (typeof s.context.goalKey === "string" &&
            s.context.goalKey.length <= 1000)))) &&
    Array.isArray(s.ids) &&
    s.ids.length <= 127902 &&
    s.ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 120) &&
    knownIds.size === s.ids.length &&
    Number.isInteger(s.index) &&
    s.index >= 0 &&
    s.index <= s.ids.length &&
    (s.indices === undefined ||
      (!!s.indices &&
        typeof s.indices === "object" &&
        !Array.isArray(s.indices) &&
        Object.entries(s.indices).every(
          ([mode, index]) =>
            modes.includes(mode as PracticeMode) &&
            Number.isInteger(index) &&
            index! >= 0 &&
            index! <= s.ids.length,
        ) &&
        s.indices[s.mode] === s.index)) &&
    modes.includes(s.mode) &&
    !!s.preferences &&
    Object.keys(s.preferences).every((k) =>
      [
        "repeat",
        "ignoreCase",
        "autoNext",
        "autoPronounce",
        "soundFeedback",
        "hideWord",
        "hideMeaning",
        "hideSentence",
      ].includes(k),
    ) &&
    typeof s.preferences.soundFeedback === "boolean" &&
    Number.isInteger(s.preferences.repeat) &&
    s.preferences.repeat >= 1 &&
    s.preferences.repeat <= 10 &&
    [
      "ignoreCase",
      "autoNext",
      "autoPronounce",
      "hideWord",
      "hideMeaning",
      "hideSentence",
    ].every((k) => typeof s.preferences[k as keyof typeof s.preferences] === "boolean") &&
    validTurns(s.turns) &&
    (s.wordTurns === undefined ||
      (!!s.wordTurns &&
        typeof s.wordTurns === "object" &&
        !Array.isArray(s.wordTurns) &&
        Object.keys(s.wordTurns).length <= s.ids.length &&
        Object.entries(s.wordTurns).every(
          ([word, turns]) =>
            knownIds.has(word) &&
            validTurns(turns) &&
            Object.values(turns).every((t) => !t || t.position <= word.length),
        ))) &&
    (s.listMask === undefined || ["word", "meaning"].includes(s.listMask)) &&
    (s.listRecall === undefined ||
      (!!s.listRecall &&
        !Array.isArray(s.listRecall) &&
        typeof s.listRecall === "object" &&
        Object.keys(s.listRecall).length <= s.ids.length &&
        Object.entries(s.listRecall).every(
          ([key, value]) =>
            knownIds.has(key) &&
            !!value &&
            Object.keys(value).every((k) => ["answer", "revealed"].includes(k)) &&
            [null, "familiar", "unfamiliar"].includes(value.answer) &&
            typeof value.revealed === "boolean",
        ))) &&
    Array.isArray(s.results) &&
    s.results.length <= 1000000 &&
    s.results.every(
      (r) =>
        Object.keys(r || {}).every((k) =>
          ["key", "mode", "correct", "completed"].includes(k),
        ) &&
        typeof r.key === "string" &&
        modes.includes(r.mode) &&
        typeof r.correct === "boolean" &&
        (r.completed === undefined || typeof r.completed === "boolean"),
    )
  );
}
export function restorePracticeSession(
  saved: unknown,
  known: Set<string>,
  expectedContext?: PracticeContext,
): PracticeSession | null {
  if (!validPracticeSession(saved) || saved.ids.some((id) => !known.has(id))) return null;
  if (
    expectedContext &&
    (saved.context?.studyDay !== expectedContext.studyDay ||
      saved.context?.goalKey !== expectedContext.goalKey)
  )
    return null;
  // 会话已严格验证为 JSON 数据；UI 的 Vue Proxy 不能直接 structuredClone。
  // 转成独立快照后再恢复，既不修改响应式原稿，也不丢失各词模式草稿。
  const s: PracticeSession = JSON.parse(JSON.stringify(saved));
  const word = s.ids[s.index];
  if (word && Object.values(s.turns).some((t) => t && t.position > word.length))
    return null;
  // 定时复位在进程关闭时可能尚未执行；当前词和已离开的词均按同一规则恢复。
  for (const turns of [s.turns, ...Object.values(s.wordTurns || {})])
    for (const t of Object.values(turns))
      if (t?.phase === "error") {
        t.position = 0;
        t.phase = "running";
      }
  return s;
}
const ranks: Record<string, number> = {
  core: 0,
  common: 1,
  specialized: 2,
  rare: 3,
};
export function conciseMeaning(entry: CoreEntry): string {
  const senses = [...entry.senses]
    .filter((s) => s.short_gloss?.trim())
    .sort(
      (a, b) =>
        (ranks[a.priority] ?? 2) - (ranks[b.priority] ?? 2) ||
        a.display_order - b.display_order,
    );
  const core = senses.filter((s) => s.priority === "core");
  return [
    ...new Set(
      (core.length ? core : senses.slice(0, 1))
        .slice(0, 3)
        .map((s) => s.short_gloss!.trim()),
    ),
  ].join("；");
}
// 干扰项使用真实短义，排除前后缀、符号、单字母、缩写与重叠释义。
export function meaningChoices(
  entry: LexiconEntry,
  pool: LexiconEntry[],
  index = 0,
): { id: string; text: string; correct: boolean }[] {
  const correct = conciseMeaning(entry.raw);
  if (!correct) return [];
  const own = new Set(entry.senses.map((s) => s.short_gloss?.trim()).filter(Boolean)),
    seen = new Set([correct]);
  const choices = [{ id: entry.entryId, text: correct, correct: true }];
  // 同词性优先，但每题从不同的确定性起点选干扰项，避免连续练习总见前三个答案。
  // 无随机环境依赖；已冻结题仍由仓库直接返回，不因候选顺序变化改判题。
  const seed = index + [...entry.entryId].reduce((n, c) => n + c.charCodeAt(0), 0);
  const candidates = pool.filter(
    (x) =>
      x.entryId !== entry.entryId &&
      x.word.length > 1 &&
      x.word !== x.word.toUpperCase() &&
      /^[A-Za-z]+(?:[-' ][A-Za-z]+)*$/.test(x.word) &&
      !x.senses.some((s) => own.has(s.short_gloss?.trim())),
  );
  const rotate = (items: LexiconEntry[]) => {
    if (!items.length) return items;
    const start = seed % items.length;
    return [...items.slice(start), ...items.slice(0, start)];
  };
  for (const e of [
    ...rotate(candidates.filter((c) => c.possiblePos[0] === entry.possiblePos[0])),
    ...rotate(candidates.filter((c) => c.possiblePos[0] !== entry.possiblePos[0])),
  ]) {
    const text = conciseMeaning(e.raw);
    if (!text || text.length > 80 || seen.has(text)) continue;
    seen.add(text);
    choices.push({ id: e.entryId, text, correct: false });
    if (choices.length === 4) break;
  }
  if (choices.length < 2) return [];
  const offset = seed % choices.length;
  return [...choices.slice(offset), ...choices.slice(0, offset)];
}
export function spellingSentence(sentence: string, word: string, reveal = false): string {
  if (reveal) return sentence;
  return sentence.replace(
    new RegExp(
      `(?<![A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`,
      "gi",
    ),
    "_____",
  );
}

// 列表点击只移动列表方式的位置；其他词的列表反馈和各模式位置保留。
export function selectPracticeWord(s: PracticeSession, index: number): PracticeSession {
  if (!Number.isInteger(index) || index < 0 || index >= s.ids.length) return s;
  return movePracticeWord(s, index);
}
export function listRecall(s: PracticeSession, key: string): ListRecall {
  return (
    (s.listRecall && Object.hasOwn(s.listRecall, key) ? s.listRecall[key] : null) || {
      answer: null,
      revealed: false,
    }
  );
}
export function revealListWord(s: PracticeSession, key: string): PracticeSession {
  if (!s.ids.includes(key)) return s;
  return {
    ...s,
    listRecall: {
      ...s.listRecall,
      [key]: { ...listRecall(s, key), revealed: true },
    },
  };
}
export function answerListWord(
  s: PracticeSession,
  key: string,
  answer: "familiar" | "unfamiliar",
): PracticeSession {
  if (!s.ids.includes(key) || listRecall(s, key).answer !== null) return s;
  return {
    ...s,
    listRecall: { ...s.listRecall, [key]: { ...listRecall(s, key), answer } },
  };
}

// 听音与填空整词确认；错误稿可以修改，成功后由同一重复/下一词流程继续。
export function updateWrittenAnswer(s: PracticeSession, input: string): PracticeSession {
  const t = currentTurn(s);
  if (
    !["listening", "cloze"].includes(s.mode) ||
    t.phase === "success" ||
    (input === t.input && t.phase === "answered")
  )
    return s;
  return setTurn(s, { ...t, input: input.slice(0, 120), phase: "running" });
}
export function submitWrittenAnswer(s: PracticeSession, word: string): PracticeSession {
  const t = currentTurn(s);
  if (
    !["listening", "cloze"].includes(s.mode) ||
    t.phase === "success" ||
    t.phase === "answered" ||
    !t.input?.trim()
  )
    return s;
  const normalize = (value: string) => {
    const text = value.normalize("NFKC").trim();
    return s.preferences.ignoreCase ? text.toLowerCase() : text;
  };
  const correct = normalize(t.input) === normalize(word);
  return setTurn(s, {
    ...t,
    correct,
    phase: correct ? "success" : "answered",
    errors: t.errors + Number(!correct),
    round: t.round + Number(correct),
  });
}

// 精确词边界；不能把 cat 在 concatenate 中的片段或无关例句当填空题。
export function maskHeadword(text: string, word: string): string {
  if (!word) return text;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"),
    "_____",
  );
}
export function clozeQuestion(
  word: string,
  sentences: string[],
): { sentence: string; question: string } | null {
  for (const sentence of sentences) {
    if (!sentence?.trim()) continue;
    const question = maskHeadword(sentence, word);
    if (question !== sentence) return { sentence, question };
  }
  return null;
}
