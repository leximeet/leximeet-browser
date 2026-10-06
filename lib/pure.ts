import type { CaptureItem, Rules } from "./types.ts";
export const defaultRules = (): Rules => ({
  schemaVersion: 1,
  revision: "1",
  language: "en",
  length: { min: 3, max: 40 },
  allowedPos: null,
  allowedFamiliarity: null,
  excludedLexemes: [],
  posMode: "dictionary-possible",
  unknownPolicy: "review",
  normalizationVersion: "en-lexeme-1",
});
export function normalize(word: string) {
  return word.normalize("NFKC").toLowerCase().trim();
}
export function sanitizeUrl(input: string) {
  try {
    const u = new URL(input);
    // 内置教学语境使用唯一稳定标识，其他非 HTTP(S) 地址一律拒绝。
    if (input === "leximeet://tutorial/reading") return input;
    if (!["http:", "https:"].includes(u.protocol)) return "";
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return "";
  }
}
export function encodedSize(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
// 遇见遵守当前 Desktop 120 字词头上限；采集和公共字典仍遵守 100 字协议上限。
export function encounterWord(word: string) {
  return (
    typeof word === "string" &&
    word.length <= 120 &&
    /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(word)
  );
}
export function publicWord(word: string) {
  return encounterWord(word) && word.length <= 100;
}
export function rangesFor(text: string, surface: string) {
  const result: { start: number; end: number }[] = [];
  const hay = text,
    needle = surface;
  if (!needle) return result;
  let p = 0;
  while ((p = hay.indexOf(needle, p)) >= 0) {
    const before = text[p - 1] || "",
      after = text[p + needle.length] || "";
    if (!/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after))
      result.push({ start: p, end: p + needle.length });
    p += needle.length;
  }
  return result;
}
export function validRanges(
  text: string,
  surface: string,
  ranges: { start: number; end: number }[],
) {
  return (
    ranges.length > 0 &&
    ranges.every(
      (r) =>
        Number.isInteger(r.start) &&
        Number.isInteger(r.end) &&
        r.start >= 0 &&
        r.end > r.start &&
        r.end <= text.length &&
        text.slice(r.start, r.end) === surface,
    )
  );
}
export function validateItem(item: CaptureItem) {
  return (
    publicWord(item.surface) &&
    item.originalSentence.length <= 4000 &&
    item.savedExcerpt.length <= 4000 &&
    validRanges(item.originalSentence, item.surface, item.occurrenceRanges) &&
    validRanges(item.savedExcerpt, item.surface, item.excerptRanges)
  );
}
export type CandidateStatus = "allowed" | "needsReview" | "rejected";

// 只做浏览器候选解释，最终判定由 Desktop 的权威规则与字典完成。
export function classifyCandidate(
  word: string,
  status: string | undefined,
  pos: string[] | undefined,
  rules: Rules,
): { status: CandidateStatus; reason: string | null } {
  const normalized = normalize(word),
    length = (normalized.match(/[a-z]/g) || []).length;
  if (rules.length && (length < rules.length.min || length > rules.length.max))
    return { status: "rejected", reason: "词长不符合规则" };
  if (rules.excludedLexemes.map(normalize).includes(normalized))
    return { status: "rejected", reason: "已排除" };
  const familiarity =
    status === undefined
      ? "uncollected"
      : status === "mastered"
        ? "mastered"
        : "learning";
  if (rules.allowedFamiliarity && !rules.allowedFamiliarity.includes(familiarity))
    return { status: "rejected", reason: "学习状态不符合规则" };
  if (rules.allowedPos === null) return { status: "allowed", reason: null };
  if (rules.allowedPos.length === 0)
    return { status: "rejected", reason: "词性集合为空" };
  if (!pos?.length) {
    if (rules.unknownPolicy === "exclude")
      return { status: "rejected", reason: "词性未知且规则排除" };
    return { status: "needsReview", reason: "词性未知，需复核" };
  }
  if (!pos.some((p) => rules.allowedPos!.includes(p)))
    return { status: "rejected", reason: "词性不符合规则" };
  return { status: "allowed", reason: null };
}

export function evaluateRules(
  word: string,
  status: string | undefined,
  pos: string[] | undefined,
  rules: Rules,
): string | null {
  return classifyCandidate(word, status, pos, rules).reason;
}
export function splitSentences(text: string) {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return [...segmenter.segment(text)].map((s) => ({
    text: s.segment,
    start: s.index,
    end: s.index + s.segment.length,
  }));
}
export function tokenize(text: string) {
  return [...text.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)].map((m) => ({
    surface: m[0],
    normalized: normalize(m[0]),
    start: m.index!,
    end: m.index! + m[0].length,
  }));
}
export function validateRules(value: Rules) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.language !== "en" ||
    value.posMode !== "dictionary-possible" ||
    value.normalizationVersion !== "en-lexeme-1" ||
    !["review", "exclude"].includes(value.unknownPolicy) ||
    !/^\d+$/.test(value.revision)
  )
    throw new Error("规则格式无效");
  if (
    value.length &&
    (!Number.isInteger(value.length.min) ||
      !Number.isInteger(value.length.max) ||
      value.length.min < 1 ||
      value.length.max < value.length.min ||
      value.length.max > 100)
  )
    throw new Error("词长范围无效");
  for (const list of [value.allowedPos, value.allowedFamiliarity, value.excludedLexemes])
    if (
      list !== null &&
      (!Array.isArray(list) ||
        list.length > 500 ||
        list.some((x) => typeof x !== "string" || x.length > 100))
    )
      throw new Error("规则列表无效");
  return value;
}
