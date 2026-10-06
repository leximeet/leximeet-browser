import puzzleIcon from "../public/assets/icons/puzzle.svg?raw";
import pinIcon from "../public/assets/icons/pin.svg?raw";
import { coachmarkLayout } from "../lib/coachmark-layout.ts";
import { draggableCoach, type CoachPoint } from "../lib/coachmark-drag.ts";
export type PageGuideView = {
  active: boolean;
  step: string;
  advancedAt: number;
  encounterAnalyzed?: boolean;
  floating: {
    closed: boolean;
    hovered: boolean;
    analyzed: boolean;
    deactivated?: boolean;
    reopened: boolean;
    reclosed: boolean;
    captured?: boolean;
    managed?: boolean;
  };
};
// 批注只读取教学阶段与本页 Range；步骤只能由实际固定/分析/采集等事件推进。
export function createPageTutorial(
  shadow: ShadowRoot,
  ports: {
    view(): Promise<PageGuideView>;
    dismiss(): Promise<unknown>;
    pinning(): Promise<unknown>;
    openPanel(): Promise<unknown>;
    builtin: boolean;
    changed?(view: PageGuideView): void;
    anchor(): {
      panelVisible: boolean;
      capture: boolean;
      dragging: boolean;
      picked: number;
      range?: Range;
      ball: HTMLButtonElement;
      sidebar: HTMLElement;
    };
  },
) {
  // 普通网页只保留浮球。不能创建未渲染的教学框，否则空白框会在每个新网页再次出现。
  if (!ports.builtin)
    return {
      refresh: async () => {},
      update: () => {},
      dismiss: async () => {},
      dispose: () => {},
    };
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  svg.classList.add("page-guide-line");
  svg.style.display = "none";
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(ns, "path"),
    arrow = document.createElementNS(ns, "path");
  svg.append(line, arrow);
  const callout = document.createElement("section");
  callout.className = "page-guide";
  callout.hidden = true;
  callout.setAttribute("aria-label", "词遇网页操作指引");
  const handle = document.createElement("header"),
    stage = document.createElement("small"),
    tools = document.createElement("div");
  handle.className = "page-guide-handle";
  tools.className = "page-guide-tools";
  const toggle = document.createElement("button"),
    bodyBox = document.createElement("div");
  toggle.type = "button";
  const title = document.createElement("strong"),
    body = document.createElement("p"),
    actions = document.createElement("div"),
    pin = document.createElement("button"),
    open = document.createElement("button"),
    skip = document.createElement("button");
  pin.type = open.type = skip.type = "button";
  open.className = "page-guide-primary";
  const failure = document.createElement("small");
  failure.setAttribute("role", "alert");
  failure.hidden = true;
  let opening = false;
  open.addEventListener("click", async () => {
    if (opening) return;
    opening = true;
    failure.hidden = true;
    render();
    try {
      await ports.openPanel();
      await refresh();
    } catch {
      failure.textContent = "侧栏没有打开，请再试一次。";
      failure.hidden = false;
    } finally {
      opening = false;
      render();
    }
  });
  pin.textContent = "在扩展设置中固定 ↗";
  const pinSteps = document.createElement("ol");
  pinSteps.className = "page-guide-pin-steps";
  pinSteps.setAttribute("aria-label", "固定到工具栏的操作步骤");
  for (const [icon, text] of [
    [puzzleIcon, "点击浏览器右上角的拼图按钮"],
    [pinIcon, "找到词遇，点击它右侧的图钉"],
  ] as const) {
    const row = document.createElement("li"),
      symbol = document.createElement("span"),
      label = document.createElement("span");
    symbol.innerHTML = icon;
    symbol.setAttribute("aria-hidden", "true");
    label.textContent = text;
    row.append(symbol, label);
    pinSteps.append(row);
  }
  const flow = document.createElement("ol");
  flow.className = "page-guide-flow";
  flow.setAttribute("aria-label", "悬浮按钮的五步操作");
  for (const label of ["开启遇见", "取消遇见", "拖拽采词", "打开侧栏", "收起侧栏"]) {
    const item = document.createElement("li");
    item.textContent = label;
    flow.append(item);
  }
  actions.className = "page-guide-actions";
  skip.className = "page-guide-skip";
  skip.textContent = "跳过教学";
  let view: PageGuideView | null = null,
    disposed = false,
    position: CoachPoint | undefined,
    collapsed = false,
    advancedAt = 0,
    refreshVersion = 0;
  async function dismiss() {
    await ports.dismiss();
    view = null;
    render();
  }
  skip.addEventListener("click", () => void dismiss());
  pin.addEventListener("click", () => void ports.pinning());
  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    render();
  });
  tools.append(toggle);
  handle.append(stage, tools);
  actions.append(open, pin, skip);
  bodyBox.append(title, body, pinSteps, flow, actions, failure);
  callout.append(handle, bodyBox);
  shadow.append(svg, callout);
  const detachDrag = draggableCoach(handle, callout, (point) => {
    position = point;
    render();
  });
  const celebration = document.createElement("div");
  celebration.className = "page-guide-celebration";
  celebration.hidden = true;
  celebration.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 24; i++) {
    const spark = document.createElement("i");
    spark.style.setProperty("--angle", `${i * 15}deg`);
    celebration.append(spark);
  }
  shadow.append(celebration);
  let fireworksTimer: ReturnType<typeof setTimeout>;
  function render() {
    const a = ports.anchor();
    let target: DOMRect | undefined,
      label = "",
      text = "",
      index = 0,
      floatingIndex = 0;
    if (
      view?.active &&
      view.step === "encounter" &&
      view.encounterAnalyzed &&
      a.panelVisible &&
      !a.capture &&
      a.range
    ) {
      target = a.range.getBoundingClientRect();
      label = "悬停高亮词，看看词卡";
      text = "把鼠标移到这个高亮词上，看看释义与原句。看过词卡后，再来采集。";
      index = 4;
    } else if (
      view?.active &&
      view.step === "capture" &&
      a.panelVisible &&
      a.capture &&
      !a.picked &&
      a.range
    ) {
      target = a.range.getBoundingClientRect();
      label = "摘下你的第一个词";
      text = "点这个英文词，它会飞入右侧的已采集列表。";
      index = 5;
    } else if (
      view?.active &&
      view.step === "floating" &&
      !a.dragging &&
      view.floating.closed &&
      !a.ball.hidden
    ) {
      target = a.ball.getBoundingClientRect();
      index = 6;
      if (!view.floating.analyzed) {
        label = "单击，开启遇见";
        text = "点一下悬浮球，转圈后会显示本页遇见。";
      } else if (!view.floating.deactivated) {
        floatingIndex = 1;
        label = "再点一下，取消遇见";
        text = "再单击悬浮球，关闭本页遇见并恢复正文。";
      } else if (!view.floating.captured) {
        floatingIndex = 2;
        label = "拖到单词上，松开采集";
        text =
          "按住书本拖进正文，小篮子跟着你移动。蓝框只圈一个词，松开就加入单词本；Esc 取消。";
      } else if (!view.floating.reopened) {
        floatingIndex = 3;
        label = "右键，打开阅读侧栏";
        text = "右键悬浮球，回到遇见与采集侧栏。悬浮球会继续留在正文旁边。";
      } else {
        floatingIndex = 4;
        label = "再右键，收起阅读侧栏";
        text =
          "侧栏打开时，再右键悬浮球就能收起侧栏。需要学习或整理时，点击侧栏里的“打开管理”。";
      }
    } else if (
      ports.builtin &&
      view?.active &&
      ["pin", "panel"].includes(view.step) &&
      !a.panelVisible
    ) {
      // 工具栏属于 Chrome，不能假装知道图钉坐标；用可识别图标和两步说明。
      target = new DOMRect(innerWidth - 65, 8, 20, 12);
      index = view.step === "pin" ? 1 : 2;
      label = view.step === "pin" ? "先把词遇固定到工具栏" : "点击词遇图标，打开侧栏";
      text =
        view.step === "pin"
          ? "固定后，随时点击词遇图标就能打开侧栏。暂时不会也没关系，可以直接下一步。"
          : "点击刚固定的词遇图标。侧栏会在右侧打开，继续下一步。";
    }
    callout.hidden = !target;
    svg.style.display =
      target && !collapsed && !["pin", "panel"].includes(view!.step) ? "block" : "none";
    if (!target) return;
    callout.dataset.step = view!.step;
    callout.dataset.collapsed = String(collapsed);
    bodyBox.hidden = collapsed;
    toggle.textContent = collapsed ? "+" : "−";
    toggle.setAttribute("aria-label", collapsed ? "展开教学" : "收起教学");
    pin.hidden = !["pin", "panel"].includes(view!.step);
    open.hidden = pin.hidden;
    open.disabled = opening;
    open.textContent = opening
      ? "正在打开侧栏…"
      : view!.step === "pin"
        ? "下一步，打开侧栏 →"
        : "打开阅读侧栏 →";
    pinSteps.hidden = view!.step !== "pin";
    flow.hidden = view!.step !== "floating";
    callout.dataset.substep =
      view!.step === "floating"
        ? ["encounter-on", "encounter-off", "collect", "sidebar", "sidebar-close"][
            floatingIndex
          ]
        : "";
    Array.from(flow.children).forEach((item, i) => {
      item.setAttribute("aria-current", i === floatingIndex ? "step" : "false");
      item.classList.toggle("done", i < floatingIndex);
    });
    stage.textContent =
      view!.step === "floating"
        ? `悬浮按钮 · ${floatingIndex + 1} / 5`
        : `使用教学 · ${index} / 6`;
    title.textContent = label;
    body.textContent = text;
    const avoid = [
      a.sidebar.closest<HTMLElement>(".ball-tip"),
      document.querySelector<HTMLElement>(".lesson-header"),
    ]
      .filter((el): el is HTMLElement => !!el && !el.hidden)
      .map((el) => el.getBoundingClientRect());
    const p = coachmarkLayout(
      target,
      { width: innerWidth, height: innerHeight },
      { width: 320, height: callout.offsetHeight || 170 },
      avoid,
      position ||
        (ports.builtin && ["pin", "panel"].includes(view!.step)
          ? {
              // 工具栏教学停在页头右侧，留出正文标题；窄窗移到下方，可拖动或收起。
              x: innerWidth - 344,
              y:
                innerWidth < 650
                  ? Math.max(100, innerHeight - callout.offsetHeight - 28)
                  : (document.querySelector(".lesson-header")?.getBoundingClientRect()
                      .bottom || 75) + 22,
            }
          : undefined),
    );
    callout.style.left = `${p.box.x}px`;
    callout.style.top = `${p.box.y}px`;
    callout.style.width = `${p.box.width}px`;
    line.setAttribute("d", p.path);
    const angle = Math.atan2(p.to.y - p.from.y, p.to.x - p.from.x),
      length = 9;
    arrow.setAttribute(
      "d",
      `M ${p.to.x - length * Math.cos(angle - 0.45)} ${p.to.y - length * Math.sin(angle - 0.45)} L ${p.to.x} ${p.to.y} L ${p.to.x - length * Math.cos(angle + 0.45)} ${p.to.y - length * Math.sin(angle + 0.45)}`,
    );
  }
  async function refresh() {
    if (!ports.builtin) return;
    const version = ++refreshVersion;
    try {
      const next = await ports.view();
      if (disposed || version !== refreshVersion) return;
      if (view?.step !== next.step) position = undefined;
      view = next;
      ports.changed?.(next);
      if (
        next.advancedAt &&
        next.advancedAt !== advancedAt &&
        Date.now() - next.advancedAt < 2500
      ) {
        advancedAt = next.advancedAt;
        celebration.hidden = false;
        clearTimeout(fireworksTimer);
        fireworksTimer = setTimeout(() => {
          celebration.hidden = true;
        }, 2500);
      }
      render();
    } catch {
      if (version !== refreshVersion) return;
      callout.hidden = true;
      svg.style.display = "none";
    }
  }
  const timer = ports.builtin ? setInterval(() => void refresh(), 1000) : undefined;
  const onVisible = () => {
    if (!document.hidden) void refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("resize", render);
  window.addEventListener("scroll", render, true);
  return {
    refresh,
    update: render,
    dismiss,
    dispose() {
      disposed = true;
      clearInterval(timer);
      clearTimeout(fireworksTimer);
      detachDrag();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("resize", render);
      window.removeEventListener("scroll", render, true);
      svg.remove();
      callout.remove();
      celebration.remove();
    },
  };
}
