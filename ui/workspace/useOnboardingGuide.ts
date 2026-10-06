import { onMounted, onUnmounted, ref, computed, watch } from "vue";
import { browser } from "wxt/browser";
import { call } from "../api.ts";
import {
  emptyGuide,
  guideStep,
  GUIDE_STORAGE_KEY,
  type GuideState,
} from "../../lib/onboarding-guide.ts";

export const GUIDE_COPY = {
  pin: {
    title: "把词遇固定到工具栏",
    body: "点击地址栏右侧的扩展按钮，找到词遇，再点击图钉。",
  },
  panel: {
    title: "在网页上打开词遇侧栏",
    body: "回到英文网页，点击工具栏上刚固定的词遇图标。",
  },
  plan: {
    title: "设置学习规划",
    body: "打开管理，先选一本词书，再设置每日新词和复习数量。",
  },
  encounter: {
    title: "遇见目标里的单词",
    body: "回到网页，在真实侧栏的「遇见」页点击「分析本页」，查看文章中的高亮和词卡。",
  },
  capture: {
    title: "采集第一次真实语境",
    body: "切到「采集」，点击「开始采集」，悬停看清词形，点网页里的一个英文词，然后加入单词本。",
  },
  floating: {
    title: "收起侧栏，试试悬浮球",
    body: "收起侧栏，继续练习开启遇见、取消遇见、拖拽采词和右键打开侧栏四种操作。",
  },
  complete: {
    title: "准备好，去遇见",
    body: "目标、网页和语境已经连在一起。现在开始按自己的节奏学习。",
  },
} as const;

// 多个真实界面订阅同一份后台进度，UI 按钮不能自行把步骤标为成功。
export function useOnboardingGuide() {
  const state = ref<GuideState>(emptyGuide()),
    error = ref(""),
    celebrate = ref(false);
  let poll: ReturnType<typeof setInterval> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const step = computed(() => guideStep(state.value)),
    copy = computed(() => GUIDE_COPY[step.value]);
  async function refresh() {
    try {
      state.value = await call<GuideState>("guide-state");
      error.value = "";
    } catch (e) {
      error.value = (e as Error).message;
    }
  }
  async function act(
    action:
      | "guide-reading"
      | "guide-pinning"
      | "guide-overview"
      | "guide-pause"
      | "guide-collapse",
  ) {
    try {
      // 返回遇见/采集时，按钮手势直接打开窗口级侧栏，再由后台切回绑定阅读页。
      // 不能等 tabs.update/存储请求结束后才调用 open，也不能由计时器自动打开。
      const opening =
        action === "guide-reading" &&
        ["encounter", "capture"].includes(step.value) &&
        state.value.windowId !== null
          ? browser.sidePanel.open({ windowId: state.value.windowId })
          : Promise.resolve();
      if (action === "guide-collapse") {
        await call("close", {}, state.value.windowId ?? undefined);
        return; // 原生侧栏即将销毁；后续批注由网页接手。
      }
      await Promise.all([opening, call(action)]);
      await refresh();
      if (action === "guide-pause") {
        clearTimeout(timer);
        celebrate.value = false;
      }
    } catch (e) {
      error.value = (e as Error).message;
    }
  }
  const changed = (changes: Record<string, unknown>, area: string) => {
    if (area === "local" && changes[GUIDE_STORAGE_KEY]) void refresh();
  };
  watch(
    () => state.value.completed.length,
    (count, before) => {
      // 最后一次右键可能重新创建侧栏；新面板也应显示刚完成的庆祝，旧进度不重复播放。
      const elapsed = Date.now() - (state.value.advancedAt || 0);
      if (count <= before || elapsed < 0 || elapsed > 2500) return;
      celebrate.value = true;
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          celebrate.value = false;
        },
        Math.max(100, 2500 - elapsed),
      );
    },
  );
  onMounted(() => {
    void refresh();
    browser.storage.onChanged.addListener(changed);
    poll = setInterval(() => {
      // 不活跃时依靠 storage.onChanged 响应重新进入，避免常驻请求。
      if (document.visibilityState === "visible" && (state.value.active || error.value))
        void refresh();
    }, 1500);
  });
  onUnmounted(() => {
    clearInterval(poll);
    clearTimeout(timer);
    browser.storage.onChanged.removeListener(changed);
  });
  return { state, step, copy, error, celebrate, refresh, act };
}
