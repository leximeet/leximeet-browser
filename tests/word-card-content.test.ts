import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_PRESETS,
  cardSettingsDraft,
  lexicalText,
  readableCardSections,
} from "../lib/word-card-content.ts";

test("完整词卡保留阅读信息，自定义字段不展示原始资源 JSON", () => {
  const complete = readableCardSections({ level: "complete", sections: [] });
  for (const field of [
    "senses",
    "examples",
    "memory",
    "articles",
    "lexical",
    "collections",
    "sources",
  ])
    assert.ok(complete.includes(field as any));
  assert.equal(complete.includes("raw"), false);
  assert.deepEqual(
    readableCardSections({ level: "custom", sections: ["raw", "senses", "personal"] }),
    ["senses", "personal"],
  );
  assert.deepEqual(
    readableCardSections({ level: "minimal", sections: ["raw"] }),
    CARD_PRESETS.minimal,
  );
});
test("完整字段确认从全选草稿开始，自定义继承已有字段且不修改正式偏好", () => {
  const current = { level: "custom" as const, sections: ["senses", "personal"] as const };
  const saved = { ...current, sections: [...current.sections] };
  const complete = cardSettingsDraft(saved, "complete");
  assert.equal(complete.level, "complete");
  assert.deepEqual(complete.sections, CARD_PRESETS.complete);
  complete.sections.splice(0, 1);
  assert.deepEqual(saved, { level: "custom", sections: ["senses", "personal"] });
  assert.deepEqual(cardSettingsDraft(saved, "custom"), saved);
  assert.deepEqual(cardSettingsDraft(saved), saved);
  assert.deepEqual(
    CARD_PRESETS.complete,
    readableCardSections({ level: "complete", sections: [] }),
  );
});
test("词汇关系只读可理解的词形与释义，不回显内部载荷", () => {
  assert.equal(lexicalText("break down"), "break down");
  assert.equal(
    lexicalText({
      headword: "depend",
      translation: "依赖",
      source_payload: { token: "secret" },
      entry_id: "private-id",
    }),
    "depend · 依赖",
  );
  for (const value of [{ entry_id: "internal" }, null, 42, ["raw"]])
    assert.equal(lexicalText(value), "");
});
