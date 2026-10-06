import { normalize, publicWord, sanitizeUrl, validRanges } from "./pure.ts";

// note-only 是首发冻结模型；此前包含补充释义的 /3 试验库拒绝并完整保留，不做迁移。
export const PERSONAL_FORMAT = "leximeet-browser-personal/4";
export const PERSONAL_DB_VERSION = 4;
export const MAX_ACTIVE_WORDS = 10_000;
export type Theme = "system" | "light" | "dark";
export type ReviewRating = "again" | "hard" | "good" | "easy";
export type PracticeMode = import("./practice-session.ts").PracticeMode;
export type BookMeta = {
  format: typeof PERSONAL_FORMAT;
  bookUid: string;
  deviceId: string;
  name: "浏览器插件词库";
  createdAt: string;
};

// 个人词条只保存用户编辑的内容；dictionaryHint 是可丢弃的只读资源缓存。
export type UserWord = {
  id: string;
  bookUid: string;
  word: string;
  normalized: string;
  note: string;
  dictionaryHint: string;
  phoneticHint: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number;
  notebookIds: string[];
  collected?: boolean;
  entryId?: string | null;
};

// 一个词条可关联多本单词本；软删除仅影响该分组，不删除词条。
export type Notebook = {
  id: string;
  name: string;
  color: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number;
};

// 学习目标来自当前词书或整本词典；个人本只用于整理和自由练习。
export type StudyPlan = {
  revision?: number;
  id: string;
  sourceKind: "catalog" | "dictionary";
  sourceId: string;
  sourceVersion: "0.0.3";
  dailyNew: number;
  dailyReview: number;
  startedOn: string;
  timeZone: string;
  savedAt: string;
  paused: boolean;
};
export function validPlanTimeZone(value: string): boolean {
  if (!value || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function validPlanDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}

export type LocalEncounter = {
  id: string;
  wordId: string;
  surface: string;
  originalSentence: string;
  savedExcerpt: string;
  occurrenceRanges: { start: number; end: number }[];
  excerptRanges: { start: number; end: number }[];
  annotation: { note: string };
  source: { title: string; url: string };
  occurredAt: string;
  timeZone: string;
  undoneAt: string | null;
};

export type ReviewFact = {
  id: string;
  wordId: string;
  rating: ReviewRating;
  createdAt: string;
  undoneAt: string | null;
  algorithmVersion: string;
  sourceSubmissionId?: string;
  logicalClock?: number;
  beforeState?: import("./fsrs.ts").FsrsMemory;
  afterState?: import("./fsrs.ts").FsrsMemory;
};

export type PracticeAttempt = {
  id: string;
  wordId: string | null;
  entryId: string | null;
  mode: PracticeMode;
  answer: string;
  correct: boolean;
  durationMs: number;
  learning?: import("./learning.ts").LearningEvent;
  createdAt: string;
};

// 主题为全局本机设置；词卡和练习偏好只保存在 WorkspacePreferences。
export type LocalSettings = { theme: Theme };
export const defaultLocalSettings = (): LocalSettings => ({ theme: "system" });

export type CaptureInput = {
  // 可信侧栏选择的单词本；内容脚本不能指定。
  notebookId?: string;
  eventId: string;
  surface: string;
  originalSentence: string;
  savedExcerpt: string;
  occurrenceRanges: { start: number; end: number }[];
  excerptRanges: { start: number; end: number }[];
  annotation: { note: string };
  source: { title: string; url: string };
  occurredAt: string;
  timeZone: string;
  dictionary?: {
    meaning: string;
    phonetic: string;
    word?: string;
    entryId?: string;
  } | null;
};

// 与网页采集相同的 UTF-16 范围校验；查词和分析绝不生成遇见。
export function validateCapture(input: CaptureInput): CaptureInput {
  // 首发只保留个人笔记。旧补充释义或私人标签不能作为空占位继续写入新模型。
  if (
    !input.annotation ||
    typeof input.annotation !== "object" ||
    Array.isArray(input.annotation) ||
    Object.keys(input.annotation).some((key) => key !== "note") ||
    typeof input.annotation.note !== "string"
  )
    throw new Error("采集批注只支持笔记");
  if (!publicWord(input.surface)) throw new Error("词头无效");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input.eventId))
    throw new Error("事件 ID 无效");
  if (
    input.originalSentence.length > 4000 ||
    input.savedExcerpt.length > 4000 ||
    !validRanges(input.originalSentence, input.surface, input.occurrenceRanges) ||
    !validRanges(input.savedExcerpt, input.surface, input.excerptRanges)
  )
    throw new Error("原句或摘录没有精确包含所选词");
  const url = sanitizeUrl(input.source.url);
  if (!url) throw new Error("来源网址无效");
  if (!Number.isFinite(Date.parse(input.occurredAt))) throw new Error("遇见时间无效");
  return {
    ...input,
    surface: input.surface.trim(),
    source: { title: input.source.title.slice(0, 300), url },
    annotation: {
      note: input.annotation.note.slice(0, 4000),
    },
    timeZone: input.timeZone.slice(0, 80),
  };
}

export function normalizedWord(word: string): string {
  // 手工查词可保存词典中的短语、符号词和变音符号；网页采集仍使用更窄的 publicWord 白名单。
  if (
    typeof word !== "string" ||
    !word.trim() ||
    word.trim().length > 120 ||
    /[\u0000-\u001f\u007f]/.test(word)
  )
    throw new Error("请输入有效词头或短语（最多 120 字符）");
  return normalize(word);
}
