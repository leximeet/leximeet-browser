// 实际控件与批注共用视口坐标；选择不遮住控件的一侧，窄侧栏也不溢出。
export type CoachRect = { x: number; y: number; width: number; height: number };
export function coachmarkLayout(
  target: CoachRect,
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  avoid: CoachRect[] = [],
  position?: { x: number; y: number },
) {
  const margin = 12,
    gap = 22;
  const width = Math.max(1, Math.min(size.width, viewport.width - margin * 2));
  const height = Math.max(1, Math.min(size.height, viewport.height - margin * 2));
  const clamp = (v: number, low: number, high: number) =>
    Math.max(low, Math.min(Math.max(low, high), v));
  const center = {
    x: clamp(target.x + target.width / 2, 8, viewport.width - 8),
    y: clamp(target.y + target.height / 2, 8, viewport.height - 8),
  };
  // 除了目标，也避让真实打开的菜单；连线仍指向原来的控件。
  const choices = [target, ...avoid]
    .flatMap((rect) => [
      { x: rect.x + rect.width / 2 - width / 2, y: rect.y + rect.height + gap },
      { x: rect.x + rect.width / 2 - width / 2, y: rect.y - height - gap },
      { x: rect.x - width - gap, y: rect.y + rect.height / 2 - height / 2 },
      {
        x: rect.x + rect.width + gap,
        y: rect.y + rect.height / 2 - height / 2,
      },
    ])
    .map((p) => ({
      x: clamp(p.x, margin, viewport.width - width - margin),
      y: clamp(p.y, margin, viewport.height - height - margin),
      width,
      height,
    }));
  const intersection = (p: CoachRect, rect: CoachRect) =>
    Math.max(0, Math.min(p.x + p.width, rect.x + rect.width) - Math.max(p.x, rect.x)) *
    Math.max(0, Math.min(p.y + p.height, rect.y + rect.height) - Math.max(p.y, rect.y));
  const score = (p: CoachRect) =>
    intersection(p, target) * 2 +
    avoid.reduce((sum, rect) => sum + intersection(p, rect), 0);
  const automatic = choices.reduce((best, p) => (score(p) < score(best) ? p : best));
  // 手动移动仅改变批注；连线继续跟随实际控件，并在缩窗后限制在视口内。
  const box = position
    ? {
        ...automatic,
        x: clamp(position.x, margin, viewport.width - width - margin),
        y: clamp(position.y, margin, viewport.height - height - margin),
      }
    : automatic;
  const from = {
    x: clamp(center.x, box.x + 12, box.x + width - 12),
    y: center.y < box.y ? box.y : center.y > box.y + height ? box.y + height : center.y,
  };
  // 连线止于控件边缘，箭头不覆盖可点击文字。
  const to = {
    x: clamp(from.x, target.x, target.x + target.width),
    y: clamp(from.y, target.y, target.y + target.height),
  };
  return {
    box,
    from,
    to,
    path: `M ${from.x} ${from.y} Q ${from.x} ${to.y} ${to.x} ${to.y}`,
  };
}
