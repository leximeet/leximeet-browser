<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { learningActivity, learningForecast } from "../../lib/learning-forecast.ts";
import { useWorkspace } from "./useWorkspace.ts";
import Icon from "../Icon.vue";
const ctx = useWorkspace();
const emit = defineEmits<{ adjust: [] }>();
const offset = ref(0),
  previewDaily = ref(ctx.plan.value!.dailyNew);
const actual = computed(() =>
  learningForecast(ctx.items.value, ctx.attempts.value, ctx.plan.value!, ctx.now.value),
);
const model = computed(() =>
  learningForecast(
    ctx.items.value,
    ctx.attempts.value,
    ctx.plan.value!,
    ctx.now.value,
    previewDaily.value,
  ),
);
const activity = computed(() =>
  learningActivity(ctx.items.value, ctx.attempts.value, ctx.plan.value!, ctx.now.value),
);
const quotas = computed(() =>
  [...new Set([ctx.plan.value!.dailyNew, 5, 10, 20])].sort((a, b) => a - b),
);
const scenarios = computed(() =>
  quotas.value.map((daily) => ({
    ...learningForecast(
      ctx.items.value,
      ctx.attempts.value,
      ctx.plan.value!,
      ctx.now.value,
      daily,
    ),
  })),
);
const historyMax = computed(() =>
  Math.max(1, ...activity.value.history.map((day) => day.count)),
);
const reviewMax = computed(() =>
  Math.max(1, ...activity.value.review.map((day) => day.count)),
);
const percent = computed(() => {
  const value = actual.value.total
    ? (100 * actual.value.completed) / actual.value.total
    : 0;
  return value > 0 && value < 1 ? "<1" : Math.round(value);
});
const preview = computed(() => model.value.preview(offset.value));
const today = computed(() => [
  ...new Map(
    [...ctx.daily.value.encountered, ...ctx.daily.value.planned]
      .filter((item) => !item.familiarity?.graduatedAt)
      .map((item) => [item.key, item]),
  ).values(),
]);
const shortDate = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8))}`;
function compare(daily: number) {
  previewDaily.value = daily;
  offset.value = 0;
}
watch(
  () => [ctx.plan.value?.id, ctx.plan.value?.dailyNew],
  () => {
    previewDaily.value = ctx.plan.value!.dailyNew;
    offset.value = 0;
  },
);
watch(
  () => model.value.days,
  (days) => (offset.value = Math.min(offset.value, Math.max(0, days - 1))),
);
</script>
<template>
  <section class="v3-learning-forecast" aria-label="学习预测面板">
    <header class="forecast-overview">
      <div>
        <small class="forecast-eyebrow">目标进展</small>
        <h2>
          {{ actual.completed.toLocaleString() }}
          <span>/ {{ actual.total.toLocaleString() }} 词完成初学</span>
        </h2>
        <p>练习可以反复进行；完成作答与完成初学分别统计。</p>
      </div>
      <div class="forecast-percentage">
        <strong>{{ percent }}<span>%</span></strong
        ><small>{{ ctx.plan.value?.paused ? "计划已暂停" : "目标初学完成率" }}</small>
      </div>
    </header>
    <div
      class="forecast-state-bar"
      role="img"
      :aria-label="
        actual.states.map((state) => state.label + state.count + '词').join('，')
      "
    >
      <span
        v-for="state in actual.states.filter((state) => state.count)"
        :key="state.id"
        :class="state.id"
        :style="{ flexGrow: state.count }"
        :title="`${state.label} · ${state.count} 词`"
      ></span>
    </div>
    <dl class="forecast-state-legend">
      <div v-for="state in actual.states" :key="state.id">
        <dt><i :class="state.id"></i>{{ state.label }}</dt>
        <dd>{{ state.count.toLocaleString() }} <small>词</small></dd>
      </div>
    </dl>
    <div class="forecast-data-panels">
      <article class="forecast-data" aria-label="实际作答节奏">
        <header>
          <h3>最近14天 · 实际作答</h3>
          <small>{{ activity.activeDays }} 天有练习</small>
        </header>
        <p class="forecast-data-number">
          <strong>{{ activity.practiced }}</strong> 个词
          <span>今天作答 {{ activity.todayAnswered }} 词</span>
        </p>
        <div
          v-if="activity.activeDays"
          class="forecast-bars history"
          role="img"
          :aria-label="
            activity.history
              .map((day) => `${day.day} 作答${day.count}词，共${day.operations}次`)
              .join('；')
          "
        >
          <div
            v-for="(day, index) in activity.history"
            :key="day.day"
            :class="{ 'is-today': index === 13 }"
          >
            <div class="forecast-bar-track">
              <span
                :style="{ height: Math.max(2, (100 * day.count) / historyMax) + '%' }"
                :class="{ empty: !day.count }"
                ><span class="forecast-bar-tooltip"
                  >{{ shortDate(day.day) }} · {{ day.count }} 词 /
                  {{ day.operations }} 次</span
                ></span
              >
            </div>
            <small>{{
              [0, 6, 13].includes(index)
                ? index === 13
                  ? "今天"
                  : shortDate(day.day)
                : ""
            }}</small>
          </div>
        </div>
        <div v-else class="forecast-chart-empty">还没有作答记录</div>
        <p class="forecast-note">
          {{
            activity.activeDays
              ? "全部练习按当天作答词去重；同词反复练习仍计1词。"
              : "开始练习后，会在这里看到真实节奏；查看答案不算作答。"
          }}
        </p>
      </article>
      <article class="forecast-data" aria-label="已知复习安排">
        <header>
          <h3>未来7天 · 已知复习</h3>
          <small>当前排程</small>
        </header>
        <p class="forecast-data-number">
          <strong>{{ activity.reviewTotal }}</strong> 个词
          <span>{{
            ctx.plan.value?.dailyReview
              ? `每日额度 ${ctx.plan.value.dailyReview} 词`
              : "自由复习"
          }}</span>
        </p>
        <div
          v-if="activity.reviewTotal"
          class="forecast-bars review"
          role="img"
          :aria-label="
            activity.review.map((day) => `${day.day} 到期${day.count}词`).join('；')
          "
        >
          <div
            v-for="(day, index) in activity.review"
            :key="day.day"
            :class="{ 'is-today': index === 0 }"
          >
            <div class="forecast-bar-count">{{ day.count }}</div>
            <div class="forecast-bar-track">
              <span
                :style="{ height: Math.max(2, (100 * day.count) / reviewMax) + '%' }"
                :class="{
                  empty: !day.count,
                  crowded:
                    !!ctx.plan.value?.dailyReview &&
                    day.count > ctx.plan.value.dailyReview,
                }"
              ></span>
            </div>
            <small>{{ index === 0 ? "今天" : shortDate(day.day) }}</small>
          </div>
        </div>
        <div v-else class="forecast-chart-empty">暂无到期复习</div>
        <p class="forecast-note">
          {{
            activity.overCapacityDays
              ? `${activity.overCapacityDays} 天的已知到期量超过每日额度，可提前留些时间。`
              : activity.reviewTotal
                ? "逾期词归今天；后续学习会改变这些安排。"
                : "暂无已排程的到期复习，完成初学后会逐步出现。"
          }}
        </p>
      </article>
    </div>
    <section class="forecast-pace" aria-label="每日额度比较">
      <header>
        <div>
          <h3>每天多少词，比较一下</h3>
          <p>
            剩余
            {{ actual.remaining.toLocaleString() }}
            词待初学。只按额度推演，漏学或重复巩固会推迟完成。
          </p>
        </div>
        <button class="v3-secondary" @click="emit('adjust')">修改每日额度</button>
      </header>
      <div class="forecast-pace-options">
        <button
          v-for="scenario in scenarios"
          :key="scenario.daily"
          :aria-pressed="previewDaily === scenario.daily"
          :class="{ selected: previewDaily === scenario.daily }"
          @click="compare(scenario.daily)"
        >
          <span
            >每天 <strong>{{ scenario.daily }}</strong> 词<small>{{
              scenario.daily === ctx.plan.value?.dailyNew ? "当前计划" : "比较方案"
            }}</small></span
          ><strong>{{
            ctx.plan.value?.paused
              ? "已暂停"
              : scenario.days
                ? scenario.days + " 天"
                : "已完成"
          }}</strong
          ><small>{{
            scenario.endOn ? "预计到 " + scenario.endOn : "启用计划后可预览"
          }}</small
          ><small
            v-if="
              scenario.days && actual.days && scenario.daily !== ctx.plan.value?.dailyNew
            "
            >{{
              scenario.days === actual.days
                ? "与当前同日完成"
                : scenario.days < actual.days
                  ? "比当前早 " + (actual.days - scenario.days) + " 天"
                  : "比当前晚 " + (scenario.days - actual.days) + " 天"
            }}</small
          >
        </button>
      </div>
      <p class="forecast-note">
        点击方案仅预览候选；计划仍是每天
        {{ ctx.plan.value?.dailyNew }} 词，调整并保存后才生效。
      </p>
    </section>
    <div class="forecast-word-panels">
      <article aria-label="今天待初学">
        <header>
          <h3>今天待初学</h3>
          <small>{{ today.length }} 词</small>
        </header>
        <div class="forecast-word-chips">
          <span
            v-for="item in today.slice(0, 12)"
            :key="item.key"
            :title="item.meaning"
            >{{ item.word }}</span
          ><small v-if="today.length > 12"
            >还有 {{ today.length - 12 }} 词，练习中心可查看全部</small
          >
          <p v-if="!today.length">今日暂无待初学词，可以继续自由练习。</p>
        </div>
        <small>今天安排复习 {{ ctx.daily.value.review.length }} 词</small>
      </article>
      <article aria-label="候选顺序预览">
        <header>
          <h3>
            候选顺序预览 <small>{{ previewDaily }} 词 / 天</small>
          </h3>
          <div class="forecast-day-controls">
            <button
              class="v3-secondary"
              aria-label="预览前一天"
              :disabled="!offset || !model.days"
              @click="offset--"
            >
              <Icon name="arrow-left" /></button
            ><span>{{ model.dayAt(offset) }}</span
            ><button
              class="v3-secondary"
              aria-label="预览后一天"
              :disabled="offset >= model.days - 1"
              @click="offset++"
            >
              <Icon name="arrow-right" />
            </button>
          </div>
        </header>
        <div class="forecast-word-chips">
          <span
            v-for="item in preview.slice(0, 12)"
            :key="item.key"
            :title="item.meaning"
            >{{ item.word }}</span
          ><small v-if="preview.length > 12">还有 {{ preview.length - 12 }} 词</small>
          <p v-if="!preview.length">
            {{
              ctx.plan.value?.paused
                ? "启用计划后显示候选顺序。"
                : "当天额度已完成或没有剩余候选。"
            }}
          </p>
        </div>
        <small>优先继续已开始的词；实际候选随学习、遇见和回收调整。</small>
      </article>
    </div>
  </section>
</template>
<style scoped>
.v3-learning-forecast {
  margin-top: 24px;
}
.forecast-overview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.forecast-eyebrow {
  color: var(--accent-deep);
  font-size: 12px;
}
.forecast-overview h2 {
  margin: 10px 0 0;
  font-family: Georgia, serif;
  font-size: 38px;
  font-weight: 500;
}
.forecast-overview h2 span {
  font-family: inherit;
  font-size: 16px;
  color: var(--muted);
}
.forecast-overview p,
.forecast-pace header p {
  line-height: 1.7;
}
.forecast-percentage {
  display: grid;
  justify-items: end;
  gap: 6px;
  flex-shrink: 0;
}
.forecast-percentage strong {
  font-family: Georgia, serif;
  font-size: 36px;
  color: var(--accent);
  font-weight: 500;
}
.forecast-percentage strong span {
  font-size: 18px;
}
.forecast-percentage small,
.forecast-note,
.forecast-state-legend small,
.forecast-data header small,
.forecast-word-panels small {
  font-size: 12px;
  color: var(--muted);
}
.forecast-state-bar {
  display: flex;
  gap: 3px;
  height: 10px;
  margin-top: 24px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--line);
}
.forecast-state-bar span {
  flex-basis: 0;
  min-width: 3px;
}
.forecast-state-bar .new,
.forecast-state-legend .new {
  background: var(--line);
}
.forecast-state-bar .learning,
.forecast-state-legend .learning {
  background: #86aaa1;
}
.forecast-state-bar .review,
.forecast-state-legend .review {
  background: #ba8c4f;
}
.forecast-state-bar .mastered,
.forecast-state-legend .mastered {
  background: var(--accent);
}
.forecast-state-legend {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 18px 0 26px;
  gap: 12px;
}
.forecast-state-legend dt {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 12px;
}
.forecast-state-legend dt i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.forecast-state-legend dd {
  margin: 8px 0 0 14px;
  font-size: 20px;
  font-family: Georgia, serif;
}
.forecast-data-panels {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.forecast-data {
  background: var(--panel);
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 7px;
  min-width: 0;
}
.forecast-data header,
.forecast-word-panels header,
.forecast-pace header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.forecast-data h3,
.forecast-pace h3,
.forecast-word-panels h3 {
  font-size: 14px;
  margin: 0;
  font-weight: 600;
}
.forecast-data-number {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 7px;
}
.forecast-data-number strong {
  font-family: Georgia, serif;
  font-size: 30px;
  font-weight: 500;
  color: var(--accent-deep);
}
.forecast-data-number > span {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}
.forecast-bars {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  margin-top: 20px;
}
.forecast-bars > div {
  flex: 1;
  min-width: 0;
  text-align: center;
}
.forecast-bar-track {
  height: 90px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  border-bottom: 1px solid var(--line);
}
.forecast-bar-track > span {
  background: var(--accent);
  width: 100%;
  max-width: 24px;
  border-radius: 3px 3px 0 0;
  position: relative;
}
.forecast-bar-track > span.empty {
  background: var(--line);
}
.forecast-bar-track > span.crowded {
  background: #ba8c4f;
}
.forecast-bars small {
  display: block;
  height: 18px;
  margin-top: 8px;
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
}
.forecast-bars .is-today small {
  color: var(--accent-deep);
}
.forecast-bar-count {
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 5px;
}
.forecast-bar-tooltip {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  display: none;
  padding: 6px 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  font-size: 11px;
  border-radius: 4px;
  z-index: 1;
}
.forecast-bar-track > span:hover .forecast-bar-tooltip {
  display: block;
}
.forecast-chart-empty {
  min-height: 134px;
  margin-top: 20px;
  display: grid;
  place-items: center;
  border-block: 1px dashed var(--line);
  color: var(--muted);
  font-size: 13px;
}
.forecast-note {
  line-height: 1.8;
}
.forecast-pace {
  margin-top: 26px;
  padding-top: 22px;
  border-top: 1px solid var(--line);
}
.forecast-pace-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin-top: 16px;
}
.forecast-pace-options > button {
  padding: 16px;
  display: grid;
  gap: 8px;
  text-align: left;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.forecast-pace-options > button.selected {
  border-color: var(--accent);
  box-shadow: inset 0 2px 0 var(--accent);
}
.forecast-pace-options > button > span {
  font-size: 12px;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
}
.forecast-pace-options > button > span small {
  margin-left: auto;
  font-size: 10px;
  color: var(--muted);
}
.forecast-pace-options > button > strong {
  font-family: Georgia, serif;
  color: var(--accent-deep);
  font-size: 25px;
  font-weight: 500;
}
.forecast-pace-options > button > small {
  font-size: 11px;
  color: var(--muted);
}
.forecast-word-panels {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  border-top: 1px solid var(--line);
  margin-top: 24px;
  padding-top: 22px;
}
.forecast-word-panels > article {
  min-width: 0;
}
.forecast-word-panels header {
  margin-bottom: 14px;
}
.forecast-word-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.forecast-word-chips > span {
  padding: 4px 7px;
  border: 1px solid var(--line);
  border-radius: 4px;
  font-family: Georgia, serif;
  font-size: 15px;
  overflow-wrap: anywhere;
  max-width: 100%;
  background: var(--panel);
}
.forecast-day-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.forecast-day-controls button {
  padding: 4px;
  min-height: 26px;
}
@media (max-width: 960px) {
  .forecast-data-panels,
  .forecast-word-panels {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 600px) {
  .forecast-overview {
    align-items: flex-start;
    gap: 12px;
  }
  .forecast-overview h2 {
    font-size: 30px;
  }
  .forecast-overview h2 span {
    display: block;
    font-size: 12px;
    margin-top: 8px;
  }
  .forecast-percentage strong {
    font-size: 28px;
  }
  .forecast-percentage small {
    max-width: 70px;
    font-size: 10px;
    text-align: right;
  }
  .forecast-state-legend {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  .forecast-data {
    padding: 14px;
  }
  .forecast-bars {
    gap: 5px;
  }
  .forecast-data-number > span {
    margin-left: 0;
  }
  .forecast-pace-options {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .forecast-pace-options > button {
    padding: 12px;
  }
}
</style>
