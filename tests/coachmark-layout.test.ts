import test from "node:test";
import assert from "node:assert/strict";
import { coachmarkLayout } from "../lib/coachmark-layout.ts";
test("批注窄侧栏/边缘按钮不溢出，也不覆盖控件", () => {
  for (const viewport of [
    { width: 320, height: 600 },
    { width: 1440, height: 900 },
  ]) {
    for (const y of [15, 260, viewport.height - 50]) {
      const target = { x: viewport.width - 54, y, width: 32, height: 32 };
      const p = coachmarkLayout(target, viewport, { width: 304, height: 185 });
      assert.ok(p.box.x >= 0 && p.box.y >= 0);
      assert.ok(p.box.x + p.box.width <= viewport.width);
      assert.ok(p.box.y + p.box.height <= viewport.height);
      assert.ok(
        p.box.y + p.box.height <= target.y ||
          p.box.y >= target.y + target.height ||
          p.box.x + p.box.width <= target.x ||
          p.box.x >= target.x + target.width,
      );
      assert.ok(p.to.x >= target.x && p.to.x <= target.x + target.width);
      assert.ok(p.to.y >= target.y && p.to.y <= target.y + target.height);
    }
  }
});

test("悬浮球的批注避开已展开菜单，箭头仍落在球上", () => {
  const ball = { x: 1044, y: 646, width: 46, height: 46 };
  const menu = { x: 818, y: 589, width: 200, height: 130 };
  const p = coachmarkLayout(
    ball,
    { width: 1110, height: 865 },
    { width: 282, height: 166 },
    [menu],
  );
  for (const r of [ball, menu]) {
    assert.ok(
      p.box.x + p.box.width <= r.x ||
        p.box.x >= r.x + r.width ||
        p.box.y + p.box.height <= r.y ||
        p.box.y >= r.y + r.height,
    );
  }
  assert.ok(p.to.x >= ball.x && p.to.x <= ball.x + ball.width);
  assert.ok(p.to.y >= ball.y && p.to.y <= ball.y + ball.height);
});

test("移动批注后连线跟随目标，缩窗时窗口仍在可见范围", () => {
  const target = { x: 40, y: 30, width: 80, height: 36 };
  const moved = coachmarkLayout(
    target,
    { width: 1440, height: 900 },
    { width: 304, height: 180 },
    [],
    { x: 760, y: 470 },
  );
  assert.equal(moved.box.x, 760);
  assert.equal(moved.box.y, 470);
  assert.ok(moved.to.x >= target.x && moved.to.x <= target.x + target.width);
  assert.ok(moved.to.y >= target.y && moved.to.y <= target.y + target.height);
  const narrow = coachmarkLayout(
    target,
    { width: 320, height: 460 },
    { width: 304, height: 180 },
    [],
    { x: 760, y: 470 },
  );
  assert.ok(narrow.box.x >= 12 && narrow.box.y >= 12);
  assert.ok(narrow.box.x + narrow.box.width <= 308);
  assert.ok(narrow.box.y + narrow.box.height <= 448);
});
