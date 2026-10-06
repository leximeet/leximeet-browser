import { createPronunciationPlayer } from "../lib/pronunciation.ts";
import { browser } from "wxt/browser";
import { replyAsync } from "../lib/runtime-reply.ts";
import { PanelToggle } from "./panel-toggle.ts";
import { encounterWord } from "../lib/pure.ts";
import bookIcon from "../public/assets/icons/book-2.svg?raw";
import volumeIcon from "../public/assets/icons/volume.svg?raw";
import { createFloatingCollector } from "./floating-collector.ts";
import {
  readDocument,
  occurrenceAt,
  wordAtPoint,
  sameOccurrence,
  type LocatedOccurrence,
} from "./document.ts";
import { pageStyles } from "./styles.ts";
import { createPickingFeedback } from "./picking.ts";
import { createPageTutorial } from "./tutorial.ts";
import { captureResultNotice } from "../lib/page-session.ts";
import { pageLocationKey } from "../lib/page-navigation.ts";
import type { Dictionary } from "../lib/types.ts";
import {
  BALL_MARGIN,
  CARD_LEAVE_MS,
  PAGE_CANDIDATE_LIMIT,
  defaultBallPosition,
  overlayKeyboardAction,
  publicCardLines,
  pointerInPaddedRect,
  snapBallPosition,
  type BallPosition,
} from "../lib/page-overlay.ts";
import {
  defaultFloatingPreferences,
  floatingPosition,
  floatingProjection,
  type FloatingProjection,
} from "../lib/floating-preferences.ts";

