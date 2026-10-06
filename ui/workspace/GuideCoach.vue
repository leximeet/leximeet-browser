<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useOnboardingGuide } from "./useOnboardingGuide.ts";
import GuideFireworks from "./GuideFireworks.vue";
import { coachmarkLayout, type CoachRect } from "../../lib/coachmark-layout.ts";
import { draggableCoach, type CoachPoint } from "../../lib/coachmark-drag.ts";
const position = ref<CoachPoint>(),
  collapsed = ref(false),
  handle = ref<HTMLElement>();
let detachDrag: (() => void) | undefined;
const props = defineProps<{
  surface: "panel" | "workspace" | "welcome";
  tab?: string;
  capturing?: boolean;
  drafts?: number;
  tutorialPage?: boolean;
  encounterReady?: boolean;
}>();
const emit = defineEmits<{ skip: [] }>();
const { state, step, copy, error, celebrate, act } = useOnboardingGuide();
const marker = ref<CoachRect>({ x: 0, y: 0, width: 0, height: 0 }),
  layout = ref(
    coachmarkLayout(
      marker.value,
      { width: 360, height: 850 },
      { width: 280, height: 175 },
    ),
  ),
  bubble = ref<HTMLElement>(),
  portal = ref<HTMLElement | null>(null),
  theme = ref("light"),
  hint = ref({ title: "", body: "", selector: "", external: false });
