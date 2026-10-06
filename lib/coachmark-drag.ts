export type CoachPoint = { x: number; y: number };
// 页面和 Vue 批注共享拖动行为。只拖标题栏，按钮仍执行自己的动作。
export function draggableCoach(
  handle: HTMLElement,
  box: HTMLElement,
  move: (point: CoachPoint) => void,
) {
  const life = new AbortController();
  let drag: {
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null = null;
  handle.tabIndex = 0;
  handle.setAttribute("role", "group");
  handle.setAttribute("aria-label", "移动教学窗口");
  handle.title = "拖动标题栏移动；方向键微调";
  handle.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || (e.target as Element).closest("button")) return;
      const r = box.getBoundingClientRect();
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        left: r.x,
        top: r.y,
      };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    { signal: life.signal },
  );
  handle.addEventListener(
    "pointermove",
    (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      move({
        x: drag.left + e.clientX - drag.x,
        y: drag.top + e.clientY - drag.y,
      });
    },
    { signal: life.signal },
  );
  const release = () => {
    drag = null;
  };
  handle.addEventListener("pointerup", release, { signal: life.signal });
  handle.addEventListener("pointercancel", release, { signal: life.signal });
  handle.addEventListener("lostpointercapture", release, {
    signal: life.signal,
  });
  handle.addEventListener(
    "keydown",
    (e) => {
      if (
        e.target !== handle ||
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
      )
        return;
      const r = box.getBoundingClientRect(),
        d = e.shiftKey ? 20 : 8;
      move({
        x: r.x + (e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0),
        y: r.y + (e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0),
      });
      e.preventDefault();
    },
    { signal: life.signal },
  );
  return () => life.abort();
}
