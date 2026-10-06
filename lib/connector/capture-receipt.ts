import {
  captureContextKey,
  prepareSafeCapture,
  validCapturePolicy,
} from "../capture-policy.ts";
import {
  sameWord,
  type RecordEncounterParams,
  type RecordEncounterResult,
} from "./types.ts";
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
// 查重不是写入失败；只有明确的重复状态允许引用另一条已有遇见。其余身份与安全语境仍严格校验。
export function validCaptureReceipt(
  params: RecordEncounterParams,
  result: RecordEncounterResult,
): boolean {
  try {
    if (!result?.entity?.data || !sameWord(result.entity.data.word, params.data.word))
      return false;
    const actual = result.entity.data;
    const policy = result.capturePolicy;
    if (result.captureStatus && !validCapturePolicy(policy)) return false;
    const expected = policy ? prepareSafeCapture(params.data, policy) : params.data;
    if (result.captureStatus === "duplicate-context") {
      if (!policy) return false;
      const checked = prepareSafeCapture(actual, policy);
      return (
        canonical(checked) === canonical(actual) &&
        captureContextKey(actual.savedExcerpt) ===
          captureContextKey(expected.savedExcerpt)
      );
    }
    if (result.captureStatus !== undefined && result.captureStatus !== "created")
      return false;
    if (result.entity.entityId !== params.eventId) return false;
    return [
      "surface",
      "originalSentence",
      "savedExcerpt",
      "occurrenceRanges",
      "excerptRanges",
      "annotation",
      "source",
      "collectionIntent",
    ].every(
      (key) =>
        canonical(actual[key as keyof typeof actual]) ===
        canonical(expected[key as keyof typeof expected]),
    );
  } catch {
    return false;
  }
}
