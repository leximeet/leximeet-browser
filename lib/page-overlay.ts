// 页内浮球几何与朗读能力。不改写网页正文节点，也不依赖 LMCP 语音方法。

export const BALL_SIZE = 46;
export const BALL_MARGIN = 12;
export const CARD_LEAVE_MS = 220;
export const DRAG_THRESHOLD_PX = 6;
// 单页候选上限：先固定预算，再据 50,000 词索引测量决定是否加进度。
export const PAGE_CANDIDATE_LIMIT = 500;

export type OverlayKeyboardAction =
  | "analyze"
  | "sidebar"
  | "hide"
  | "speak"
  | "snap-left"
  | "snap-right";

/**
 * 浮球/简卡键盘等价：不拦截站点常规按键、链接、输入框。
 * 站点控件优先；词遇宿主内才处理分析、侧栏、朗读和吸附。
 */
export function overlayKeyboardAction(
  event: {
    key: string;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
  },
  context: {
    ballFocused: boolean;
    cardFocused?: boolean;
    cardVisible: boolean;
    siteControl: boolean;
  },
): OverlayKeyboardAction | null {
  if (context.siteControl) return null;
  if (event.key === "Escape") return "hide";
  if (context.ballFocused && event.key === "Enter" && !event.metaKey && !event.ctrlKey)
    return "analyze";
  if (context.ballFocused && event.key === "F10" && event.shiftKey) return "sidebar";
  if (context.ballFocused && event.key === "ArrowLeft") return "snap-left";
  if (context.ballFocused && event.key === "ArrowRight") return "snap-right";
  // S 只在浮球或简卡本身获得焦点时朗读，避免截获网页里的站点快捷键。
  const hostFocused = context.ballFocused || context.cardFocused === true;
  if (
    hostFocused &&
    context.cardVisible &&
    (event.key === "s" || event.key === "S") &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  )
    return "speak";
  return null;
}

export type BallPosition = { left: number; top: number };
export type ViewportSize = { width: number; height: number };

export function ballStorageKey(origin: string) {
  return `leximeet-ball:${origin}`;
}

export function defaultBallPosition(viewport: ViewportSize): BallPosition {
  return {
    left: Math.max(BALL_MARGIN, viewport.width - BALL_SIZE - 22),
    top: Math.max(BALL_MARGIN, viewport.height - BALL_SIZE - 88),
  };
}

// 夹紧到可视区后吸附到较近的左右边缘，避免挡住正文中线。
export function snapBallPosition(
  left: number,
  top: number,
  viewport: ViewportSize,
): BallPosition {
  const maxLeft = Math.max(BALL_MARGIN, viewport.width - BALL_SIZE - BALL_MARGIN);
  const maxTop = Math.max(BALL_MARGIN, viewport.height - BALL_SIZE - BALL_MARGIN);
  const clampedLeft = Math.min(maxLeft, Math.max(BALL_MARGIN, left));
  const clampedTop = Math.min(maxTop, Math.max(BALL_MARGIN, top));
  const distLeft = clampedLeft - BALL_MARGIN;
  const distRight = maxLeft - clampedLeft;
  return {
    left: distLeft <= distRight ? BALL_MARGIN : maxLeft,
    top: clampedTop,
  };
}

export function parseBallPosition(value: unknown): BallPosition | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as BallPosition).left !== "number" ||
    typeof (value as BallPosition).top !== "number" ||
    !Number.isFinite((value as BallPosition).left) ||
    !Number.isFinite((value as BallPosition).top)
  )
    return undefined;
  return {
    left: (value as BallPosition).left,
    top: (value as BallPosition).top,
  };
}

export function publicCardLines(
  lookup: { phonetic?: string; meaning?: string } | null | undefined,
  surface: string,
  sentence: string,
) {
  return {
    word: surface,
    phonetic: lookup?.phonetic || "",
    meaning: lookup?.meaning || "公共词典暂无释义",
    sentence,
    notice: "词遇核心词典 · 私人遇见记录请在侧栏查看",
  };
}

export function movedBeyondThreshold(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  threshold = DRAG_THRESHOLD_PX,
) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  return dx * dx + dy * dy >= threshold * threshold;
}

// 只有浏览器确实暴露 speak 才允许显示朗读按钮，禁止无能力时的假入口。
export function canUseSpeechSynthesis(
  api: {
    speechSynthesis?: { speak?: unknown };
    SpeechSynthesisUtterance?: unknown;
  } = globalThis,
) {
  return (
    typeof api.speechSynthesis?.speak === "function" &&
    typeof api.SpeechSynthesisUtterance === "function"
  );
}

export function pointerInPaddedRect(
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number },
  pad: number,
) {
  return (
    x >= rect.left - pad &&
    x <= rect.right + pad &&
    y >= rect.top - pad &&
    y <= rect.bottom + pad
  );
}
