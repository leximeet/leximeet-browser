<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { call } from "./api.ts";
import type { DesktopCard } from "../lib/desktop-reading.ts";
import type { WordRef } from "../lib/connector/types.ts";
import { createPronunciationPlayer, type AudioState } from "../lib/pronunciation.ts";
import { defaultWorkspacePreferences } from "../lib/workspace-model.ts";
import Icon from "./Icon.vue";
const props = defineProps<{ word: string; available: boolean }>();
const card = ref<DesktopCard | null>(null),
  error = ref(""),
  busy = ref(false);
const audioState = ref<AudioState>({ phase: "idle" });
// 连接词卡用设备默认在线发音
const pronunciation = defaultWorkspacePreferences().pronunciation;
const audio = createPronunciationPlayer(
  () => {
    const element = document.createElement("audio");
    element.hidden = true;
    document.body.append(element);
    return element;
  },
  (next) => (audioState.value = next),
);
function pronounce() {
  const headword = card.value?.entry?.word;
  if (!props.available || busy.value || !headword) return;
  if (audioState.value.phase === "playing") audio.stop();
  else void audio.play(headword, pronunciation);
}
let generation = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let mounted = true;
const statusLabel = {
  new: "未学",
  learning: "学习中",
  review: "待复习",
  mastered: "已熟练",
};
function identity(word: WordRef) {
  return word.kind === "dictionary" ? `${word.release}:${word.entryId}` : word.customId;
}
function identityLabel(word: WordRef) {
  return word.kind === "dictionary"
    ? `词典 ${word.release} · ${word.entryId}`
    : `自定义 · ${word.customId}`;
}
async function load() {
  clearTimeout(refreshTimer);
  audio.stop();
  const current = ++generation;
  // 用户自定义词卡只在有效读取期限内显示；刷新或失联时先撤下旧数据。
  card.value = null;
  error.value = "";
  if (!props.available || !props.word) {
    busy.value = false;
    return;
  }
  busy.value = true;
  try {
    const next = await call<DesktopCard>("desktop-card", { word: props.word });
    if (!mounted || current !== generation || !props.available) return;
    card.value = next;
    // 多义候选同样包含私人状态与分数，必须按本次读取期限撤下并重新读取。
    refreshTimer = setTimeout(
      () => void load(),
      Math.max(1, Math.min(next.refreshAfterMs, 30_000)),
    );
  } catch (cause) {
    if (current === generation && mounted) error.value = (cause as Error).message;
  } finally {
    if (current === generation && mounted) busy.value = false;
  }
}
async function select(word: WordRef) {
  if (busy.value || !props.available) return;
  const current = ++generation;
  clearTimeout(refreshTimer);
  audio.stop();
  card.value = null;
  busy.value = true;
  error.value = "";
  try {
    await call("desktop-select-word", { surface: props.word, word });
    if (current === generation && props.available && mounted) await load();
  } catch (cause) {
    if (current === generation && mounted) error.value = (cause as Error).message;
  } finally {
    if (current === generation && mounted) busy.value = false;
  }
}
watch(
  () => [props.word, props.available],
  () => void load(),
  { immediate: true },
);
onUnmounted(() => {
  mounted = false;
  ++generation;
  clearTimeout(refreshTimer);
  audio.stop();
});
</script>