// 页面入口只提供生命周期；扫描、Range、高亮、采集和浮球由同一控制器实现。
export function mountReader(
  ctx: { onInvalidated(callback: () => void): void },
  tutorialTabId?: number,
) {
  // 同一文档的静态入口与工具栏补注入共享一份实例，绝不重复注册拦截器。
  const global = globalThis as typeof globalThis & {
    __leximeetPage?: boolean;
  };
  if (global.__leximeetPage) return;
  global.__leximeetPage = true;
  const generation = crypto.randomUUID();
  const lifetime = new AbortController();
  const request = async (action: string, data: unknown = {}) => {
    const result = await browser.runtime.sendMessage({
      channel: "leximeet",
      generation,
      action,
      data,
    });
    if (!result?.ok) throw new Error(result?.error || "词遇连接已断开");
    return result.result;
  };
  let occurrences: LocatedOccurrence[] = [],
    selected: string | null = null,
    mode = "idle",
    scanVersion = 0,
    leaseUntil = 0;
  let guards: AbortController | undefined;
  let desktopExpiry: ReturnType<typeof setTimeout> | undefined;
  const collected = new Set<string>();
  const highlightNames = [
    "leximeet-encounter",
    "leximeet-current",
    "leximeet-collected",
    "leximeet-target",
    "leximeet-manual",
    "leximeet-both",
  ];
  const supportsHighlight = !!((globalThis as any).Highlight && (CSS as any).highlights);
  // 独立 ShadowRoot 只展示公共释义与本页原句，不接收个人语境、词本或历史统计。
  const host = document.createElement("leximeet-page-ui");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = pageStyles;
  shadow.append(style);
  const ball = document.createElement("button");
  ball.className = "ball";
  // 恢复简洁的书本入口图标，品牌保留在扩展原生标题。
  ball.innerHTML = bookIcon;
  const ballSpinner = document.createElement("span");
  ballSpinner.className = "ball-spinner";
  ballSpinner.setAttribute("aria-hidden", "true");
  ball.append(ballSpinner);
  ball.setAttribute("aria-label", "词遇：单击开关遇见，拖拽采词，右键打开侧栏");
  ball.setAttribute("aria-keyshortcuts", "Enter Shift+F10");
  ball.setAttribute("aria-pressed", "false");
  ball.setAttribute("aria-busy", "false");
  ball.hidden = true;
  let collector: ReturnType<typeof createFloatingCollector> | undefined;
  const cardCaptures = new Map<string, string>();
  let guideAllowsBall = tutorialTabId === undefined;
  let panelVisible = false;
  // 首次握手与浮球设置完成后再展示入口，侧栏可见与否不影响浮球。
  let floatingReady = false;
  let floating: FloatingProjection = floatingProjection(
    defaultFloatingPreferences(),
    location.origin,
  );
  const ballTip = document.createElement("div");
  ballTip.className = "ball-tip";
  ballTip.hidden = true;
  const tipLabel = document.createElement("span");
  tipLabel.textContent = "单击开关遇见 · 拖拽采词 · 右键打开侧栏";
  ballTip.append(tipLabel);
  placeBall(defaultBallPosition(viewportSize()));
  const card = document.createElement("section");
  card.className = "card";
  card.hidden = true;
  card.setAttribute("aria-label", "当前网页单词简卡");
  const notice = document.createElement("div");
  notice.className = "notice";
  notice.hidden = true;
  notice.setAttribute("role", "status");
  shadow.append(ball, ballTip, card, notice);
  document.documentElement.append(host);
  const picking = createPickingFeedback(shadow);
  const tutorial = createPageTutorial(shadow, {
    view: () => request("guide-view"),
    dismiss: () => request("guide-dismiss"),
    pinning: () => request("guide-pinning"),
    openPanel: () => request("guide-next"),
    builtin: tutorialTabId !== undefined,
    changed: (view) => {
      guideAllowsBall = !view.active || view.step === "floating";
      applyFloating(floating);
    },
    anchor: () => ({
      panelVisible,
      capture: mode === "capture",
      dragging: !!collector?.dragging,
      picked: collected.size,
      ball,
      sidebar: ballTip,
      range:
        (mode === "capture" && tutorialTabId !== undefined
          ? tutorialPickRange()
          : undefined) ||
        occurrences.find((x) => {
          const r = x.range.getBoundingClientRect();
          return (
            !!x.range.startContainer.parentElement?.closest("p,li") &&
            x.surface.length >= 6 &&
            r.top >= 40 &&
            r.bottom < innerHeight - 30
          );
        })?.range ||
        occurrences.find((x) => {
          const r = x.range.getBoundingClientRect();
          return r.top >= 40 && r.bottom < innerHeight - 30;
        })?.range,
    }),
  });
  function tutorialPickRange() {
    const el = document.querySelector("[data-lesson-pick]");
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    return range;
  }
  const highlightsStyle = document.createElement("style");
  highlightsStyle.textContent =
    "::highlight(leximeet-target){background-color:#4b9bcb30;text-decoration:underline solid #4b9bcb 1px}::highlight(leximeet-manual){background-color:#87b89738;text-decoration:underline solid #719e7a 1px}::highlight(leximeet-both){background-color:#aa8fcd30;text-decoration:underline solid #9276b6 1px}::highlight(leximeet-encounter){background-color:#87b89738;text-decoration:underline solid #719e7a 1px}::highlight(leximeet-current){background-color:#e4c87270;text-decoration:underline solid #ae8641 2px}::highlight(leximeet-collected){background-color:#659f7760;text-decoration:underline solid #467655 2px}";
  document.head.append(highlightsStyle);
  function showNotice(text: string, capture = false) {
    notice.textContent = text;
    notice.classList.toggle("capture", capture);
    notice.hidden = !text;
  }
  const speechAvailable = true;
  const voice = createPronunciationPlayer(
    () => document.createElement("audio"),
    (state) => {
      if (state.phase === "error") showNotice(state.message || "在线发音失败");
    },
  );
  let audioRequest = 0;
  function stopSpeech() {
    audioRequest++;
    voice.stop();
  }
  async function speak(text: string) {
    try {
      const id = ++audioRequest;
      const settings = await request("pronunciation", { word: text });
      if (id === audioRequest) await voice.play(text, settings);
    } catch {
      showNotice("在线发音失败，请检查网络");
    }
  }
  function viewportSize() {
    // innerWidth 包含非覆盖式滚动条；浮球必须停在真正可接收鼠标事件的网页区域。
    return {
      width: document.documentElement.clientWidth || innerWidth,
      height: document.documentElement.clientHeight || innerHeight,
    };
  }
  function placeBall(position: BallPosition, snap = true) {
    const viewport = viewportSize();
    const snapped = snap
      ? snapBallPosition(position.left, position.top, viewport)
      : {
          left: Math.min(viewport.width - 46, Math.max(0, position.left)),
          top: Math.min(viewport.height - 46, Math.max(0, position.top)),
        };
    ball.style.left = `${snapped.left}px`;
    ball.style.top = `${snapped.top}px`;
    ball.style.right = "auto";
    ball.style.bottom = "auto";
    ball.dataset.side = snapped.left < viewport.width / 2 ? "left" : "right";
    ballTip.style.left = `${Math.max(
      8,
      Math.min(
        viewport.width - 208,
        snapped.left < viewport.width / 2 ? snapped.left + 53 : snapped.left - 208,
      ),
    )}px`;
    ballTip.style.top = `${Math.max(8, Math.min(viewport.height - 124, snapped.top - 32))}px`;
    return snapped;
  }
  function applyFloating(next: FloatingProjection) {
    floating = next;
    ball.classList.toggle("locked", next.locked);
    const panelAction = panelVisible ? "收起侧栏" : "打开侧栏";
    const ballDescription = `单击开关遇见 · 拖拽采词 · 右键${panelAction}`;
    ball.setAttribute("aria-label", `词遇：单击开关遇见，拖拽采词，右键${panelAction}`);
    ball.title = ballDescription;
    tipLabel.textContent = ballDescription;
    ball.hidden =
      !floatingReady || !guideAllowsBall || !next.enabled || !!document.fullscreenElement;
    if (ball.hidden) {
      collector?.cancel();
      ballTip.hidden = true;
      ball.classList.remove("expanded");
      // 隐藏自己的入口时释放其焦点，避免重开后残留悬停菜单。
      if (shadow.activeElement === ball || ballTip.contains(shadow.activeElement))
        (shadow.activeElement as HTMLElement | null)?.blur();
    }
    if (!collector?.dragging) placeBall(floatingPosition(next, viewportSize()));
  }
  async function persistBall(position: BallPosition) {
    await request("ball-position", {
      position,
      viewport: viewportSize(),
    }).catch(() => {});
  }
  let leaveTimer: ReturnType<typeof setTimeout> | undefined,
    hoverId: string | null = null,
    hoverVersion = 0;
  function hideCard() {
    clearTimeout(leaveTimer);
    leaveTimer = undefined;
    hoverId = null;
    ++hoverVersion;
    stopSpeech();
    card.hidden = true;
  }
  function draw() {
    ball.setAttribute("aria-pressed", String(mode === "encounter"));
    if (!supportsHighlight) return;
    if (mode !== "encounter") {
      for (const name of highlightNames) (CSS as any).highlights.delete(name);
      return;
    }
    const registry = (CSS as any).highlights,
      HighlightClass = (globalThis as any).Highlight;
    registry.set(
      highlightNames[0],
      new HighlightClass(
        ...occurrences
          .filter(
            (x) =>
              (!x.origin || x.origin === "other") && x.range.startContainer.isConnected,
          )
          .map((x) => x.range),
      ),
    );
    for (const [index, origin] of [
      [3, "target"],
      [4, "manual"],
      [5, "both"],
    ] as const)
      registry.set(
        highlightNames[index],
        new HighlightClass(
          ...occurrences
            .filter((x) => x.origin === origin && x.range.startContainer.isConnected)
            .map((x) => x.range),
        ),
      );
    registry.set(
      highlightNames[1],
      new HighlightClass(
        ...occurrences.filter((x) => x.id === selected).map((x) => x.range),
      ),
    );
    registry.set(
      highlightNames[2],
      new HighlightClass(
        ...occurrences.filter((x) => collected.has(x.id)).map((x) => x.range),
      ),
    );
  }
  function stop(reason: string) {
    clearTimeout(desktopExpiry);
    collector?.cancel();
    guards?.abort();
    guards = undefined;
    mode = "idle";
    picking.active(false);
    ball.setAttribute("aria-pressed", "false");
    tutorial.update();
    leaseUntil = 0;
    hideCard();
    showNotice(reason);
  }
  async function cancel(reason: string) {
    stop(reason);
    await request("cancel").catch(() => {});
  }
  function selectedOccurrence(id: string, scroll = false) {
    const item = occurrences.find((x) => x.id === id);
    if (
      !item ||
      !item.range.startContainer.isConnected ||
      item.range.toString() !== item.surface
    )
      throw new Error("网页已更新，此处位置失效，请重新分析");
    selected = id;
    draw();
    if (scroll) {
      const rect = item.range.getBoundingClientRect();
      window.scrollBy({
        top: rect.top - innerHeight * 0.35,
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
    }
    return item;
  }
  const pendingPicks = new Map<string, Promise<unknown>>();
  async function collect(item: LocatedOccurrence) {
    if (mode !== "capture") return;
    const pending = pendingPicks.get(item.id);
    if (pending) return pending;
    const operation = doCollect(item).finally(() => pendingPicks.delete(item.id));
    pendingPicks.set(item.id, operation);
    return operation;
  }
  async function doCollect(item: LocatedOccurrence) {
    const version = scanVersion;
    selectedOccurrence(item.id);
    const value = await request("collect", {
      id: item.id,
      surface: item.surface,
      sentence: item.sentence,
      start: item.start,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (version !== scanVersion || mode !== "capture") return value;
    if (!collected.has(item.id) && value?.collected)
      picking.picked(item.surface, item.range);
    collected.add(item.id);
    tutorial.update();
    selected = item.id;
    draw();
    showNotice("", true);
    return value;
  }
  function startGuards() {
    picking.active(true);
    tutorial.update();
    guards?.abort();
    guards = new AbortController();
    const signal = guards.signal;
    leaseUntil = Date.now() + 6000;
    const guard = (event: Event) => {
      if (event.composedPath().includes(host)) return;
      if (mode !== "capture") return;
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          void cancel("已按 Esc 结束采集，草稿保留");
          return;
        }
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " ",
            "Tab",
          ].includes(event.key)
        )
          return;
      }
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "click" && event instanceof MouseEvent) {
        const point = wordAtPoint(document, event.clientX, event.clientY);
        if (point) {
          const hit = occurrences.find((item) => sameOccurrence(item, point)) || point;
          if (!occurrences.includes(hit)) occurrences.push(hit);
          const version = scanVersion;
          void collect(hit).catch((error) => {
            if (version === scanVersion && mode === "capture")
              showNotice(error.message, true);
          });
        }
      }
    };
    for (const type of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "auxclick",
      "contextmenu",
      "beforeinput",
      "submit",
      "keydown",
    ])
      window.addEventListener(type, guard, { capture: true, signal });
    let frame = 0;
    window.addEventListener(
      "pointermove",
      (event) => {
        if (frame || event.composedPath().includes(host)) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (mode === "capture")
            picking.focus(wordAtPoint(document, event.clientX, event.clientY));
        });
      },
      { passive: true, signal },
    );
    signal.addEventListener("abort", () => cancelAnimationFrame(frame), {
      once: true,
    });
    showNotice("");
  }
  let readerResultMode = "idle";
  function enterCapture() {
    ++scanVersion;
    stop("");
    if (readerResultMode !== "capture") {
      occurrences = [];
      collected.clear();
    } else
      occurrences = occurrences.filter(
        (item) =>
          item.range.startContainer.isConnected && item.range.toString() === item.surface,
      );
    readerResultMode = "capture";
    selected = null;
    mode = "capture";
    draw();
    startGuards();
  }
  async function scan(scanMode: string, preserveSurface = false) {
    if (!supportsHighlight)
      throw new Error(
        "当前浏览器不支持 CSS Custom Highlight，未改写网页，请升级 Chromium",
      );
    const version = ++scanVersion;
    stop("");
    mode = "analyzing";
    readerResultMode = scanMode;
    collected.clear();
    occurrences = [];
    selected = null;
    draw();
    const documentResult = readDocument(document);
    // Desktop 以原词精确匹配，不能提前把 US/us 等不同词头合并。
    const keyOf = (item: { surface: string; normalized: string }) =>
      preserveSurface ? item.surface : item.normalized;
    const unique = [
      ...new Set(
        documentResult.occurrences
          .filter((item) => encounterWord(item.surface))
          .map(keyOf),
      ),
    ];
    const budget = unique.slice(0, PAGE_CANDIDATE_LIMIT);
    const matches = new Map<string, any>();
    let expiresAt = Date.now() + 30_000;
    for (let offset = 0; offset < budget.length; offset += 100) {
      const result = await request("resolve", {
        words: budget.slice(offset, offset + 100),
      });
      if (version !== scanVersion) return;
      for (const item of result) {
        matches.set(item.matchKey || item.normalized, item);
        if (preserveSurface)
          expiresAt = Math.min(expiresAt, Date.now() + item.refreshAfterMs);
      }
    }
    occurrences = documentResult.occurrences
      .filter((x) => matches.has(keyOf(x)))
      .map((x) => ({ ...x, ...matches.get(keyOf(x)) }));
    selected = scanMode === "capture" ? null : occurrences[0]?.id || null;
    await request("scan-complete", {
      occurrences: occurrences.map(
        ({ id, surface, normalized, wordId, status, origin }) => ({
          id,
          surface,
          normalized,
          wordId,
          status,
          origin,
        }),
      ),
      partial: documentResult.partial || unique.length > PAGE_CANDIDATE_LIMIT,
    });
    if (version !== scanVersion) return;
    mode = scanMode;
    if (preserveSurface)
      desktopExpiry = setTimeout(
        () => {
          ++scanVersion;
          occurrences = [];
          selected = null;
          stop("桌面结果已过期，请重新分析");
          draw();
          void request("projection-expired").catch(() => {});
        },
        Math.max(1, expiresAt - Date.now()),
      );
    draw();
    tutorial.update();
    showNotice("");
  }
  async function showCard(item: LocatedOccurrence) {
    if (mode !== "encounter") return;
    const version = ++hoverVersion;
    const current = () =>
      version === hoverVersion &&
      hoverId === item.id &&
      mode === "encounter" &&
      item.range.startContainer.isConnected &&
      item.range.toString() === item.surface;
    card.replaceChildren();
    const add = (className: string, text: string) => {
      const element = document.createElement("div");
      element.className = className;
      element.textContent = text;
      card.append(element);
      return element;
    };
    // 命中真实词位后马上展示词头；异步查词只补充正文，不设置停留门槛。
    const heading = document.createElement("header");
    heading.className = "card-head";
    const word = document.createElement("div");
    word.className = "word";
    word.textContent = item.surface;
    heading.append(word);
    card.append(heading);
    if (speechAvailable) {
      const speakButton = document.createElement("button");
      speakButton.type = "button";
      speakButton.className = "speak";
      speakButton.innerHTML = volumeIcon;
      speakButton.querySelector("svg")?.setAttribute("aria-hidden", "true");
      speakButton.setAttribute("aria-keyshortcuts", "S");
      speakButton.setAttribute("aria-label", `发音 ${item.surface}`);
      speakButton.title = "发音";
      speakButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void speak(item.surface);
      });
      heading.append(speakButton);
    }
    const phonetic = add("phonetic", "");
    const meaning = add("meaning", "正在读取释义…");
    meaning.setAttribute("aria-busy", "true");
    add("sentence", item.sentence);
    const note = add("note", "");
    const captureButton = document.createElement("button"),
      feedback = document.createElement("p");
    captureButton.type = "button";
    captureButton.className = "capture";
    captureButton.textContent = "采集";
    captureButton.setAttribute("aria-label", `采集 ${item.surface}`);
    feedback.className = "note";
    feedback.setAttribute("role", "status");
    captureButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      captureButton.disabled = true;
      captureButton.textContent = "采集中…";
      feedback.textContent = "";
      // 未确认写入重用原事件；owner 切换时下面 end 会清除此缓存。
      const key = `${item.id}:${item.surface}:${item.sentence}:${item.start}`;
      const eventId = cardCaptures.get(key) ?? crypto.randomUUID();
      cardCaptures.set(key, eventId);
      try {
        const result = await request("collector-capture", {
          id: item.id,
          eventId,
          surface: item.surface,
          sentence: item.sentence,
          start: item.start,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        if (result?.saved) {
          cardCaptures.delete(key);
          captureButton.textContent =
            result.captureStatus === "duplicate-context" ? "已记录" : "已采集";
          feedback.textContent = result.message || `已采集 ${item.surface}`;
          showNotice(feedback.textContent);
        } else {
          captureButton.disabled = false;
          captureButton.textContent = "采集";
          feedback.textContent = result?.message || "采集未确认，请在侧栏查看原草稿";
        }
      } catch (error) {
        captureButton.disabled = false;
        captureButton.textContent = "重试采集";
        feedback.setAttribute("role", "alert");
        feedback.textContent = (error as Error).message;
        showNotice(feedback.textContent);
      }
    });
    card.append(captureButton, feedback);
    card.tabIndex = 0;
    card.setAttribute("role", "dialog");
    // 实际文字长度会改变高度；初显、查词成功/失败后都按真实边框定位，保留底部采集入口。
    const position = () => {
      const rect = item.range.getBoundingClientRect(),
        viewport = viewportSize();
      const size = card.getBoundingClientRect();
      const below = rect.bottom + 9;
      const top =
        below + size.height <= viewport.height - 12 ? below : rect.top - size.height - 9;
      card.style.left = `${Math.max(12, Math.min(viewport.width - size.width - 12, rect.left))}px`;
      card.style.top = `${Math.max(12, Math.min(viewport.height - size.height - 12, top))}px`;
    };
    card.hidden = false;
    position();
    try {
      const value: Dictionary = await request("lookup", { word: item.surface });
      // 已离开词位、切换归属或租期撤下时，不让迟到的正文重新打开旧卡片。
      if (!current()) return;
      const lines = publicCardLines(value, item.surface, item.sentence);
      phonetic.textContent = lines.phonetic;
      meaning.textContent = lines.meaning;
      meaning.removeAttribute("aria-busy");
      note.textContent = lines.notice;
      position();
      // 实际词卡正文已返回才推进教学，单纯完成扫描不能跳过悬浮步骤。
      if (tutorialTabId !== undefined)
        void request("guide-word-card", { id: item.id }).catch(() => {});
    } catch (error) {
      if (!current()) return;
      meaning.textContent = (error as Error).message;
      meaning.removeAttribute("aria-busy");
      meaning.setAttribute("role", "alert");
      position();
    }
  }
  let lastPointer: PointerEvent | undefined,
    frame = 0;
  function pointerKeepsCard(x: number, y: number) {
    if (card.hidden) return false;
    if (pointerInPaddedRect(x, y, card.getBoundingClientRect(), 16)) return true;
    const item = occurrences.find((entry) => entry.id === hoverId);
    return item
      ? pointerInPaddedRect(x, y, item.range.getBoundingClientRect(), 8)
      : false;
  }
  window.addEventListener(
    "pointermove",
    (event) => {
      lastPointer = event;
      if (frame || collector?.dragging) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (
          mode !== "encounter" ||
          !lastPointer ||
          lastPointer.buttons ||
          !getSelection()?.isCollapsed
        )
          return hideCard();
        if (lastPointer.composedPath().includes(host)) {
          clearTimeout(leaveTimer);
          leaveTimer = undefined;
          return;
        }
        const x = lastPointer.clientX,
          y = lastPointer.clientY;
        if (pointerKeepsCard(x, y)) {
          clearTimeout(leaveTimer);
          leaveTimer = undefined;
          return;
        }
        const item = occurrenceAt(occurrences, x, y);
        if (item?.id === hoverId) return;
        if (!item) {
          if (!leaveTimer) leaveTimer = setTimeout(hideCard, CARD_LEAVE_MS);
          return;
        }
        hideCard();
        hoverId = item.id;
        void showCard(item);
      });
    },
    { passive: true, signal: lifetime.signal },
  );
  card.addEventListener("pointerenter", () => {
    clearTimeout(leaveTimer);
    leaveTimer = undefined;
  });
  card.addEventListener("pointerleave", () => {
    leaveTimer = setTimeout(hideCard, CARD_LEAVE_MS);
  });
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.composedPath().includes(host)) return;
      hideCard();
    },
    {
      passive: true,
      signal: lifetime.signal,
    },
  );
  window.addEventListener(
    "click",
    (event) => {
      if (mode !== "encounter" || !getSelection()?.isCollapsed) return;
      const item = occurrenceAt(occurrences, event.clientX, event.clientY);
      if (item) {
        selectedOccurrence(item.id);
        void request("select", { id: item.id }).catch(() => {});
      }
    },
    { signal: lifetime.signal },
  );
  for (const event of ["scroll", "resize"])
    window.addEventListener(
      event,
      () => {
        hideCard();
        if (event === "resize" && !collector?.dragging)
          placeBall(floatingPosition(floating, viewportSize()));
      },
      {
        passive: true,
        capture: true,
        signal: lifetime.signal,
      },
    );
  // 内容增减也会使滚动条出现/消失，不一定产生 window resize；只观察根布局尺寸。
  const viewportObserver = new ResizeObserver(() => {
    if (!collector?.dragging) placeBall(floatingPosition(floating, viewportSize()));
  });
  viewportObserver.observe(document.documentElement);
  lifetime.signal.addEventListener("abort", () => viewportObserver.disconnect(), {
    once: true,
  });
  let tipLeave: ReturnType<typeof setTimeout> | undefined;
  const showBallTip = () => {
    clearTimeout(tipLeave);
    if (!ball.hidden && !collector?.dragging) {
      ballTip.hidden = false;
      ball.classList.add("expanded");
      tutorial.update(); // 悬停提示展开立即避让，不等下一轮后台进度轮询。
      void request("guide-floating-hover").catch(() => {});
    }
  };
  const hideBallTip = () => {
    tipLeave = setTimeout(() => {
      if (shadow.activeElement === ball || ballTip.contains(shadow.activeElement)) return;
      ballTip.hidden = true;
      ball.classList.remove("expanded");
      tutorial.update();
    }, 180);
  };
  ball.addEventListener("mouseenter", showBallTip);
  ball.addEventListener("mouseleave", hideBallTip);
  ball.addEventListener("focus", showBallTip);
  ball.addEventListener("blur", hideBallTip);
  ballTip.addEventListener("mouseenter", showBallTip);
  ballTip.addEventListener("mouseleave", hideBallTip);
  ballTip.addEventListener("focusin", showBallTip);
  ballTip.addEventListener("focusout", hideBallTip);
  collector = createFloatingCollector(shadow, ball, {
    enabled: () => !ball.hidden && !ball.classList.contains("busy"),
    place: placeBall,
    moved: (position) => {
      void persistBall(position);
    },
    started: () => {
      hideCard();
      ballTip.hidden = true;
      ball.classList.remove("expanded");
      tutorial.update();
    },
    finished: () => {
      tutorial.update();
    },
    lookup: (word) => request("collector-lookup", { word }),
    save: (item, eventId) =>
      request("collector-capture", {
        id: item.id,
        eventId,
        surface: item.surface,
        sentence: item.sentence,
        start: item.start,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    notice: (text) => {
      showNotice(text);
      if (text)
        setTimeout(() => {
          if (notice.textContent === text) showNotice("");
        }, 3500);
    },
  });
  document.addEventListener(
    "fullscreenchange",
    () => {
      collector?.cancel();
      ball.classList.remove("dragging", "expanded");
      ballTip.hidden = true;
      hideCard();
      applyFloating(floating);
      if (document.fullscreenElement && mode === "capture")
        void cancel("全屏时已结束采集，草稿保留");
    },
    { signal: lifetime.signal },
  );
  let encounterWanted = false,
    ballOperation = 0,
    dispatchedAt = -Infinity;
  let encounterTimer: ReturnType<typeof setTimeout>;
  const cancelQueuedEncounter = () => {
    clearTimeout(encounterTimer);
    ++ballOperation;
    ball.classList.remove("busy");
    ball.setAttribute("aria-busy", "false");
  };
  // 只合并请求，不丢弃用户的开关意图；连续点击后始终以最后一次意图为准。
  ball.addEventListener("click", () => {
    if (collector?.saving) return;
    if (!ball.classList.contains("busy")) encounterWanted = mode === "encounter";
    encounterWanted = !encounterWanted;
    const operation = ++ballOperation;
    clearTimeout(encounterTimer);
    ball.classList.add("busy");
    ball.setAttribute("aria-busy", "true");
    const dispatch = () => {
      dispatchedAt = performance.now();
      void request("set-encounter", { enabled: encounterWanted })
        .then((result) => {
          if (operation === ballOperation) encounterWanted = result.enabled === true;
        })
        .catch((error) => {
          if (operation === ballOperation) {
            encounterWanted = mode === "encounter";
            showNotice(error.message);
          }
        })
        .finally(() => {
          if (operation === ballOperation) {
            ball.classList.remove("busy");
            ball.setAttribute("aria-busy", "false");
          }
        });
    };
    const delay = Math.max(0, 180 - (performance.now() - dispatchedAt));
    if (delay) encounterTimer = setTimeout(dispatch, delay);
    else dispatch();
  });
  // 文档离开/扩展卸载不再派发排队意图，旧回执也不能改回球的忙碌状态。
  window.addEventListener("pagehide", cancelQueuedEncounter, {
    signal: lifetime.signal,
  });
  lifetime.signal.addEventListener("abort", cancelQueuedEncounter, {
    once: true,
  });
  const panelToggle = new PanelToggle({
    visible: () => panelVisible,
    request,
    changed(pending) {
      ball.dataset.panelPending = String(pending);
      ball.setAttribute(
        "aria-busy",
        String(pending || ball.classList.contains("busy") || collector.saving),
      );
    },
  });
  const togglePanel = () => {
    void panelToggle.toggle().catch((error) => showNotice(error.message));
  };
  ball.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    togglePanel();
  });
  ball.addEventListener("keydown", (event) => {
    const action = overlayKeyboardAction(event, {
      ballFocused: true,
      cardFocused: false,
      cardVisible: !card.hidden,
      siteControl: false,
    });
    if (action === "analyze") {
      event.preventDefault();
      ball.click();
    }
    if (action === "sidebar") {
      event.preventDefault();
      togglePanel();
    }
    if (action === "snap-left" || action === "snap-right") {
      event.preventDefault();
      const current = ball.getBoundingClientRect();
      const snapped = placeBall({
        left: action === "snap-left" ? BALL_MARGIN : viewportSize().width,
        top: current.top,
      });
      void persistBall(snapped);
    }
  });
  window.addEventListener(
    "keydown",
    (event) => {
      const path = event.composedPath();
      const target = event.target as HTMLElement | null;
      const siteControl = !!(
        target &&
        (target.closest(
          "a,button,input,textarea,select,summary,[role=button],[role=link],[role=menuitem],[contenteditable=true]",
        ) ||
          target.isContentEditable) &&
        !path.includes(host)
      );
      const action = overlayKeyboardAction(event, {
        ballFocused: path.includes(ball),
        cardFocused: path.includes(card),
        cardVisible: !card.hidden,
        siteControl,
      });
      if (action === "hide") {
        hideCard();
        return;
      }
      if (action === "speak") {
        const item =
          occurrences.find((entry) => entry.id === hoverId) ??
          occurrences.find((entry) => entry.id === selected);
        if (item) {
          event.preventDefault();
          speak(item.surface);
        }
        return;
      }
      if (path.includes(ball) || path.includes(host)) return;
      // 站点按钮/链接/输入框的 Enter 必须交给网页；不能因页内选中词而 preventDefault。
      if (siteControl) return;
      if (mode === "encounter" && event.key === "Enter" && !event.repeat && selected) {
        const item = occurrences.find((entry) => entry.id === selected);
        if (!item) return;
        event.preventDefault();
        hoverId = item.id;
        void showCard(item).catch((error) => showNotice(error.message));
      }
    },
    { signal: lifetime.signal },
  );
  const listener = (message: any, sender: any, sendResponse: (reply: any) => void) => {
    if (
      sender.id !== browser.runtime.id ||
      message?.channel !== "leximeet-page" ||
      (tutorialTabId !== undefined && message.targetTabId !== tutorialTabId)
    )
      return;
    return replyAsync(
      sendResponse,
      (async () => {
        try {
          let result: unknown = true;
          switch (message.action) {
            case "invalidate":
              ++scanVersion;
              stop(message.data.reason);
              occurrences = [];
              draw();
              break;
            case "capture-result":
              if (message.data.status === "confirmed") collected.clear();
              if (["confirmed", "partial", "pending"].includes(message.data.status))
                showNotice(captureResultNotice(message.data.status));
              break;
            case "guide-changed":
              void tutorial.refresh();
              break;
            case "theme":
              host.dataset.theme = message.data.theme;
              break;
            case "ping":
              // worker 可能已被 MV3 回收；幂等 hello 只重建后台映射，不向网页发送私人状态。
              const hello = await request("hello", { generation });
              panelVisible = hello.visible === true;
              // 初次初始化被 worker 回收打断时，后续握手也能恢复默认入口。
              if (!floatingReady) {
                floating = await request("floating-config");
                floatingReady = true;
              }
              applyFloating(floating);
              if (hello.resetSession) {
                ++scanVersion;
                occurrences = [];
                selected = null;
                collected.clear();
                // 空闲页的拖拽查词不依赖旧遇见 Range，握手恢复不能取消这次新手势。
                if (mode !== "idle") stop("页面会话已恢复，请重新分析");
                draw();
              }
              break;
            case "capture-start":
              enterCapture();
              break;
            case "scan": {
              const pending = scan(
                  message.data.mode,
                  message.data.preserveSurface === true,
                ),
                version = scanVersion;
              try {
                await pending;
              } catch (error) {
                if (version === scanVersion) throw error;
              }
              break;
            }
            case "select":
              selectedOccurrence(message.data.id, true);
              break;
            case "collect":
              result = await collect(selectedOccurrence(message.data.id));
              break;
            case "end":
              ++scanVersion;
              stop(message.data.reason);
              // 只有归属明确切换才丢旧意图；普通租期失效或短时失联仍保留原待确认事件。
              if (message.data.ownershipChanged) {
                cardCaptures.clear();
                collector?.clearOwnership();
              }
              if (message.data.clearEncounter) {
                occurrences = [];
                selected = null;
                collected.clear();
              }
              draw();
              break;
            case "visibility":
              // 浮球与侧栏共存；只更新右键动作，保留正在进行的拖拽采词。
              panelVisible = message.data.visible === true;
              applyFloating(floating);
              tutorial.update();
              if (message.data.visible === false && mode === "capture")
                stop("侧栏已关闭，网页已恢复");
              break;
            case "floating-preferences":
              applyFloating(message.data);
              break;
            case "lease":
              if (mode === "capture") leaseUntil = Date.now() + 6000;
              break;
            case "removed":
              collected.delete(message.data.id);
              draw();
              break;
            default:
              throw new Error("未知网页操作");
          }
          return { ok: true, result };
        } catch (error) {
          stop((error as Error).message);
          return { ok: false, error: (error as Error).message };
        }
      })(),
    );
  };
  browser.runtime.onMessage.addListener(listener);
  // 只关注已建立 Range 的正文节点；异步广告等无关变动不触发全页重扫。
  const observer = new MutationObserver(() => {
    if (!["encounter", "capture"].includes(mode)) return;
    if (
      occurrences.some(
        (item) =>
          !item.range.startContainer.isConnected ||
          item.range.toString() !== item.surface,
      )
    ) {
      ++scanVersion;
      if (mode === "capture") {
        occurrences = occurrences.filter(
          (item) =>
            item.range.startContainer.isConnected &&
            item.range.toString() === item.surface,
        );
        return;
      }
      stop("网页正文已变化，请重新分析；草稿保留");
      occurrences = [];
      draw();
      void request("invalidated").catch(() => {});
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  const leaseTimer = setInterval(() => {
    if (mode === "capture" && Date.now() > leaseUntil)
      void cancel("侧栏控制连接已失效，网页已自动恢复");
  }, 1000);
  let lastLocation = pageLocationKey(location.href);
  function resetForNavigation(reason: string) {
    const next = pageLocationKey(location.href);
    if (next) lastLocation = next;
    ++scanVersion;
    occurrences = [];
    collected.clear();
    selected = null;
    stop(reason);
    draw();
    void request("navigated", {
      title: document.title.slice(0, 300),
      reason,
    }).catch(() => {});
  }
  function onSoftNavigation() {
    const next = pageLocationKey(location.href);
    if (!next || next === lastLocation) return;
    resetForNavigation("页面已软导航，旧位置已失效，请重新分析");
  }
  const navigationApi = (window as any).navigation;
  if (navigationApi?.addEventListener) {
    try {
      navigationApi.addEventListener("currententrychange", onSoftNavigation, {
        signal: lifetime.signal,
      });
    } catch {
      window.addEventListener("popstate", onSoftNavigation, {
        signal: lifetime.signal,
      });
    }
  } else {
    window.addEventListener("popstate", onSoftNavigation, {
      signal: lifetime.signal,
    });
    window.addEventListener("hashchange", onSoftNavigation, {
      signal: lifetime.signal,
    });
  }
  window.addEventListener(
    "pagehide",
    (event) => {
      if ((event as PageTransitionEvent).persisted)
        resetForNavigation("页面已进入往返缓存，采集已结束");
      else stop("页面已离开");
    },
    { signal: lifetime.signal },
  );
  window.addEventListener(
    "pageshow",
    (event) => {
      if (!(event as PageTransitionEvent).persisted) return;
      void request("hello", { generation })
        .then(() => resetForNavigation("已从往返缓存恢复，请重新分析"))
        .catch((error) => showNotice((error as Error).message));
    },
    { signal: lifetime.signal },
  );
  ctx.onInvalidated(() => {
    ++scanVersion;
    stop("扩展已重新加载");
    stopSpeech();
    clearInterval(leaseTimer);
    collector?.dispose();
    clearTimeout(tipLeave);
    observer.disconnect();
    lifetime.abort();
    browser.runtime.onMessage.removeListener(listener);
    tutorial.dispose();
    picking.dispose();
    host.remove();
    highlightsStyle.remove();
    if (supportsHighlight)
      for (const name of highlightNames) (CSS as any).highlights.delete(name);
    delete global.__leximeetPage;
  });
  placeBall(defaultBallPosition(viewportSize()));
  void request("hello", { generation })
    .then(async (result) => {
      host.dataset.theme = result.theme || "system";
      panelVisible = result.visible === true;
      const preferences = await request("floating-config");
      floatingReady = true;
      applyFloating(preferences);
      void tutorial.refresh();
    })
    .catch((error) => showNotice(error.message));
  return {
    dismissGuide: () => tutorial.dismiss(),
    openWorkspace: () => request("open-options"),
  };
}
