import test from "node:test";
import assert from "node:assert/strict";
import { readableOrigins, sitePattern } from "../lib/site-access.ts";
import {
  defaultFloatingPreferences,
  floatingPlacement,
  floatingPosition,
  floatingProjection,
  parseFloatingPreferences,
} from "../lib/floating-preferences.ts";

test("可选授权按网站而非端口，受限页不产生注入规则", () => {
  assert.equal(sitePattern("http://127.0.0.1:4185/a?secret=1"), "http://127.0.0.1/*");
  assert.equal(sitePattern("https://example.com:8443/path"), "https://example.com/*");
  for (const url of [
    undefined,
    "chrome://extensions",
    "file:///tmp/a",
    "javascript:alert(1)",
    "https://chromewebstore.google.com/detail/test",
    "https://chrome.google.com/webstore/detail/test",
  ])
    assert.equal(sitePattern(url), null);
  assert.deepEqual(
    readableOrigins(["https://*/*", "https://*/*", "file:///*", "http://a.test/*"]),
    ["http://a.test/*", "https://*/*"],
  );
});
test("浮球比例位置跨窗口尺寸保持同一侧；异常偏好不能泄露其他站点", () => {
  const prefs = parseFloatingPreferences({
    locked: true,
    side: "left",
    verticalRatio: 0.5,
    hiddenOrigins: [
      "https://private.test",
      "https://private.test",
      "bad",
      "https://a.test/path",
    ],
  });
  assert.deepEqual(prefs.hiddenOrigins, ["https://private.test"]);
  const publicValue = floatingProjection(prefs, "https://public.test");
  assert.equal(publicValue.enabled, true);
  assert.equal("hiddenOrigins" in publicValue, false);
  assert.equal(floatingProjection(prefs, "https://private.test").enabled, false);
  const point = floatingPosition(publicValue, { width: 1280, height: 900 });
  assert.equal(point.left, 12);
  assert.equal(point.top, 427);
  assert.deepEqual(floatingPlacement(point, { width: 1280, height: 900 }), {
    side: "left",
    verticalRatio: 0.5,
  });
  assert.deepEqual(parseFloatingPreferences(null), defaultFloatingPreferences());
  assert.equal(parseFloatingPreferences({ verticalRatio: Infinity }).verticalRatio, 0.72);
});
