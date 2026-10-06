import test from "node:test";
import assert from "node:assert/strict";
import { initialFsrs, reviewFsrs, FSRS_ALGORITHM } from "../lib/fsrs.ts";
import { recallProbability } from "../lib/fsrs-memory.ts";
import { projectFsrs } from "../lib/learning-repository.ts";
import type { ReviewFact, ReviewRating } from "../lib/local-model.ts";

const at = "2026-10-01T08:00:00.000Z";
const fact = (id: string, rating: ReviewRating, logicalClock: number): ReviewFact => ({
  id,
  wordId: "word",
  rating,
  createdAt: at,
  undoneAt: null,
  logicalClock,
  algorithmVersion: FSRS_ALGORITHM,
});

test("同一时刻按逻辑时钟重放，撤销恢复前一轮，不改写输入事实", () => {
  const first = fact("z-first", "again", 1);
  const second = fact("a-second", "hard", 2);
  const rows = [second, first];
  const before = structuredClone(rows);
  const initial = initialFsrs(at);
  const expected = reviewFsrs(reviewFsrs(initial, "again", at), "hard", at);
  assert.deepEqual(projectFsrs(at, rows), expected);
  assert.deepEqual(rows, before);
  assert.deepEqual(
    projectFsrs(at, [{ ...second, undoneAt: at }, first]),
    reviewFsrs(initial, "again", at),
  );
  assert.deepEqual(
    projectFsrs(
      at,
      rows.map((row) => ({ ...row, undoneAt: at })),
    ),
    initial,
  );
});

test("完整经过天数采用24小时边界，分钟差与刚过午夜仍使用短期记忆", () => {
  const initial = reviewFsrs(initialFsrs(at), "again", at);
  const lessThanDay = reviewFsrs(initial, "hard", "2026-10-02T07:59:59.999Z");
  const sameInstant = reviewFsrs(initial, "hard", at);
  const fullDay = reviewFsrs(initial, "hard", "2026-10-02T08:00:00.000Z");
  assert.equal(lessThanDay.stability, sameInstant.stability);
  assert.notEqual(fullDay.stability, sameInstant.stability);
  assert.equal(lessThanDay.dueAt, "2026-10-02T08:05:29.999Z");
});

test("再学 Hard 延后15分钟，长期间隔封顶且不强制 Good 大于 Hard", () => {
  const initial = reviewFsrs(initialFsrs(at), "easy", at);
  const again = reviewFsrs(initial, "again", "2026-10-17T08:00:00.000Z");
  const hard = reviewFsrs(again, "hard", again.lastReviewAt!);
  assert.equal(hard.state, "relearning");
  assert.equal(Date.parse(hard.dueAt) - Date.parse(hard.lastReviewAt!), 900_000);
  const shortMemory = { ...initial, stability: 0.1 };
  const goodOnSameDay = reviewFsrs(shortMemory, "good", at);
  const hardOnSameDay = reviewFsrs(shortMemory, "hard", at);
  assert.equal(goodOnSameDay.dueAt, hardOnSameDay.dueAt); // 无 SDK 强制 Good > Hard 的间隔补正。
  const large = { ...initial, stability: 100_000 };
  const next = reviewFsrs(large, "good", at);
  assert.equal(Date.parse(next.dueAt) - Date.parse(at), 36_500 * 86_400_000);
  assert.ok(Math.abs(recallProbability(5, 5) - 0.9) < 1e-14);
});

test("未知算法、逆序时间和损坏记忆明确拒绝", () => {
  assert.throws(
    () => projectFsrs(at, [{ ...fact("old", "good", 1), algorithmVersion: "unknown" }]),
    /未知算法/,
  );
  const initial = reviewFsrs(initialFsrs(at), "good", at);
  assert.throws(() => reviewFsrs(initial, "good", "2026-10-01T07:59:59Z"), /早于/);
  assert.throws(
    () => reviewFsrs({ ...initial, lastReviewAt: "invalid" }, "good", at),
    /早于/,
  );
  assert.throws(() => reviewFsrs({ ...initial, stability: NaN }, "good", at), /状态无效/);
  assert.throws(
    () => reviewFsrs({ ...initial, difficulty: null }, "good", at),
    /状态无效/,
  );
  assert.throws(() => reviewFsrs({ ...initial, round: NaN }, "good", at), /状态无效/);
  assert.throws(() => reviewFsrs(initial, "invalid" as ReviewRating, at), /未知学习反馈/);
});
