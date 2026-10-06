// 网页和原生侧栏属于两个渲染表面：网页动画飞到边缘，真实列表接力入场。
export function createPickingFeedback(shadow: ShadowRoot) {
  const cursor = document.createElement("style");
  cursor.dataset.leximeetPicking = "true";
  document.head.append(cursor);
  const flights = new Set<HTMLElement>();
  const lens = document.createElement("span");
  lens.className = "pick-lens";
  lens.hidden = true;
  lens.setAttribute("aria-hidden", "true");
  shadow.append(lens);
  return {
    focus(item?: { surface: string; range: Range }) {
      lens.hidden = !item;
      if (!item) return;
      const rect = item.range.getBoundingClientRect();
      lens.textContent = item.surface;
      lens.style.left = `${Math.max(8, Math.min(innerWidth - 140, rect.left))}px`;
      lens.style.top = `${Math.max(8, rect.top - 35)}px`;
    },
    active(value: boolean) {
      if (!value) lens.hidden = true;
      // 只增删自己的样式，不覆盖网站原有 cursor 或其它内联样式。
      cursor.textContent = value
        ? "html,body,body *{cursor:grab!important}body :is(input,textarea,[contenteditable]){cursor:default!important}"
        : "";
    },
    picked(word: string, range: Range) {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const rect = range.getBoundingClientRect();
      const chip = document.createElement("span");
      chip.className = "pick-flight";
      chip.textContent = word;
      chip.style.left = `${rect.x}px`;
      chip.style.top = `${rect.y}px`;
      shadow.append(chip);
      flights.add(chip);
      const destination = Math.max(0, document.documentElement.clientWidth - rect.x + 25);
      const animation = chip.animate(
        [
          { transform: "translate(0,0) scale(1)", opacity: 1 },
          {
            transform: `translate(${destination * 0.35}px,-42px) scale(1.1)`,
            opacity: 1,
            offset: 0.4,
          },
          {
            transform: `translate(${destination}px,${Math.max(-80, Math.min(80, innerHeight * 0.38 - rect.y))}px) scale(.7)`,
            opacity: 0,
          },
        ],
        { duration: 440, easing: "cubic-bezier(.22,.72,.32,1)" },
      );
      animation.finished
        .catch(() => {})
        .finally(() => {
          chip.remove();
          flights.delete(chip);
        });
    },
    dispose() {
      cursor.remove();
      lens.remove();
      for (const flight of flights) flight.remove();
      flights.clear();
    },
  };
}
