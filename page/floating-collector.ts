import { createWordSelector } from "./word-selector.ts";
import { CaptureIntents } from "./capture-intents.ts";
import { wordAtPoint, sameOccurrence, type LocatedOccurrence } from "./document.ts";
import {
  movedBeyondThreshold,
  publicCardLines,
  type BallPosition,
} from "../lib/page-overlay.ts";
import type { Dictionary } from "../lib/types.ts";

// 拖拽只读取指针下的正文块。预览、保存与侧栏批量采集互不修改对方的草稿。
export function createFloatingCollector(
  shadow: ShadowRoot,
  ball: HTMLButtonElement,
  ports: {
    enabled(): boolean;
    place(position: BallPosition, snap?: boolean): BallPosition;
    moved(position: BallPosition): void;
    started(): void;
    finished(): void;
    lookup(word: string): Promise<Dictionary>;
    save(item: LocatedOccurrence, eventId: string): Promise<unknown>;
    notice(message: string): void;
  },
) {
  const lifetime = new AbortController();
  const preview = document.createElement("section");
  preview.className = "collector-card";
  preview.setAttribute("aria-label", "拖拽采词预览");
  preview.setAttribute("role", "status");
  preview.hidden = true;
  const selector = createWordSelector(shadow);
  shadow.append(preview);
  let drag:
    | { id: number; x: number; y: number; origin: BallPosition; moved: boolean }
    | undefined;
  let candidate: LocatedOccurrence | undefined;
  let point = { x: 0, y: 0 },
    frame = 0,
    revision = 0,
    saving = false;
  let timer: ReturnType<typeof setTimeout>;
  let suppressReleaseClick = false;
  // Esc 后再松手也不能点击页面链接或误开启遇见；下一次独立按下立即恢复原生行为。
  window.addEventListener(
    "pointerdown",
    () => {
      suppressReleaseClick = false;
    },
    { capture: true, signal: lifetime.signal },
  );
  window.addEventListener(
    "click",
    (event) => {
      if (!suppressReleaseClick) return;
      suppressReleaseClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true, signal: lifetime.signal },
  );
  const pendingEvents = new CaptureIntents();
  const clearPreview = () => {
    ++revision;
    clearTimeout(timer);
    candidate = undefined;
    preview.hidden = true;
    ball.classList.remove("collector-ready");
  };
  function positionPreview(item: LocatedOccurrence) {
    const rect = item.range.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    preview.style.left = `${Math.max(12, Math.min(width - preview.offsetWidth - 12, rect.left))}px`;
    const collector = selector.bounds;
    const below = Math.max(rect.bottom, collector.bottom) + 16;
    preview.style.top = `${Math.max(12, below + preview.offsetHeight < height - 12 ? below : Math.min(rect.top, collector.top) - preview.offsetHeight - 16)}px`;
  }
  function render(item: LocatedOccurrence, dictionary?: Dictionary) {
    preview.replaceChildren();
    const add = (name: string, value: string) => {
      const el = document.createElement("div");
      el.className = name;
      el.textContent = value;
      preview.append(el);
    };
    add("word", item.surface);
    if (dictionary) {
      const lines = publicCardLines(dictionary, item.surface, item.sentence);
      if (lines.phonetic) add("phonetic", lines.phonetic);
      add("meaning", lines.meaning);
      add("sentence", lines.sentence);
    } else add("meaning", "正在查词…");
    add("collector-hint", "松开采集描边词 · Esc 取消");
    preview.hidden = false;
    positionPreview(item);
  }
  function inspect() {
    frame = 0;
    if (!drag?.moved) return;
    // 贴边只调整位置；进入正文才启用单词选择器，避免误把页面边缘文字保存。
    const inside = point.x > 64 && point.x < document.documentElement.clientWidth - 64;
    ball.classList.toggle("collector-active", inside);
    const hit = inside ? wordAtPoint(document, point.x, point.y) : undefined;
    if (inside) selector.show(point, hit);
    else selector.hide();
    if (hit && candidate && sameOccurrence(hit, candidate)) {
      positionPreview(hit);
      return;
    }
    clearPreview();
    if (!hit) return;
    candidate = hit;
    const id = revision;
    ball.classList.add("collector-ready");
    render(hit);
    timer = setTimeout(async () => {
      try {
        const value = await ports.lookup(hit.surface);
        if (id === revision && drag?.moved) render(hit, value);
      } catch {
        if (id === revision && drag?.moved) {
          render(hit);
          preview.querySelector(".meaning")!.textContent = "暂未查到释义，仍可保存原句";
        }
      }
    }, 150);
  }
  function finish(event?: PointerEvent) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    const finished = drag;
    const released =
      event?.type === "pointerup" &&
      finished.moved &&
      event.clientX > 64 &&
      event.clientX < document.documentElement.clientWidth - 64
        ? wordAtPoint(document, event.clientX, event.clientY)
        : undefined;
    // 松手只能保存已经描边预览的那个词；最后一帧跳到新词或空白时取消。
    const hit =
      released && candidate && sameOccurrence(released, candidate)
        ? candidate
        : undefined;
    drag = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    clearPreview();
    selector.hide();
    ball.classList.remove("dragging", "collector-active");
    try {
      ball.releasePointerCapture(finished.id);
    } catch {
      // 浏览器可能已经释放捕获。
    }
    if (!finished.moved) return;
    suppressReleaseClick = true;
    ports.finished();
    const atEdge =
      event?.type === "pointerup" &&
      (event.clientX <= 64 || event.clientX >= document.documentElement.clientWidth - 64);
    const position = ports.place(
      atEdge ? { left: event!.clientX - 23, top: event!.clientY - 23 } : finished.origin,
    );
    if (atEdge) ports.moved(position);
    if (!hit || saving) {
      if (!atEdge && event?.type === "pointerup" && !saving)
        ports.notice("未采集：请等单词描边显示后，在该词上松手。");
      return;
    }
    saving = true;
    ball.classList.add("saving");
    ball.setAttribute("aria-busy", "true");
    ports.notice(`正在采集 ${hit.surface}…`);
    const intent = pendingEvents.acquire(hit);
    void ports
      .save(intent.occurrence, intent.eventId)
      .then((result) => {
        if (
          result &&
          typeof result === "object" &&
          "saved" in result &&
          result.saved === true
        )
          pendingEvents.complete(intent);
        if (!lifetime.signal.aborted)
          ports.notice(
            result && typeof result === "object" && "message" in result
              ? String(result.message)
              : `已将 ${hit.surface} 加入单词本`,
          );
      })
      .catch((error) => {
        if (!lifetime.signal.aborted)
          ports.notice(
            error instanceof Error ? error.message : "未能加入单词本，请重新尝试",
          );
      })
      .finally(() => {
        saving = false;
        ball.classList.remove("saving");
        ball.setAttribute("aria-busy", String(ball.classList.contains("busy")));
      });
  }
  ball.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || !ports.enabled() || saving) return;
      event.preventDefault();
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        origin: {
          left: parseFloat(ball.style.left),
          top: parseFloat(ball.style.top),
        },
        moved: false,
      };
      ball.setPointerCapture(event.pointerId);
    },
    { signal: lifetime.signal },
  );
  ball.addEventListener(
    "pointermove",
    (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      if (
        !drag.moved &&
        !movedBeyondThreshold(drag.x, drag.y, event.clientX, event.clientY)
      )
        return;
      if (!drag.moved) ports.started();
      drag.moved = true;
      ball.classList.add("dragging");
      ports.place({ left: event.clientX - 23, top: event.clientY - 23 }, false);
      point = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(inspect);
    },
    { signal: lifetime.signal },
  );
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    ball.addEventListener(type, (event) => finish(event as PointerEvent), {
      signal: lifetime.signal,
    });
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !drag?.moved) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish();
    },
    { capture: true, signal: lifetime.signal },
  );
  window.addEventListener("blur", () => finish(), { signal: lifetime.signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) finish();
    },
    { signal: lifetime.signal },
  );
  return {
    get dragging() {
      return !!drag;
    },
    get saving() {
      return saving;
    },
    cancel: () => finish(),
    clearOwnership: () => {
      finish();
      pendingEvents.clear();
    },
    dispose() {
      finish();
      lifetime.abort();
      preview.remove();
      selector.dispose();
    },
  };
}
