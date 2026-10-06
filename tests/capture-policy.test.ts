import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LocalLibrary } from "../lib/local-database.ts";
import {
  captureContextKey,
  safeCaptureSegment,
  defaultCapturePolicy,
  prepareSafeCapture,
} from "../lib/capture-policy.ts";
import { validCaptureReceipt } from "../lib/connector/capture-receipt.ts";
import type { CaptureInput } from "../lib/local-model.ts";
const vectors = JSON.parse(
  readFileSync(new URL("fixtures/capture-policy-v1.json", import.meta.url), "utf8"),
);
test("与 Core 共享的安全语境向量：UTF-16/敏感目标/Unicode空白与大小写查重键", () => {
  for (const v of vectors.segments) {
    if (v.error)
      assert.throws(
        () => safeCaptureSegment(v.input, v.surface, v.ranges, v.policy),
        (e: any) => e.code === v.error,
        v.id,
      );
    else
      assert.deepEqual(
        safeCaptureSegment(v.input, v.surface, v.ranges, v.policy),
        v.expected,
        v.id,
      );
  }
  for (const v of vectors.contextKeys)
    assert.equal(captureContextKey(v.input), v.expected);
});
test("七天同词同句忽略大小写；不同句子保留，原句和选词范围不被比较键改写", async () => {
  const now = new Date("2026-10-04T00:00:00Z");
  const db = new LocalLibrary("capture-case-" + crypto.randomUUID(), () => now);
  const original = input(now, "The alpha system works.");
  const first = await db.capture(original);
  const repeat = await db.capture(input(now, "the alpha SYSTEM works."));
  assert.equal(repeat.captureStatus, "duplicate-context");
  assert.equal(repeat.encounterId, first.encounterId);
  const different = await db.capture(input(now, "The alpha system helps readers."));
  assert.equal(different.captureStatus, "created");
  const encounters = await db.encounters();
  assert.equal(encounters.length, 2);
  const saved = encounters.find((e) => e.id === first.encounterId)!;
  assert.equal(saved.savedExcerpt, "The alpha system works.");
  assert.deepEqual(saved.excerptRanges, original.excerptRanges);
  assert.equal((await db.listWords()).length, 1);
});
function input(
  now: Date,
  sentence = "Email me@example.com about alpha on 13800138000.",
): CaptureInput {
  const start = sentence.indexOf("alpha");
  return {
    eventId: crypto.randomUUID(),
    surface: "alpha",
    originalSentence: sentence,
    savedExcerpt: sentence,
    occurrenceRanges: [{ start, end: start + 5 }],
    excerptRanges: [{ start, end: start + 5 }],
    annotation: { note: "token=longSecret123" },
    source: { title: "阅读", url: "https://example.test/read" },
    occurredAt: now.toISOString(),
    timeZone: "UTC",
    dictionary: {
      meaning: "字母",
      phonetic: "",
      word: "alpha",
      entryId: "alpha-public",
    },
  };
}
test("默认滚动7天跨来源查重：边界包含，超界新增；同事件回放保留原政策且冲突不写资料", async () => {
  let now = new Date("2026-10-01T00:00:00Z");
  const db = new LocalLibrary("capture-seven-" + crypto.randomUUID(), () => now);
  assert.deepEqual(await db.capturePolicy(), defaultCapturePolicy());
  const original = input(now),
    first = await db.capture(original);
  assert.equal(first.captureStatus, "created");
  assert.equal((await db.encounters())[0]?.savedExcerpt, "Email xxx about alpha on xxx.");
  assert.equal((await db.encounters())[0]?.annotation.note, "token=xxx");
  const wordBefore = await db.word(first.word.id);
  now = new Date("2026-10-08T00:00:00Z");
  const secondInput = {
    ...input(now),
    source: { title: "另一来源", url: "https://other.test/read" },
  };
  const duplicate = await db.capture(secondInput);
  assert.equal(duplicate.captureStatus, "duplicate-context");
  assert.equal(duplicate.encounterId, original.eventId);
  assert.deepEqual(await db.word(first.word.id), wordBefore);
  assert.equal((await db.encounters()).length, 1);
  now = new Date(now.getTime() + 1);
  assert.equal((await db.capture(input(now))).captureStatus, "created");
  assert.equal((await db.encounters()).length, 2);
  await db.updateCapturePolicy({
    duplicateWindowDays: 0,
    sensitiveRedactionEnabled: false,
  });
  const replay = await db.capture(secondInput);
  assert.equal(replay.capturePolicy.duplicateWindowDays, 7);
  assert.equal(replay.captureStatus, "duplicate-context");
  await assert.rejects(
    db.capture({
      ...secondInput,
      annotation: { note: "changed" },
    }),
    /内容不一致/,
  );
  assert.equal((await db.encounters()).length, 2);
  assert.equal((await db.capture(input(now))).captureStatus, "created");
});
test("并发同语境只有一条；敏感所选词、无效设置及封存写入均不产生半条事实", async () => {
  const now = new Date(),
    db = new LocalLibrary("capture-race-" + crypto.randomUUID(), () => now);
  const results = await Promise.all([db.capture(input(now)), db.capture(input(now))]);
  assert.deepEqual(results.map((r) => r.captureStatus).sort(), [
    "created",
    "duplicate-context",
  ]);
  assert.equal((await db.encounters()).length, 1);
  const sensitive = input(now, "password=alpha token=secretvalue.");
  await assert.rejects(db.capture(sensitive), /敏感内容/);
  await assert.rejects(db.updateCapturePolicy({ contextMaxLength: 119 }), /允许范围/);
  assert.equal((await db.encounters()).length, 1);
  await db.freezeIndependent();
  await assert.rejects(
    db.updateCapturePolicy({ duplicateWindowDays: 0 }),
    /封存|桌面|归属/,
  );
  await assert.rejects(db.capture(input(now)), /封存|桌面|归属/);
});
test("连接回执只允许明确duplicate-context引用旧遇见，仍校验公共身份及安全句子", () => {
  const raw = input(new Date()),
    word = {
      kind: "dictionary",
      entryId: crypto.randomUUID(),
      release: "0.0.3",
      entrySchema: "leximeet.entry/1",
    };
  const data = {
    ...raw,
    word,
    source: { kind: "web", ...raw.source },
    collectionIntent: "collect",
  } as any;
  const policy = defaultCapturePolicy(),
    safe = prepareSafeCapture(data, policy);
  const params = {
    eventId: raw.eventId,
    mutationId: raw.eventId,
    data,
    notebookId: null,
  };
  const result = {
    entity: {
      entityType: "encounter",
      entityId: raw.eventId,
      revision: "1",
      deletedAt: null,
      data: safe,
    },
    workspaceRevision: "1",
    captureStatus: "created",
    capturePolicy: policy,
  } as any;
  assert.ok(validCaptureReceipt(params, result));
  result.entity.entityId = crypto.randomUUID();
  assert.equal(validCaptureReceipt(params, result), false);
  result.captureStatus = "duplicate-context";
  assert.ok(validCaptureReceipt(params, result));
  const alternateCase = {
    ...params,
    data: {
      ...data,
      surface: "ALPHA",
      originalSentence: data.originalSentence.toUpperCase(),
      savedExcerpt: data.savedExcerpt.toUpperCase(),
    },
  };
  assert.ok(validCaptureReceipt(alternateCase, result));
  result.entity.data.word = { ...word, entryId: crypto.randomUUID() };
  assert.equal(validCaptureReceipt(params, result), false);
  assert.equal(validCaptureReceipt(alternateCase, result), false);
});

