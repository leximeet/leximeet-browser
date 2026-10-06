import basketIcon from "../public/assets/icons/basket-plus.svg?raw";
import type { LocatedOccurrence } from "./document.ts";

// 像元素选择器一样描出一个真实单词；收集篮跟随指针，不放大或复制正文。
export function createWordSelector(shadow: ShadowRoot) {
  const collector = document.createElement("div");
  collector.className = "word-collector";
  collector.innerHTML = basketIcon;
  collector.hidden = true;
  collector.setAttribute("aria-hidden", "true");
  const target = document.createElement("div");
  target.className = "word-target";
  target.hidden = true;
  target.setAttribute("aria-hidden", "true");
  shadow.append(target, collector);

  function outline(range: Range) {
    // 一个词可跨 em/strong；合并同一行的片段，不把相邻的另一个词圈进来。
    const lines: {
      left: number;
      top: number;
      right: number;
      bottom: number;
    }[] = [];
    for (const rect of Array.from(range.getClientRects())) {
      if (!rect.width || !rect.height) continue;
      const line = lines.find(
        (row) =>
          Math.abs(row.top - rect.top) < 4 &&
          Math.abs(row.bottom - rect.bottom) < 4 &&
          rect.left <= row.right + 2 &&
          rect.right >= row.left - 2,
      );
      if (line) {
        line.left = Math.min(line.left, rect.left);
        line.top = Math.min(line.top, rect.top);
        line.right = Math.max(line.right, rect.right);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else
        lines.push({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        });
    }
    target.replaceChildren(
      ...lines.map((rect) => {
        const edge = document.createElement("span");
        edge.style.left = `${rect.left - 3}px`;
        edge.style.top = `${rect.top - 2}px`;
        edge.style.width = `${rect.right - rect.left + 6}px`;
        edge.style.height = `${rect.bottom - rect.top + 4}px`;
        return edge;
      }),
    );
    target.hidden = false;
  }

  return {
    show(point: { x: number; y: number }, item?: LocatedOccurrence) {
      collector.hidden = false;
      collector.classList.toggle("ready", !!item);
      collector.dataset.word = item?.surface || "";
      // 32px 收集篮偏离指针，原词完整可见；页边不溢出视口。
      collector.style.left = `${Math.max(8, Math.min(innerWidth - 40, point.x + 18))}px`;
      collector.style.top = `${Math.max(8, Math.min(innerHeight - 40, point.y + 20))}px`;
      if (item) outline(item.range);
      else target.hidden = true;
    },
    get bounds() {
      return collector.getBoundingClientRect();
    },
    hide() {
      collector.hidden = target.hidden = true;
    },
    dispose() {
      collector.remove();
      target.remove();
    },
  };
}
