<script setup lang="ts">
import { learningPreview, learningLibrary } from "../../lib/learning-workspace.ts";
import { computed, ref, watch } from "vue";
import Dialog from "./Dialog.vue";
import Icon from "../Icon.vue";
import { useWorkspace } from "./useWorkspace.ts";
const props = defineProps<{ adjust?: boolean; sourceId?: string }>(),
  emit = defineEmits<{ close: [] }>();
const ctx = useWorkspace(),
  { catalogs, plan, dictionary, members, words, encounters, reviews, targetName } = ctx;
// 编辑依据锁定在打开窗口时；其他窗口更新后必须重新打开，不能静默覆盖。
const expectedRevision = plan.value?.revision ?? 0;
const stage = ref<"target" | "schedule">(props.adjust ? "schedule" : "target");
const kind = ref<"catalog" | "dictionary">(
    props.sourceId === "active-dictionary" ||
      (props.adjust && plan.value?.sourceKind === "dictionary")
      ? "dictionary"
      : "catalog",
  ),
  source = ref(
    props.sourceId && props.sourceId !== "active-dictionary"
      ? props.sourceId
      : props.adjust && plan.value?.sourceKind === "catalog"
        ? plan.value.sourceId
        : "",
  ),
  category = ref("exam"),
  search = ref(""),
  dailyNew = ref(plan.value?.dailyNew || 10),
  dailyReview = ref(plan.value?.dailyReview ?? 20),
  count = ref(members.value.length),
  previewMembers = ref(members.value),
  previewLoading = ref(false),
  busy = ref(false),
  error = ref("");
