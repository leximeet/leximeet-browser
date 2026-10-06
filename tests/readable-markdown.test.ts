import test from "node:test";
import assert from "node:assert/strict";
import { readableMarkdown, readableInline } from "../lib/readable-markdown.ts";
test("词典 Markdown 转换为标题、有序列表和段落，不把源标记当正文", () => {
  const blocks = readableMarkdown(
    "### 词根分析\n\n**govern** 表示管理。\n\n1. 政府\n2. 管理\n\n```js\n<script>alert(1)</script>\n```",
  );
  assert.deepEqual(
    blocks.map((x) => x.tag),
    ["h4", "p", "ol", "pre"],
  );
  assert.deepEqual(blocks[2]?.items, ["政府", "管理"]);
  assert.deepEqual(readableInline(blocks[1]!.text!), [
    { kind: "strong", text: "govern" },
    { kind: "text", text: " 表示管理。" },
  ]);
});
test("词卡富文本保留恶意HTML为文字，不产生脚本、图片或非HTTP链接节点", () => {
  const text = "<img src=x onerror=alert(1)> [执行](javascript:alert(1)) **安全**";
  const nodes = readableInline(text);
  assert.equal(
    nodes.some((x) => x.kind === "link"),
    false,
  );
  assert.ok(
    nodes
      .filter((x) => x.kind === "text")
      .map((x) => x.text)
      .join("")
      .includes("<img src=x"),
  );
  assert.deepEqual(readableInline("[资料](https://example.test/a)"), [
    { kind: "link", text: "资料", href: "https://example.test/a" },
  ]);
});
