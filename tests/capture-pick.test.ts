import test from "node:test";
import assert from "node:assert/strict";
import { pickedWord } from "../lib/capture-pick.ts";
const sample = {
  id: "occurrence",
  surface: "resilient",
  sentence: "📚 A resilient reader returns.",
  start: 5,
};
test("点词校验保留 UTF-16 原句位置并拒绝截词、空词和超预算内容", () => {
  assert.deepEqual(pickedWord(sample), sample);
  for (const bad of [
    { ...sample, start: 4 },
    { ...sample, surface: "resil" },
    { ...sample, surface: "" },
    { ...sample, start: NaN },
    { ...sample, id: "" },
    { ...sample, sentence: "a".repeat(4001) },
    { ...sample, surface: "<script>" },
  ])
    assert.throws(() => pickedWord(bad), /原句位置/);
});
test("点词支持连字符、撇号和明确点击的非词典词，不接受无完整 token 的语境", () => {
  const sentence = "A resilient-reader doesn't use LexiMeetSecret.";
  for (const [surface, start] of [
    ["resilient-reader", 2],
    ["doesn't", 19],
    ["LexiMeetSecret", 31],
  ] as const)
    assert.equal(pickedWord({ id: surface, surface, sentence, start }).surface, surface);
  assert.throws(() => pickedWord({ id: "bad", surface: "reader", sentence, start: 12 }));
});
