import test from "node:test";
import assert from "node:assert/strict";
import { locationChanged, pageLocationKey } from "../lib/page-navigation.ts";

test("软导航把 path、query、hash 视为换页，忽略用户名密码", () => {
  assert.equal(
    pageLocationKey("https://user:secret@example.test/a?x=1#h"),
    "https://example.test/a?x=1#h",
  );
  assert.equal(
    locationChanged("https://example.test/article", "https://example.test/article/next"),
    true,
  );
  assert.equal(
    locationChanged("https://example.test/a", "https://example.test/a?tab=2"),
    true,
  );
  assert.equal(
    locationChanged("https://example.test/a", "https://example.test/a#ch2"),
    true,
  );
  assert.equal(
    locationChanged("https://example.test/a", "https://example.test/a"),
    false,
  );
  assert.equal(pageLocationKey("javascript:alert(1)"), "");
});
