<script setup lang="ts">
import { computed } from "vue";
import Icon from "../Icon.vue";
import {
  listRecall,
  maskHeadword,
  type PracticeSession,
} from "../../lib/practice-session.ts";
import type { LibraryItem } from "../../lib/workspace-model.ts";
const props = defineProps<{
  session: PracticeSession;
  items: LibraryItem[];
  busy?: boolean;
}>();
const emit = defineEmits<{
  select: [index: number];
  reveal: [key: string];
  answer: [index: number, answer: "familiar" | "unfamiliar"];
  mask: [];
}>();
const pageSize = 12,
  page = computed(() => Math.floor(props.session.index / pageSize)),
  rows = computed(() =>
    props.items.slice(page.value * pageSize, (page.value + 1) * pageSize),
  ),
  mask = computed(() => props.session.listMask || "meaning");
const revealed = (key: string) => {
  const recall = listRecall(props.session, key);
  return recall.revealed || recall.answer !== null;
};
</script>
<template>
  <div class="v3-practice-list">
    <header class="v3-practice-list-heading">
      <span class="v3-muted">先回想，再查看答案</span>
      <button class="v3-secondary" :disabled="busy" @click="emit('mask')">
        <Icon name="eye-off" />{{ mask === "meaning" ? "遮挡英文" : "遮挡中文" }}
      </button>
    </header>
    <div class="v3-practice-list-labels" aria-hidden="true">
      <span>单词</span><span>中文释义</span><span>记忆反馈</span>
    </div>
    <article
      v-for="(item, i) in rows"
      :key="item.key"
      class="v3-practice-list-row"
      :class="{ selected: session.index === page * pageSize + i }"
      :data-key="item.key"
    >
      <div class="v3-practice-list-word">
        <button
          v-if="mask === 'word' && !revealed(item.key)"
          class="v3-word-mask"
          aria-label="揭示英文"
          :disabled="busy"
          @click="emit('reveal', item.key)"
        >
          点击查看
        </button>
        <button
          v-else
          :aria-label="`练习词 ${item.word}`"
          :disabled="busy"
          @click="emit('select', page * pageSize + i)"
        >
          {{ item.word }}
        </button>
        <small class="v3-practice-word-score" :aria-label="`${item.word} 熟悉度`">
          {{ item.familiarity?.score ?? 10 }} / 30 分
        </small>
      </div>
      <div class="v3-practice-list-meaning">
        <button
          v-if="mask === 'meaning' && !revealed(item.key)"
          class="v3-word-mask"
          aria-label="揭示中文"
          :disabled="busy"
          @click="emit('reveal', item.key)"
        >
          点击查看
        </button>
        <span v-else>{{
          mask === "word" && !revealed(item.key)
            ? maskHeadword(item.meaning, item.word)
            : item.meaning
        }}</span>
      </div>
      <div class="v3-practice-list-signals">
        <template v-if="listRecall(session, item.key).answer === null">
          <button
            class="v3-secondary"
            :disabled="busy"
            @click="emit('answer', page * pageSize + i, 'familiar')"
          >
            熟悉 +1
          </button>
          <button
            class="v3-secondary"
            :disabled="busy"
            @click="emit('answer', page * pageSize + i, 'unfamiliar')"
          >
            不熟悉 −1
          </button>
        </template>
        <span v-else class="v3-list-feedback" role="status"
          ><Icon name="check" />{{
            listRecall(session, item.key).answer === "familiar"
              ? "熟悉 · 已记录"
              : "不熟悉 · 已记录"
          }}</span
        >
      </div>
    </article>
    <footer class="v3-pagination">
      <button
        :disabled="busy || page === 0"
        @click="emit('select', (page - 1) * pageSize)"
      >
        上一页
      </button>
      <span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(items.length / pageSize)) }}</span>
      <button
        :disabled="busy || (page + 1) * pageSize >= items.length"
        @click="emit('select', (page + 1) * pageSize)"
      >
        下一页
      </button>
    </footer>
  </div>
</template>
