import test from "node:test";
import assert from "node:assert/strict";
import { CaptureIntents } from "../page/capture-intents.ts";
import type { LocatedOccurrence } from "../page/document.ts";

function occurrence(node: object, start = 2): LocatedOccurrence {
  return {
    id: crypto.randomUUID(),
    surface: "system",
    normalized: "system",
    sentence: "A system works.",
    start,
    end: start + 6,
    sentenceStart: 0,
    range: {
      startContainer: node,
      endContainer: node,
      startOffset: start,
      endOffset: start + 6,
    } as unknown as Range,
  };
}
test("同一真实词位再次拖动换临时UUID，仍复用原事件与原词位；明确保存后才开始新意图", () => {
  const cache = new CaptureIntents(),
    node = {},
    original = occurrence(node);
  const first = cache.acquire(original),
    again = cache.acquire(occurrence(node));
  assert.strictEqual(again, first);
  assert.strictEqual(again.occurrence, original);
  cache.complete(first);
  assert.notEqual(cache.acquire(occurrence(node)).eventId, first.eventId);
});
test("同句同词不同节点或offset不合并；归属明确切换清意图，迟到回执不能清新归属事件", () => {
  const cache = new CaptureIntents(),
    node = {},
    first = cache.acquire(occurrence(node));
  assert.notEqual(cache.acquire(occurrence({})).eventId, first.eventId);
  assert.notEqual(cache.acquire(occurrence(node, 8)).eventId, first.eventId);
  cache.clear();
  const after = cache.acquire(occurrence(node));
  assert.notEqual(after.eventId, first.eventId);
  cache.complete(first);
  assert.strictEqual(cache.acquire(occurrence(node)), after);
});
