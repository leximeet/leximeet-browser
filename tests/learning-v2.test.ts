import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectLearning, nextLearningDay, type LearningEvent } from "../lib/learning.ts";
import { initialFsrs, reviewFsrs, type FsrsMemory } from "../lib/fsrs.ts";
import type { ReviewRating } from "../lib/local-model.ts";
const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/learning-rule-v2-vectors.json", import.meta.url),
    "utf8",
  ),
);
for (const c of vectors.cases)
  test("Core 学习规则向量：" + c.name, () => {
    const events: LearningEvent[] = c.events.map((f: any, i: number) => ({
      id: f.id,
      submissionId: f.id,
      attemptId: f.attempt_id,
      wordId: "word",
      entryId: "entry",
      mode: f.mode,
      signal: f.signal,
      correct: f.correct,
      assisted: f.assisted,
      createdAt: f.created_at,
      studyDay: f.created_at.slice(0, 10),
      zone: f.zone,
      ruleVersion: f.rule_version,
      deviceId: "device",
      deviceSeq: i + 1,
      logicalClock: i + 1,
      origin: "practice",
      evidence: { expected: "word" },
      reviewCompleted: false,
      undoneAt: f.undone_at ?? null,
    }));
    const actual = projectLearning(events, new Date(c.asOf));
    for (const [key, expected] of Object.entries(c.expected)) {
      const mapping: Record<string, string> = {
        graduated_at: "graduatedAt",
        graduated_day: "graduatedDay",
        review_eligible_at: "reviewEligibleAt",
        first_recall_due_at: "firstRecallDueAt",
        mastery_cycle_at: "masteryCycleAt",
        next_decay_at: "nextDecayAt",
        needs_reinforcement: "needsReinforcement",
        unfamiliar_word: "unfamiliarWord",
        last_effective: "lastEffective",
        last_delta: "lastDelta",
      };
      const value = (actual as any)[mapping[key] ?? key];
      if (typeof expected === "string" && /T.*Z$/.test(expected))
        assert.equal(Date.parse(value), Date.parse(expected), key);
      else assert.deepEqual(value, expected, key);
    }
  });
const golden = JSON.parse(
  readFileSync(new URL("./fixtures/fsrs-golden.json", import.meta.url), "utf8"),
);
for (const c of golden.vectors)
  test("跨端 FSRS 黄金向量：" + c.name, () => {
    let state: FsrsMemory = { ...initialFsrs(c.initialDueAt), ...c.initial };
    for (const f of c.events) {
      state = reviewFsrs(state, f.rating as ReviewRating, f.occurredAt);
      for (const [key, expected] of Object.entries(f.expected)) {
        const value = (state as any)[key];
        if (typeof expected === "number")
          assert.ok(
            Math.abs(value - expected) <= golden.numericTolerance,
            `${key}: ${value} != ${expected}`,
          );
        else assert.deepEqual(value, expected, key);
      }
    }
  });
test("自然日零点覆盖夏令时与非整点时区", () => {
  assert.equal(
    nextLearningDay("2026-03-08T06:30:00Z", "America/New_York"),
    "2026-03-09T04:00:00.000Z",
  );
  assert.equal(
    nextLearningDay("2026-10-02T06:30:00Z", "Asia/Kathmandu"),
    "2026-10-02T18:15:00.000Z",
  );
});

test("重复次数支持桌面相同1–10范围，旧检查点仍可恢复，越界设置拒绝", async () => {
  const { defaultWorkspacePreferences, validWorkspacePreferences } = await import(
    "../lib/workspace-model.ts"
  );
  const { createPracticeSession, validPracticeSession } = await import(
    "../lib/practice-session.ts"
  );
  const prefs = defaultWorkspacePreferences();
  prefs.practice.repeat = 10;
  assert.equal(validWorkspacePreferences(prefs), true);
  assert.equal(
    validPracticeSession(
      createPracticeSession(["resilient"], "library", "copy", prefs.practice),
    ),
    true,
  );
  prefs.practice.repeat = 11;
  assert.equal(validWorkspacePreferences(prefs), false);
});