const validNewQuota = computed(
  () =>
    Number.isInteger(dailyNew.value) &&
    dailyNew.value >= 1 &&
    (dailyNew.value <= 50 || (!!props.adjust && dailyNew.value === plan.value?.dailyNew)),
);
const selectedName = computed(() =>
  kind.value === "dictionary"
    ? `${dictionary.value?.active === "core-text" ? "Core" : "Lite"} Text`
    : catalogs.value.find((c) => c.id === source.value)?.title || "",
);
const hasTarget = computed(() => kind.value === "dictionary" || !!source.value);
const books = computed(() =>
  catalogs.value.filter((c) =>
    search.value
      ? `${c.title} ${c.source}`.toLowerCase().includes(search.value.toLowerCase())
      : c.category === category.value,
  ),
);
const previewItems = computed(() =>
  learningLibrary(
    previewMembers.value,
    words.value,
    encounters.value,
    reviews.value,
    ctx.attempts.value,
    ctx.now.value,
  ).filter((item) => item.inTarget),
);
const total = computed(() => previewItems.value.length);
const forecast = computed(() =>
  learningPreview(previewItems.value, ctx.attempts.value, {
    ...plan.value,
    dailyNew: Number(dailyNew.value),
    timeZone:
      plan.value?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  }),
);
let previewGeneration = 0;
watch(
  [kind, source],
  async () => {
    const generation = ++previewGeneration;
    if (!hasTarget.value) {
      previewMembers.value = [];
      count.value = 0;
      previewLoading.value = false;
      return;
    }
    previewLoading.value = true;
    error.value = "";
    count.value =
      kind.value === "dictionary"
        ? dictionary.value?.active === "core-text"
          ? 117902
          : 26417
        : catalogs.value.find((c) => c.id === source.value)?.count || 0;
    try {
      const selected =
        kind.value === "dictionary"
          ? ctx.allMembers.value
          : await ctx.lexicon.catalogMembers(source.value);
      if (generation === previewGeneration) previewMembers.value = selected;
    } catch (e) {
      if (generation === previewGeneration) error.value = (e as Error).message;
    } finally {
      if (generation === previewGeneration) previewLoading.value = false;
    }
  },
  { immediate: true },
);
async function save() {
  if (kind.value === "catalog" && !source.value) {
    error.value = "请选择一本主题词库";
    return;
  }
  busy.value = true;
  const ok = await ctx.savePlan(
    kind.value,
    kind.value === "dictionary" ? "active-dictionary" : source.value,
    Number(dailyNew.value),
    Number(dailyReview.value),
    expectedRevision,
  );
  busy.value = false;
  if (ok) emit("close");
  else error.value = ctx.error.value;
}
</script>
<template>
  <Dialog
    :title="adjust ? '调整学习计划' : plan ? '更换学习目标' : '设置学习规划'"
    :wide="false"
    @close="emit('close')"
    ><ol v-if="!adjust" class="v3-planning-steps" aria-label="学习规划步骤">
      <li :aria-current="stage === 'target' ? 'step' : undefined">
        <span>1</span>选择学习目标
      </li>
      <li :aria-current="stage === 'schedule' ? 'step' : undefined">
        <span>2</span>设置学习计划
      </li>
    </ol>
    <div class="v3-plan-wizard" :data-plan-step="stage">
      <section v-if="stage === 'target'">
        <nav class="v3-tabs" aria-label="学习目标类型">
          <button
            :class="{ active: kind === 'catalog' }"
            :aria-pressed="kind === 'catalog'"
            @click="kind = 'catalog'"
          >
            主题词库</button
          ><button
            :class="{ active: kind === 'dictionary' }"
            :aria-pressed="kind === 'dictionary'"
            @click="kind = 'dictionary'"
          >
            本地词典
          </button>
        </nav>
        <template v-if="kind === 'catalog'"
          ><div class="v3-segmented">
            <button :aria-pressed="category === 'exam'" @click="category = 'exam'">
              考试</button
            ><button :aria-pressed="category === 'subject'" @click="category = 'subject'">
              专业
            </button>
          </div>
          <input
            v-model="search"
            type="search"
            aria-label="搜索考试与专业词书"
            placeholder="搜索考试与专业词书"
          />
          <div class="v3-target-list" data-guide="target-list">
            <button
              v-for="book in books"
              :key="book.id"
              :aria-pressed="source === book.id"
              @click="source = book.id"
            >
              <strong>{{ book.title }}</strong
              ><small>{{ book.count.toLocaleString() }} 词</small>
            </button>
          </div></template
        ><button
          v-else
          class="v3-local-choice"
          data-guide="target-list"
          aria-pressed="true"
        >
          <strong>{{
            dictionary?.active === "core-text" ? "Core Text" : "Lite Text"
          }}</strong
          ><small>当前词典 · {{ count.toLocaleString() }} 词</small>
        </button>
      </section>
      <section v-if="stage === 'schedule'">
        <p class="v3-plan-current-target">
          <Icon name="book-2" />{{ selectedName || targetName }}
        </p>
        <h3>每天的安排</h3>
        <div data-guide="plan-settings">
          <label class="v3-setting-row"
            >每天学习<input
              v-model.number="dailyNew"
              type="number"
              min="1"
              max="50"
              aria-label="每天学习新词数"
            />词</label
          ><label class="v3-setting-row"
            >每天复习<input
              v-model.number="dailyReview"
              type="number"
              min="0"
              max="500"
              aria-label="每天复习词数"
            />词</label
          >
        </div>
        <div class="v3-forecast">
          <strong
            >{{ total.toLocaleString() }} 词 · 剩余
            {{ forecast.remaining.toLocaleString() }} 新词 ·
            {{ forecast.days }} 天</strong
          ><small>新词安排 · 到期复习按每日上限进入</small>
          <p v-for="day in forecast.firstDays.slice(0, 5)" :key="day.day">
            <span>{{ day.day }}</span
            ><span>{{ day.count }} 新词</span>
          </p>
        </div>
      </section>
    </div>
    <p v-if="!adjust && plan" class="v3-plan-replacement">
      保存后替换当前学习规划，旧规划不提供恢复；已学记录与采集内容保留。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <footer class="v3-dialog-actions">
      <button
        v-if="stage === 'schedule' && !adjust"
        class="v3-secondary"
        :disabled="busy"
        @click="stage = 'target'"
      >
        上一步
      </button>
      <button v-else class="v3-secondary" @click="emit('close')">取消</button
      ><button
        v-if="stage === 'target'"
        class="mg-primary"
        data-guide="target-next"
        :disabled="!hasTarget || busy || previewLoading || !!error"
        @click="stage = 'schedule'"
      >
        下一步：每天学多少<Icon name="arrow-right" />
      </button>
      <button
        v-else
        data-guide="plan-save"
        class="mg-primary"
        :disabled="
          busy ||
          previewLoading ||
          !!error ||
          !validNewQuota ||
          dailyReview < 0 ||
          dailyReview > 500 ||
          !Number.isInteger(dailyNew) ||
          !Number.isInteger(dailyReview)
        "
        @click="save"
      >
        <Icon name="check" />{{ adjust ? "保存学习计划" : "保存学习规划" }}
      </button>
    </footer></Dialog
  >
</template>
