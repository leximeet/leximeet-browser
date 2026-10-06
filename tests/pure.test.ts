import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  defaultRules,
  classifyCandidate,
  normalize,
  rangesFor,
  sanitizeUrl,
  tokenize,
  validateItem,
  validateRules,
  encounterWord,
  publicWord,
} from "../lib/pure.ts";
import { trustedSender, contentSender } from "../lib/security.ts";
const captures = JSON.parse(
  readFileSync(new URL("./fixtures/captures.json", import.meta.url), "utf8"),
);
const rules = JSON.parse(
  readFileSync(new URL("./fixtures/rules.json", import.meta.url), "utf8"),
);
for (const entry of captures.cases)
  test(`共享 capture fixture：${entry.name}`, () =>
    assert.equal(validateItem(entry.item), entry.expectedIssues.length === 0));
for (const entry of captures.urlCases)
  test(`来源脱敏：${entry.input}`, () =>
    assert.equal(sanitizeUrl(entry.input), entry.expected));
for (const entry of rules.evaluations)
  test(`共享规则候选：${entry.name}`, () => {
    const c = entry.candidate;
    const status = c.familiarity === "uncollected" ? undefined : c.familiarity;
    assert.equal(
      classifyCandidate(c.word, status, c.possiblePos, entry.rules).status,
      entry.expectedStatus,
    );
  });
test("UTF-16 下重复单词各自保留偏移，摘录从头独立计算", () => {
  assert.deepEqual(rangesFor("📚 book, then book.", "book"), [
    { start: 3, end: 7 },
    { start: 14, end: 18 },
  ]);
  assert.deepEqual(
    tokenize("We re-use a BOOK.").map((x) => [x.normalized, x.start]),
    [
      ["we", 0],
      ["re-use", 3],
      ["a", 10],
      ["book", 12],
    ],
  );
});
test("规则保持 null 中性，不接受倒置长度或其他 schema", () => {
  assert.equal(validateRules(defaultRules()).allowedPos, null);
  assert.throws(() => validateRules({ ...defaultRules(), length: { min: 10, max: 3 } }));
  assert.throws(() => validateRules({ ...defaultRules(), schemaVersion: 2 } as any));
  assert.equal(normalize("ＢＯＯＫ"), "book");
});
test("可信扩展页与 content script 的权限不能互换", () => {
  const id = "a".repeat(32);
  assert.equal(
    trustedSender({ id, url: `chrome-extension://${id}/sidepanel.html` }, id),
    true,
  );
  for (const url of [
    "https://example.org",
    `chrome-extension://${id}/sidepanel.html.evil`,
    `chrome-extension://${"b".repeat(32)}/options.html`,
  ])
    assert.equal(trustedSender({ id, url }, id), false);
  assert.equal(
    contentSender(
      {
        id,
        url: "https://example.org",
        tab: { id: 1 },
        frameId: 0,
        documentId: "doc",
      },
      id,
    ),
    true,
  );
  assert.equal(
    contentSender(
      {
        id,
        url: "https://example.org",
        tab: { id: 1 },
        frameId: 2,
        documentId: "doc",
      },
      id,
    ),
    false,
  );
});

test("遇见遵守当前 120 字词头，采集和公共字典不放宽 100 字上限", () => {
  assert.equal(encounterWord("a".repeat(120)), true);
  assert.equal(encounterWord("a".repeat(121)), false);
  assert.equal(publicWord("a".repeat(100)), true);
  assert.equal(publicWord("a".repeat(101)), false);
  assert.equal(encounterWord("a b"), false);
});

test("内置教学只开放自己的阅读文档，不继承管理页私有权限", () => {
  const id = "a".repeat(32);
  const sender = {
    id,
    url: `chrome-extension://${id}/tutorial.html`,
    tab: { id: 1 },
    frameId: 0,
    documentId: "actual-document",
  };
  assert.equal(contentSender(sender, id), true);
  assert.equal(trustedSender(sender, id), false);
  for (const url of [
    `chrome-extension://${"b".repeat(32)}/tutorial.html`,
    `chrome-extension://${id}/tutorial.html?other=1`,
    `chrome-extension://${id}/options.html`,
    `chrome-extension://${id}/tutorial.html.evil`,
    "chrome://extensions/",
  ])
    assert.equal(contentSender({ ...sender, url }, id), false);
  assert.equal(contentSender({ ...sender, documentId: "" }, id), false);
  assert.equal(contentSender({ ...sender, frameId: 1 }, id), false);
  assert.equal(sanitizeUrl("leximeet://tutorial/reading"), "leximeet://tutorial/reading");
  assert.equal(sanitizeUrl("leximeet://tutorial/reading?token=secret"), "");
});
