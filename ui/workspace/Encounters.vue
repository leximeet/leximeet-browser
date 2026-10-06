<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkspace } from "./useWorkspace.ts";
import Icon from "../Icon.vue";
import WordCard from "./WordCard.vue";
import Dialog from "./Dialog.vue";
import { localDay } from "../../lib/workspace-model.ts";
const ctx = useWorkspace(),
  { encounters } = ctx;
const range = ref("all"),
  start = ref(""),
  end = ref(""),
  search = ref(""),
  selected = ref(""),
  page = ref(0);
const rows = computed(() => {
  const now = Date.now(),
    days = Number(range.value);
  return encounters.value.filter((e) => {
    if (e.undoneAt) return false;
    const date = localDay(new Date(e.occurredAt));
    return (
      (!search.value ||
        `${e.surface} ${e.savedExcerpt} ${e.source.title}`
          .toLowerCase()
          .includes(search.value.toLowerCase())) &&
      (range.value === "all" ||
        (range.value === "today" && date === localDay()) ||
        (range.value === "custom" &&
          (!start.value || date >= start.value) &&
          (!end.value || date <= end.value)) ||
        (days > 0 && Date.parse(e.occurredAt) >= now - days * 86400000))
    );
  });
});
const selectedWord = computed(() =>
  ctx.items.value.find((i) => i.personal?.id === selected.value),
);
</script>
<template>
  <section class="v3-encounters">
    <input
      v-model="search"
      type="search"
      aria-label="搜索遇见记录"
      placeholder="搜索单词、语境或来源"
    />
    <div class="v3-date-filters" aria-label="时间快捷过滤">
      <button
        v-for="[id, label] in [
          ['all', '全部时间'],
          ['today', '今天'],
          ['3', '近 3 天'],
          ['7', '近 7 天'],
          ['15', '近 15 天'],
          ['30', '近 30 天'],
          ['60', '近 60 天'],
          ['90', '近 90 天'],
          ['custom', '自定义区间'],
        ] as const"
        :key="id"
        :aria-pressed="range === id"
        @click="
          range = id;
          page = 0;
        "
      >
        {{ label }}
      </button>
    </div>
    <div v-if="range === 'custom'" class="v3-actions">
      <label>开始日期<input v-model="start" type="date" /></label
      ><label>结束日期<input v-model="end" type="date" :min="start" /></label>
    </div>
    <small class="v3-muted">{{ rows.length }} 条遇见</small>
    <article
      v-for="e in rows.slice(page * 30, (page + 1) * 30)"
      :key="e.id"
      class="v3-context"
    >
      <header>
        <button @click="selected = e.wordId">
          <strong>{{ e.surface }}</strong></button
        ><small>{{ new Date(e.occurredAt).toLocaleString() }}</small>
      </header>
      <blockquote>{{ e.savedExcerpt }}</blockquote>
      <p v-if="e.annotation.note">{{ e.annotation.note }}</p>
      <a :href="e.source.url" rel="noreferrer" target="_blank"
        ><Icon name="external-link" />{{ e.source.title || e.source.url }}</a
      >
    </article>
    <p v-if="!rows.length" class="v3-empty">还没有这个时间范围内的遇见</p>
    <footer class="v3-pagination">
      <button :disabled="!page" @click="page--">上一页</button
      ><span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(rows.length / 30)) }}</span
      ><button :disabled="(page + 1) * 30 >= rows.length" @click="page++">下一页</button>
    </footer>
    <Dialog v-if="selectedWord" title="遇见词卡" @close="selected = ''"
      ><WordCard :item="selectedWord"
    /></Dialog>
  </section>
</template>

<style scoped>
/* 词头是主入口，原句与来源用较小字号，保留完整语境和可点击词卡。 */
.v3-context header {
  align-items: baseline;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.v3-context header button {
  padding: 0;
  text-align: left;
  min-width: 0;
}
.v3-context header strong {
  font: 500 28px/1.35 var(--reading-font);
  overflow-wrap: anywhere;
}
.v3-context blockquote {
  margin: 10px 0 12px;
  font: 15px/1.8 var(--reading-font);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.v3-context header small {
  font-size: 11px;
  white-space: nowrap;
}
.v3-context > p {
  font-size: 13px;
  line-height: 1.7;
}
.v3-context > a {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  max-width: 100%;
  font-size: 11px;
  overflow-wrap: anywhere;
}
@media (max-width: 650px) {
  .v3-context header strong {
    font-size: 25px;
  }
}
</style>
