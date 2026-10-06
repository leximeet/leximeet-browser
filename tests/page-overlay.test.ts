import test from "node:test";
import assert from "node:assert/strict";
import {
  BALL_MARGIN,
  BALL_SIZE,
  PAGE_CANDIDATE_LIMIT,
  ballStorageKey,
  canUseSpeechSynthesis,
  defaultBallPosition,
  movedBeyondThreshold,
  overlayKeyboardAction,
  publicCardLines,
  parseBallPosition,
  pointerInPaddedRect,
  snapBallPosition,
} from "../lib/page-overlay.ts";

test("浮球默认落在右下安全区，窄窗、矮窗和 200% 等效视口仍完整可见", () => {
  const wide = defaultBallPosition({ width: 1280, height: 800 });
  assert.equal(wide.left, 1280 - BALL_SIZE - 22);
  assert.equal(wide.top, 800 - BALL_SIZE - 88);
  const narrow = snapBallPosition(0, 0, { width: 320, height: 280 });
  assert.equal(narrow.left, BALL_MARGIN);
  assert.equal(narrow.top, BALL_MARGIN);
  const tall = snapBallPosition(300, 900, { width: 390, height: 200 });
  assert.equal(tall.left, 390 - BALL_SIZE - BALL_MARGIN);
  assert.equal(tall.top, 200 - BALL_SIZE - BALL_MARGIN);
  const zoomed = snapBallPosition(900, 700, { width: 640, height: 400 });
  assert.equal(zoomed.left, 640 - BALL_SIZE - BALL_MARGIN);
  assert.ok(zoomed.left + BALL_SIZE <= 640);
  assert.ok(zoomed.top + BALL_SIZE <= 400);
  assert.equal(PAGE_CANDIDATE_LIMIT, 500);
});

test("拖过阈值才算拖拽；松手吸附较近左右边", () => {
  assert.equal(movedBeyondThreshold(0, 0, 3, 3), false);
  assert.equal(movedBeyondThreshold(0, 0, 6, 0), true);
  const left = snapBallPosition(40, 120, { width: 800, height: 600 });
  const right = snapBallPosition(500, 120, { width: 800, height: 600 });
  assert.equal(left.left, BALL_MARGIN);
  assert.equal(right.left, 800 - BALL_SIZE - BALL_MARGIN);
  assert.equal(left.top, 120);
});

test("站点位置键按 origin 隔离；非法存储值丢弃", () => {
  assert.equal(
    ballStorageKey("https://example.com"),
    "leximeet-ball:https://example.com",
  );
  assert.equal(parseBallPosition({ left: 12, top: 40 })?.top, 40);
  assert.equal(parseBallPosition({ left: "12", top: 40 }), undefined);
  assert.equal(parseBallPosition(null), undefined);
});

test("浮球键盘等价不拦截站点控件；Esc/Enter/方向键/朗读可映射", () => {
  const site = { ballFocused: false, cardVisible: true, siteControl: true };
  assert.equal(overlayKeyboardAction({ key: "Enter" }, site), null);
  assert.equal(overlayKeyboardAction({ key: "s" }, site), null);
  assert.equal(
    overlayKeyboardAction(
      { key: "Escape" },
      { ballFocused: false, cardVisible: true, siteControl: false },
    ),
    "hide",
  );
  assert.equal(
    overlayKeyboardAction(
      { key: "Enter" },
      { ballFocused: true, cardVisible: false, siteControl: false },
    ),
    "analyze",
  );
  assert.equal(
    overlayKeyboardAction(
      { key: "F10", shiftKey: true },
      { ballFocused: true, cardVisible: false, siteControl: false },
    ),
    "sidebar",
  );
  assert.equal(
    overlayKeyboardAction(
      { key: "ArrowLeft" },
      { ballFocused: true, cardVisible: false, siteControl: false },
    ),
    "snap-left",
  );
  assert.equal(
    overlayKeyboardAction(
      { key: "s" },
      { ballFocused: false, cardFocused: false, cardVisible: true, siteControl: false },
    ),
    null,
  );
  assert.equal(
    overlayKeyboardAction(
      { key: "s" },
      { ballFocused: false, cardFocused: true, cardVisible: true, siteControl: false },
    ),
    "speak",
  );
});

test("网页公共卡不接收私人笔记字段", () => {
  const lines = publicCardLines(
    { phonetic: "/a/", meaning: "公开释义" },
    "apple",
    "An apple.",
  );
  assert.equal(lines.notice.includes("侧栏"), true);
  assert.equal(JSON.stringify(lines).includes("私人笔记正文"), false);
  assert.equal(lines.meaning, "公开释义");
});

test("发音能力与卡片指针安全区域依据真实 API 和几何判断", () => {
  assert.equal(canUseSpeechSynthesis({}), false);
  assert.equal(
    canUseSpeechSynthesis({
      speechSynthesis: { speak: () => {} },
      SpeechSynthesisUtterance: function Utterance() {},
    }),
    true,
  );
  assert.equal(
    pointerInPaddedRect(10, 10, { left: 20, top: 20, right: 40, bottom: 40 }, 12),
    true,
  );
  assert.equal(
    pointerInPaddedRect(0, 0, { left: 20, top: 20, right: 40, bottom: 40 }, 8),
    false,
  );
});