test("旧脱敏关闭的注释不写回历史：当前重复回执应安全投影，原WordRef/语境仍不放宽", () => {
  const raw = input(new Date(), "alpha appears."),
    word = { kind: "custom", customId: crypto.randomUUID(), headword: "alpha" };
  const data = {
    ...raw,
    word,
    source: { kind: "web", ...raw.source },
    collectionIntent: "collect",
  } as any;
  const params = {
    eventId: raw.eventId,
    mutationId: raw.eventId,
    data,
    notebookId: null,
  };
  const policy = defaultCapturePolicy();
  const oldData = {
    ...data,
    annotation: { note: "password=oldsecretvalue" },
  };
  const result = {
    entity: {
      entityType: "encounter",
      entityId: crypto.randomUUID(),
      revision: "1",
      deletedAt: null,
      data: oldData,
    },
    workspaceRevision: "1",
    captureStatus: "duplicate-context",
    capturePolicy: policy,
  } as any;
  assert.equal(validCaptureReceipt(params, result), false);
  result.entity.data = prepareSafeCapture(oldData, policy);
  assert.ok(validCaptureReceipt(params, result));
  assert.equal(result.entity.data.annotation.note, "password=xxx");
  assert.equal(oldData.annotation.note, "password=oldsecretvalue");
});
