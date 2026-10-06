<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkspace } from "./useWorkspace.ts";
import Dialog from "./Dialog.vue";
import Icon from "../Icon.vue";
import { PRACTICE_LABELS } from "../../lib/practice-session.ts";
import { practiceInsights, learningTrend } from "../../lib/learning-insights.ts";
const ctx = useWorkspace(),
  { items, encounters, reviews, attempts, preferences } = ctx,
  config = ref(false),
  selection = ref<string[]>([]);
const events = computed(() =>
  attempts.value.flatMap((attempt) => (attempt.learning ? [attempt.learning] : [])),
);
const practice = computed(() => practiceInsights(events.value, ctx.now.value));
const metrics = computed(() => {
  return [
    {
      id: "learned",
      title: "学习词数",
      value: items.value.filter((i) => i.familiarity?.graduatedAt).length,
      note: "已完成初学的活动词",
    },
    {
      id: "encounters",
      title: "遇见语境",
      value: encounters.value.filter((e) => !e.undoneAt).length,
      note: "实际保存的网页语境",
    },
    {
      id: "practice",
      title: "练习次数",
      value: practice.value.operations,
      note: "实际作答，含辅助与订正，不含仅揭示",
    },
    {
      id: "accuracy",
      title: "独立答题正确率",
      value: practice.value.independentAnswers
        ? `${Math.round((practice.value.independentCorrect / practice.value.independentAnswers) * 100)}%`
        : "—",
      note: "首次独立答对 / 作答，不含临摹与列表",
    },
    {
      id: "library",
      title: "我的词库",
      value: items.value.length,
      note: "当前词库中的活动词条",
    },
    {
      id: "due",
      title: "到期复习",
      value: items.value.filter(
        (i) =>
          i.status === "review" &&
          i.dueAt &&
          Date.parse(i.dueAt) <= ctx.now.value.getTime(),
      ).length,
      note: "学习规则与 FSRS 共同计算",
    },
  ];
});
const trend = computed(() =>
  learningTrend(
    events.value,
    encounters.value,
    ctx.now.value,
    ctx.plan.value?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  ),
);
const maximum = computed(() =>
  Math.max(1, ...trend.value.map((t) => Math.max(t.learning, t.encounters))),
);
const difficult = computed(() => {
  const counts = new Map<string, number>();
  for (const r of reviews.value)
    if (!r.undoneAt && r.rating === "again")
      counts.set(r.wordId, (counts.get(r.wordId) || 0) + 1);
  return items.value
    .filter((i) => i.personal && counts.has(i.personal.id))
    .sort((a, b) => counts.get(b.personal!.id)! - counts.get(a.personal!.id)!)
    .slice(0, 8)
    .map((i) => ({ ...i, count: counts.get(i.personal!.id) }));
});
</script>
<template>
  <section class="v3-insights">
    <div class="v3-actions">
      <button
        class="v3-secondary"
        @click="
          selection = [...preferences.insights];
          config = true;
        "
      >
        <Icon name="adjustments-horizontal" />自定义指标
      </button>
    </div>
    <div class="v3-insight-metrics">
      <article
        v-for="m in metrics.filter((m) => preferences.insights.includes(m.id))"
        :key="m.id"
      >
        <small>{{ m.title }}</small
        ><strong>{{
          typeof m.value === "number" ? m.value.toLocaleString() : m.value
        }}</strong
        ><span>{{ m.note }}</span>
      </article>
    </div>
    <div class="v3-insight-panels">
      <section class="v3-insight-panel">
        <header>
          <h2>近 14 天</h2>
          <small>学习反馈 / 遇见语境</small>
        </header>
        <div class="v3-trend-bars">
          <div
            v-for="t in trend"
            :key="t.day"
            :title="`${t.day} · 学习 ${t.learning} · 遇见 ${t.encounters}`"
          >
            <div>
              <span :style="{ height: `${(t.learning / maximum) * 100}%` }" /><i
                :style="{ height: `${(t.encounters / maximum) * 100}%` }"
              />
            </div>
            <small>{{ t.day.slice(5) }}</small>
          </div>
        </div>
      </section>
      <section class="v3-insight-panel">
        <h2>练习表现</h2>
        <div v-for="[mode, label] in PRACTICE_LABELS" :key="mode" class="v3-setting-row">
          <strong>{{ label }}</strong
          ><small
            >{{ practice.byMode[mode].operations }} 次作答<span
              v-if="practice.byMode[mode].independentMode"
            >
              · 独立答对 {{ practice.byMode[mode].independentCorrect }}/{{
                practice.byMode[mode].independentAnswers
              }}</span
            ></small
          >
        </div>
      </section>
      <section class="v3-insight-panel">
        <h2>需要多一次重逢</h2>
        <p v-for="i in difficult" :key="i.key">
          <strong>{{ i.word }}</strong
          ><small>再想想 {{ i.count }} 次</small>
        </p>
        <p v-if="!difficult.length" class="v3-muted">
          有真实学习评价后，会显示需要加强的词。
        </p>
      </section>
      <section class="v3-insight-panel">
        <h2>词库状态</h2>
        <div
          v-for="[status, label] in [
            ['new', '未学'],
            ['learning', '学习中'],
            ['review', '待复习'],
            ['mastered', '已熟悉'],
          ]"
          :key="status"
          class="v3-setting-row"
        >
          <strong>{{ label }}</strong
          ><span>{{
            items.filter((i) => i.status === status).length.toLocaleString()
          }}</span>
        </div>
      </section>
    </div>
    <Dialog v-if="config" title="自定义洞察指标" @close="config = false"
      ><label v-for="m in metrics" :key="m.id" class="v3-check-row"
        ><input v-model="selection" type="checkbox" :value="m.id" />{{ m.title }}</label
      >
      <footer class="v3-dialog-actions">
        <button class="v3-secondary" @click="config = false">取消</button
        ><button
          class="mg-primary"
          @click="
            ctx.savePreferences({ ...preferences, insights: selection }).then((ok) => {
              if (ok) config = false;
            })
          "
        >
          保存指标
        </button>
      </footer></Dialog
    >
  </section>
</template>
