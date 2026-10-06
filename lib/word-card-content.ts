import type { CardField, WorkspacePreferences } from "./workspace-model.ts";

// 完整词卡展示面向阅读的全部模块，公共资源原始 JSON 不属于产品显示字段。
export const CARD_SECTION_LABELS: Record<Exclude<CardField, "raw">, string> = {
  pronunciations: "候选音标",
  senses: "逐义释义",
  explanations: "学习解释与英语义项",
  usage: "用法与义项标签",
  examples: "词典例句",
  contexts: "我的阅读语境",
  forms: "词形变化",
  memory: "短助记与学习提示",
  articles: "助记文章",
  lexical: "词汇关系与短语",
  collections: "词书归属与词频",
  personal: "个人笔记",
  sources: "来源与审核",
};
export const CARD_PRESETS: Record<
  Exclude<WorkspacePreferences["card"]["level"], "custom">,
  CardField[]
> = {
  minimal: ["senses", "contexts"],
  moderate: ["pronunciations", "senses", "examples", "contexts", "personal"],
  detailed: [
    "pronunciations",
    "senses",
    "explanations",
    "usage",
    "examples",
    "contexts",
    "forms",
    "memory",
    "collections",
    "personal",
  ],
  complete: Object.keys(CARD_SECTION_LABELS) as CardField[],
};
export function readableCardSections(card: WorkspacePreferences["card"]): CardField[] {
  return card.level === "custom"
    ? card.sections.filter((field) => field in CARD_SECTION_LABELS)
    : [...CARD_PRESETS[card.level]];
}
// 字段确认以独立草稿开始；完整默认全选，自定义继承当前可读字段，取消不写设置。
export function cardSettingsDraft(
  current: WorkspacePreferences["card"],
  initialLevel = current.level,
): WorkspacePreferences["card"] {
  return {
    level: initialLevel,
    sections:
      initialLevel === "custom"
        ? readableCardSections(current)
        : [...CARD_PRESETS[initialLevel]],
  };
}
// 词汇关系只读人可理解的字段，避免把扩展字段、内部 ID 或源载荷变成 JSON 正文。
export function lexicalText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const item = value as Record<string, unknown>;
  const head = [item.headword, item.word, item.text, item.phrase].find(
    (x) => typeof x === "string" && x,
  );
  const meaning = [item.meaning, item.translation, item.gloss, item.short_gloss].find(
    (x) => typeof x === "string" && x,
  );
  return [head, meaning].filter(Boolean).join(" · ");
}
