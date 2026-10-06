// 与 Desktop Core 共用的采集边界：安全文本先于持久化，UTF-16 位置始终指向真实所选词。
export type CapturePolicy = {
  duplicateWindowDays: number;
  sensitiveRedactionEnabled: boolean;
  contextMaxLength: number;
};
export type CaptureRange = { start: number; end: number };
export const defaultCapturePolicy = (): CapturePolicy => ({
  duplicateWindowDays: 7,
  sensitiveRedactionEnabled: true,
  contextMaxLength: 500,
});
export function validCapturePolicy(value: unknown): value is CapturePolicy {
  const p = value as CapturePolicy;
  return (
    !!p &&
    typeof p === "object" &&
    !Array.isArray(p) &&
    Object.keys(p).every((k) =>
      ["duplicateWindowDays", "sensitiveRedactionEnabled", "contextMaxLength"].includes(
        k,
      ),
    ) &&
    Number.isInteger(p.duplicateWindowDays) &&
    p.duplicateWindowDays >= 0 &&
    p.duplicateWindowDays <= 365 &&
    typeof p.sensitiveRedactionEnabled === "boolean" &&
    Number.isInteger(p.contextMaxLength) &&
    p.contextMaxLength >= 120 &&
    p.contextMaxLength <= 2000
  );
}
const patterns = [
  /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![A-Za-z0-9_-])/gi,
  /(?<![0-9])((?:\+?86[- ]?)?1[3-9][0-9]{9})(?![0-9])/g,
  /(?<![0-9])((?:\+?[0-9]{1,3}[- ])?(?:\([0-9]{2,4}\)[- ]?|[0-9]{2,4}[- ])[0-9]{3,4}[- ][0-9]{3,4})(?![0-9])/g,
  /(?<![0-9])([0-9]{17}[0-9Xx])(?![0-9])/g,
  /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])/g,
  /\b(?:password|passwd|pwd|token|api[_-]?key|secret|authorization)[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*[:=][\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*["']?([^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000"',;&]+)/gi,
  /\bBearer[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+([A-Za-z0-9._~+/-]+=*)/gi,
  /\b((?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{16,})\b/g,
];
function luhn(value: string): boolean {
  const digits = value.replace(/[ -]/g, "");
  let sum = 0,
    twice = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (twice) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    twice = !twice;
  }
  return sum % 10 === 0;
}
function sensitiveSpans(text: string): CaptureRange[] {
  const spans: CaptureRange[] = [];
  for (const p of [...patterns, /(?<![0-9])([0-9](?:[ -]?[0-9]){12,18})(?![0-9])/g]) {
    for (const m of text.matchAll(new RegExp(p.source, p.flags + "d"))) {
      if (p === patterns.at(-1) || patterns.includes(p) || luhn(m[1]!)) {
        const start = m.indices![1]![0];
        let end = start + m[1]!.length;
        // 敏感值可含内部点号；保留句末标点，避免脱敏后把下一句拼入语境。
        if (patterns.includes(p)) while (end > start && boundary(text, end - 1)) end--;
        if (end > start) spans.push({ start, end });
      }
    }
  }
  const merged: CaptureRange[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end)
      previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}
function replace(text: string, spans: CaptureRange[]): string {
  let safe = "",
    from = 0;
  for (const span of spans) {
    safe += text.slice(from, span.start) + "xxx";
    from = span.end;
  }
  return safe + text.slice(from);
}
export const redactSensitive = (text: string): string =>
  replace(text, sensitiveSpans(text));
// Java (?U)\\s / strip 的 Unicode 空白集合；不将 JS 额外包含的 BOM 当空白。
const unicodeSpace =
  /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
// 比较键忽略大小写和多余空白；展示原句及 UTF-16 范围始终原样保留。
export const captureContextKey = (text: string): string =>
  text
    .normalize("NFC")
    .replace(unicodeSpace, " ")
    .replace(/^ +| +$/g, "")
    .toLowerCase();
const whitespace = (c: string) =>
  /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(
    c,
  );
function boundary(text: string, i: number): boolean {
  const c = text[i]!;
  if ("。！？\n\r".includes(c)) return true;
  return (
    ".!?".includes(c) &&
    (i + 1 === text.length ||
      whitespace(text[i + 1]!) ||
      `"'”’)]}`.includes(text[i + 1]!))
  );
}
const lowSurrogate = (text: string, i: number) =>
  text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff;
function validateRanges(text: string, surface: string, ranges: CaptureRange[]) {
  let previous = 0;
  if (
    !ranges.length ||
    ranges.some((r) => {
      const invalid =
        !Number.isInteger(r.start) ||
        !Number.isInteger(r.end) ||
        r.start < previous ||
        r.end > text.length ||
        r.end <= r.start ||
        text.slice(r.start, r.end) !== surface ||
        (r.start > 0 && lowSurrogate(text, r.start)) ||
        (r.end < text.length && lowSurrogate(text, r.end));
      previous = r.end;
      return invalid;
    })
  )
    throw new Error("原句或摘录没有精确包含所选词");
}
export function safeCaptureSegment(
  input: string,
  surface: string,
  ranges: CaptureRange[],
  policy: CapturePolicy,
): { text: string; ranges: CaptureRange[] } {
  validateRanges(input, surface, ranges);
  const spans = policy.sensitiveRedactionEnabled ? sensitiveSpans(input) : [];
  if (ranges.some((r) => spans.some((s) => r.start < s.end && r.end > s.start))) {
    const error = new Error("选中的单词属于敏感内容，已阻止采集");
    Object.assign(error, { code: "SENSITIVE_SELECTION" });
    throw error;
  }
  const text = replace(input, spans),
    map = (i: number) =>
      i + spans.filter((s) => s.end <= i).reduce((d, s) => d + 3 - (s.end - s.start), 0);
  const mapped = ranges.map((r) => ({ start: map(r.start), end: map(r.end) })),
    focus = mapped[0]!;
  let start = focus.start,
    end = focus.end;
  while (start > 0 && !boundary(text, start - 1)) start--;
  while (end < text.length && !boundary(text, end)) end++;
  if (end < text.length && !whitespace(text[end]!)) end++;
  while (start < focus.start && whitespace(text[start]!)) start++;
  while (end > focus.end && whitespace(text[end - 1]!)) end--;
  if (end - start > policy.contextMaxLength) {
    let left = Math.max(
      start,
      focus.start - Math.floor((policy.contextMaxLength - (focus.end - focus.start)) / 2),
    );
    left = Math.min(left, end - policy.contextMaxLength);
    let right = Math.min(end, left + policy.contextMaxLength);
    if (left > 0 && lowSurrogate(text, left)) left++;
    if (right < text.length && lowSurrogate(text, right)) right--;
    start = left;
    end = right;
  }
  const clipped = mapped
      .filter((r) => r.start >= start && r.end <= end)
      .map((r) => ({ start: r.start - start, end: r.end - start })),
    safe = text.slice(start, end);
  validateRanges(safe, surface, clipped);
  return { text: safe, ranges: clipped };
}
export function prepareSafeCapture<
  T extends {
    surface: string;
    originalSentence: string;
    savedExcerpt: string;
    occurrenceRanges: CaptureRange[];
    excerptRanges: CaptureRange[];
    annotation: { note: string };
    source: { title: string; url: string | null };
  },
>(input: T, policy: CapturePolicy): T {
  if (!validCapturePolicy(policy)) throw new Error("采集设置格式无效");
  const sentence = safeCaptureSegment(
      input.originalSentence,
      input.surface,
      input.occurrenceRanges,
      policy,
    ),
    excerpt = safeCaptureSegment(
      input.savedExcerpt,
      input.surface,
      input.excerptRanges,
      policy,
    );
  return {
    ...input,
    originalSentence: sentence.text,
    savedExcerpt: excerpt.text,
    occurrenceRanges: sentence.ranges,
    excerptRanges: excerpt.ranges,
    annotation: {
      note: policy.sensitiveRedactionEnabled
        ? redactSensitive(input.annotation.note)
        : input.annotation.note,
    },
    source: {
      ...input.source,
      title: policy.sensitiveRedactionEnabled
        ? redactSensitive(input.source.title)
        : input.source.title,
      url:
        input.source.url === null
          ? null
          : policy.sensitiveRedactionEnabled
            ? redactSensitive(input.source.url)
            : input.source.url,
    },
  };
}

// 原请求只留下稳定指纹；对象键序不改变同一采集意图，文本/本关联仍参与冲突校验。
export function capturePayloadKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(capturePayloadKey).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${capturePayloadKey((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