const away = computed(() => props.surface === "panel" && !props.tutorialPage);
const pageOwnsStep = computed(
  () =>
    props.surface === "panel" &&
    !away.value &&
    ((step.value === "encounter" &&
      state.value.encounterAnalyzed &&
      props.encounterReady) ||
      (step.value === "capture" && props.capturing && !props.drafts)),
);
const shown = computed(() => state.value.active && !pageOwnsStep.value);
const returning = computed(
  () =>
    props.surface !== "panel" &&
    ["panel", "encounter", "capture", "floating"].includes(step.value),
);
let timer: ReturnType<typeof setInterval>;
function update() {
  // 跳过或完成教学后不再查询布局；进度变化仍由存储通知唤醒。
  if (!shown.value && !celebrate.value) return;
  let title: string = copy.value.title,
    body: string = copy.value.body,
    selector = "",
    external = false;
  const find = (name: string) => `[data-guide="${name}"]`;
  if (away.value) {
    title = "继续使用教学";
    body = "回到词遇内置阅读页，接着完成实际操作。";
  } else if (step.value === "pin" || step.value === "panel") {
    external = true;
    body =
      step.value === "pin"
        ? "点击浏览器右上角的扩展按钮，找到词遇并点图钉。"
        : "回到英文网页，点击刚固定的词遇图标。";
  } else if (props.surface === "panel") {
    if (step.value === "plan") {
      selector = find("manage");
      body = "打开管理页，先选择一本词书，再安排每天学多少。";
    }
    if (step.value === "encounter") {
      selector = find(props.tab === "encounter" ? "analyze" : "encounter-tab");
      body = "在遇见中分析本页，找到目标与已采集的词。";
    }
    if (step.value === "capture") {
      if (props.tab !== "capture") {
        selector = find("capture-tab");
        body = "切到采集，挑选你想记住的词。";
      } else if (!props.capturing && !props.drafts) {
        selector = find("analyze");
        body = "开始采集，然后直接点击正文中的英文词。";
      } else if (!props.drafts) {
        selector = find("picked-list");
        title = "在网页里摘取一个词";
        body = "点击左边正文中的英文词，它会飞入这里。";
      } else {
        selector = find("join");
        title = "把词加入单词本";
        body = "选好单词本，再点加入；语境会一起保存。";
      }
    }
    if (step.value === "floating") {
      external = true;
      title = "接下来，试试悬浮按钮";
      body = "收起侧栏后，网页会接着带你练习四种操作。也可以点击 Chrome 侧栏最上方的 ×。";
    }
  } else if (step.value === "plan" && props.surface === "workspace") {
    if (document.querySelector('[data-plan-step="target"]')) {
      const selected = document.querySelector(
        `${find("target-list")} [aria-pressed="true"], ${find("target-list")}[aria-pressed="true"]`,
      );
      selector = find(selected ? "target-next" : "target-list");
      title = selected ? "词书已选好，设置每天的安排" : "先选一本想学的词书";
      body = selected
        ? "点击下一步，设置每日新词和复习数量。"
        : "在考试、专业中选一本，也可以选当前本地词典。";
    } else if (document.querySelector('[data-plan-step="schedule"]')) {
      selector = find("plan-settings");
      title = "每天学多少，复习多少";
      body = "调整两个数量，查看预计安排，然后保存学习规划。";
    } else {
      selector = document.querySelector(find("choose-target"))
        ? find("choose-target")
        : find("plan-nav");
      body = "打开学习规划，选择主题词库或当前本地词典。";
    }
  } else if (returning.value) {
    selector = find("guide-return");
    body = "计划已就绪。回到原来的英文网页，继续实际操作。";
  }
  hint.value = { title, body, selector, external };
  const target = selector ? document.querySelector<HTMLElement>(selector) : null;
  const bounds = target?.getBoundingClientRect();
  marker.value = bounds
    ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    : {
        x: innerWidth - 80,
        y: away.value ? innerHeight - 12 : 8,
        width: 24,
        height: 12,
      };
  portal.value = target?.closest<HTMLDialogElement>("dialog[open]") || null;
  theme.value =
    document.querySelector<HTMLElement>(".app[data-theme]")?.dataset.theme || "light";
  // 有空间时将教学放到整个弹窗旁边，避免遮住候选词书、配额或规划表。
  const dialogBounds = portal.value?.getBoundingClientRect();
  const avoid = dialogBounds
    ? [
        {
          x: dialogBounds.x,
          y: dialogBounds.y,
          width: dialogBounds.width,
          height: dialogBounds.height,
        },
      ]
    : [];
  layout.value = coachmarkLayout(
    marker.value,
    { width: innerWidth, height: innerHeight },
    {
      width: props.surface === "panel" ? 278 : 304,
      height: bubble.value?.offsetHeight || 192,
    },
    avoid,
    position.value,
  );
}
async function skip() {
  await act("guide-pause");
  emit("skip");
}
watch(
  step,
  () => {
    position.value = undefined;
    update(); // 阶段文本与目标同时交接，避免短暂保留上一步的箭头。
  },
  { flush: "post" },
);
watch([shown, celebrate], update);
watch(bubble, (box) => {
  detachDrag?.();
  if (box && handle.value)
    detachDrag = draggableCoach(handle.value, box, (point) => {
      position.value = point;
      update();
    });
});
onMounted(() => {
  update();
  timer = setInterval(() => {
    if (document.visibilityState === "visible" && shown.value) update();
  }, 200);
  window.addEventListener("resize", update);
  window.addEventListener("scroll", update, true);
});
onUnmounted(() => {
  detachDrag?.();
  clearInterval(timer);
  window.removeEventListener("resize", update);
  window.removeEventListener("scroll", update, true);
});
</script>
<template>
  <Teleport :to="portal || 'body'">
    <div v-if="!shown && celebrate" class="v3-coach-layer app v3-app" :data-theme="theme">
      <GuideFireworks />
    </div>
    <div v-if="shown" class="v3-coach-layer app v3-app" :data-theme="theme">
      <svg
        v-show="!collapsed && hint.selector && !hint.external"
        class="v3-coach-connector"
        aria-hidden="true"
      >
        <defs>
          <marker
            id="guide-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="6"
            refY="4"
            orient="auto"
          >
            <path
              d="M 0 0 L 8 4 L 0 8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            />
          </marker>
        </defs>
        <rect
          v-if="!hint.external && hint.selector"
          :x="marker.x - 4"
          :y="marker.y - 4"
          :width="marker.width + 8"
          :height="marker.height + 8"
          rx="8"
          class="v3-coach-ring"
        />
        <path :d="layout.path" marker-end="url(#guide-arrow)" />
      </svg>
      <section
        ref="bubble"
        class="v3-live-coach"
        :data-step="step"
        :data-collapsed="collapsed"
        :data-anchor="hint.selector || 'browser-toolbar'"
        aria-label="真实操作引导"
        :style="{
          left: layout.box.x + 'px',
          top: layout.box.y + 'px',
          width: layout.box.width + 'px',
        }"
      >
        <GuideFireworks v-if="celebrate" />
        <header ref="handle">
          <small>词遇指引 · {{ Math.min(state.completed.length + 1, 6) }} / 6</small>
          <div class="v3-coach-tools">
            <button
              type="button"
              :aria-label="collapsed ? '展开教学' : '收起教学'"
              @click="
                collapsed = !collapsed;
                update();
              "
            >
              {{ collapsed ? "+" : "−" }}
            </button>
          </div>
        </header>
        <div v-show="!collapsed">
          <strong>{{ hint.title }}</strong>
          <p>{{ hint.body }}</p>
          <div class="v3-coach-actions">
            <button
              v-if="surface === 'panel' && !away && step === 'floating'"
              type="button"
              class="v3-coach-primary"
              @click="act('guide-collapse')"
            >
              收起侧栏，继续教学 →
            </button>
            <button
              v-if="step === 'pin' && !away"
              type="button"
              @click="act('guide-pinning')"
            >
              在 Chrome 扩展设置中固定 ↗
            </button>
            <button
              v-if="away || (returning && surface === 'welcome')"
              type="button"
              @click="act('guide-reading')"
            >
              {{ away ? "回到教学页 →" : "返回阅读页 →" }}
            </button>
            <button type="button" @click="skip">跳过引导</button>
          </div>
          <small v-if="error" role="alert">{{ error }}</small>
        </div>
      </section>
    </div>
  </Teleport>
</template>