<template>
  <article class="desktop-word-card" aria-label="桌面词卡" :aria-busy="busy">
    <p v-if="!available" class="desktop-card-message" role="status">
      等待桌面恢复连接，词卡暂不可用。
    </p>
    <p v-else-if="busy" class="desktop-card-message" role="status">
      <span class="lm-spinner" aria-hidden="true" />正在读取桌面词卡…
    </p>
    <template v-else-if="card">
      <section
        v-if="!card.selected && card.choices.length"
        class="desktop-card-choices"
        aria-label="选择词条身份"
      >
        <p>这个拼写对应多个词条，请选择一个。</p>
        <button
          v-for="choice in card.choices"
          :key="identity(choice.word)"
          type="button"
          :aria-label="`选择词条 ${identityLabel(choice.word)}`"
          @click="select(choice.word)"
        >
          <strong>{{ choice.headword }}</strong
          ><span>{{ statusLabel[choice.learningStatus] }} · {{ choice.score }} 分</span
          ><small>{{ identityLabel(choice.word) }}</small>
        </button>
      </section>
      <template v-else-if="card.summary">
        <header>
          <h2>{{ card.summary.headword || card.entry?.word || word }}</h2>
          <button
            v-if="card.entry?.word"
            class="desktop-card-pronounce"
            type="button"
            :aria-label="
              audioState.phase === 'playing' ? '停止发音' : `朗读 ${card.entry.word}`
            "
            :title="audioState.phase === 'playing' ? '停止发音' : '浏览器在线播放发音'"
            :aria-busy="audioState.phase === 'loading'"
            :aria-pressed="audioState.phase === 'playing'"
            :data-audio-phase="audioState.phase"
            :disabled="!available || busy || audioState.phase === 'loading'"
            @click="pronounce"
          >
            <span
              v-if="audioState.phase === 'loading'"
              class="lm-spinner"
              aria-hidden="true"
            /><Icon
              v-else
              :name="audioState.phase === 'playing' ? 'player-pause' : 'volume'"
            />
          </button>
          <span>{{ card.summary.learning.score }} / 30 分</span>
        </header>
        <p
          v-if="audioState.phase === 'playing'"
          class="desktop-card-audio-status"
          role="status"
        >
          正在发音
        </p>
        <p
          v-if="audioState.phase === 'error'"
          class="desktop-card-audio-error"
          role="status"
        >
          {{ audioState.message
          }}<button type="button" :disabled="busy || !available" @click="pronounce">
            重试发音
          </button>
        </p>
        <p v-if="card.entry?.phonetic" class="desktop-card-phonetic">
          /{{ card.entry.phonetic }}/
        </p>
        <p v-if="card.entry?.translation" class="desktop-card-summary">
          {{ card.entry.translation }}
        </p>
        <div class="desktop-card-tags">
          <span>{{ statusLabel[card.summary.learning.status] }}</span
          ><span v-if="card.summary.inTarget">学习目标</span
          ><span v-if="card.summary.collected">已采集</span>
        </div>
        <section v-if="card.summary.personal?.note" class="desktop-card-section">
          <h3>我的笔记</h3>
          <p>{{ card.summary.personal.note }}</p>
        </section>
        <details v-if="card.entry?.senses.length" class="desktop-card-section">
          <summary>逐义释义</summary>
          <div
            v-for="sense in card.entry.senses"
            :key="sense.sense_id"
            class="desktop-card-sense"
          >
            <small>{{ sense.pos }}</small>
            <p>{{ sense.short_gloss || sense.english_gloss }}</p>
          </div>
        </details>
      </template>
      <p v-if="card.resourceMessage" class="desktop-card-message" role="status">
        {{ card.resourceMessage }}
      </p>
    </template>
    <p v-if="error" class="desktop-card-error" role="alert">
      {{ error
      }}<button type="button" :disabled="busy || !available" @click="load">重试</button>
    </p>
  </article>
</template>

<style scoped>
.desktop-word-card {
  font-size: 12px;
  line-height: 1.8;
}
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
}
h2 {
  font: 32px/1.25 var(--reading-font);
  overflow-wrap: anywhere;
  margin: 0;
  flex: 1;
  min-width: 0;
}
.desktop-card-pronounce {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 31px;
  height: 31px;
  flex-shrink: 0;
  border: 1px solid var(--line);
  border-radius: 50%;
  color: var(--accent);
}
.desktop-card-pronounce:hover,
.desktop-card-pronounce[aria-pressed="true"] {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.desktop-card-pronounce :deep(img) {
  width: 15px;
  height: 15px;
}
.desktop-card-pronounce .lm-spinner {
  width: 13px;
  height: 13px;
  margin: 0;
}
.desktop-card-audio-status {
  font-size: 10px;
  color: var(--muted);
  margin: 8px 0;
}
.desktop-card-audio-error {
  color: var(--danger);
  font-size: 11px;
  margin: 10px 0;
}
.desktop-card-audio-error button {
  color: var(--accent);
  margin-left: 8px;
}
header > span {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
}
.desktop-card-phonetic {
  color: var(--muted);
  margin: 8px 0;
}
.desktop-card-summary {
  font-size: 13px;
  line-height: 1.9;
  margin: 12px 0 16px;
}
.desktop-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.desktop-card-tags span {
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--muted);
  font-size: 10px;
}
.desktop-card-section {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.desktop-card-section h3,
summary {
  font-size: 11px;
  margin: 0 0 8px;
  color: var(--muted);
  font-weight: 600;
}
.desktop-card-section p {
  margin: 6px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.desktop-card-sense {
  display: grid;
  grid-template-columns: minmax(32px, auto) 1fr;
  gap: 8px;
  margin: 12px 0;
}
.desktop-card-sense small {
  color: var(--muted);
  font-style: italic;
}
.desktop-card-sense p {
  margin: 0;
}
.desktop-card-message {
  color: var(--muted);
  margin: 6px 0 12px;
}
.desktop-card-choices > p {
  color: var(--muted);
  margin: 0 0 14px;
}
.desktop-card-choices button {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 12px;
  text-align: left;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 8px;
}
.desktop-card-choices button:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.desktop-card-choices strong {
  font: 20px var(--reading-font);
  flex: 1;
}
.desktop-card-choices span {
  font-size: 10px;
  color: var(--muted);
}
.desktop-card-choices small {
  width: 100%;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 10px;
}
.desktop-card-error {
  color: var(--danger);
  margin: 8px 0;
}
.desktop-card-error button {
  display: block;
  color: var(--accent);
  margin-top: 10px;
}
</style>
