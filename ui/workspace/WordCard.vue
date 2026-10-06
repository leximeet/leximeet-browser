<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useWorkspace } from "./useWorkspace.ts";
import Icon from "../Icon.vue";
import CardSettings from "./CardSettings.vue";
import ReadableText from "../ReadableText.vue";
import type { LexiconEntry } from "../../lib/lexicon.ts";
import type { LibraryItem } from "../../lib/workspace-model.ts";
import { PRACTICE_LABELS } from "../../lib/practice-session.ts";
import { readableCardSections, lexicalText } from "../../lib/word-card-content.ts";
const props = defineProps<{
  item?: LibraryItem | null;
  word?: string;
  hideMeaning?: boolean;
  compact?: boolean;
}>();
const ctx = useWorkspace();
const { preferences, encounters, reviews, audioState } = ctx;
const entry = ref<LexiconEntry | null>(null),
  loading = ref(false),
  error = ref(""),
  tab = ref("meaning"),
  configure = ref(false),
  expanded = ref(false);
let generation = 0;
const visible = computed(() => new Set(readableCardSections(preferences.value.card)));
// 隐藏当前语境字段时回到释义；只切换展示，不删除已保存的阅读事实。
watch(
  () => visible.value.has("contexts"),
  (show) => {
    if (!show && tab.value === "context") tab.value = "meaning";
  },
  { flush: "sync" },
);
const cardItem = computed(
  () =>
    props.item ||
    ctx.items.value.find((i) => i.key === entry.value?.word.toLowerCase()) ||
    null,
);
const contexts = computed(() =>
  encounters.value.filter(
    (e) => e.wordId === cardItem.value?.personal?.id && !e.undoneAt,
  ),
);
const senses = computed(
  () =>
    entry.value?.senses.slice(
      0,
      preferences.value.card.level === "minimal"
        ? 1
        : preferences.value.card.level === "moderate"
          ? 3
          : undefined,
    ) || [],
);
const meaning = computed(
  () => entry.value?.translation || props.item?.meaning || "本词暂无释义",
);
watch(
  () => props.word || props.item?.word,
  async (word) => {
    const current = ++generation;
    entry.value = null;
    loading.value = true;
    error.value = "";
    try {
      const found = word ? await ctx.lexicon.lookup(word) : null;
      if (current === generation) entry.value = found;
    } catch (e) {
      if (current === generation) error.value = (e as Error).message;
    } finally {
      if (current === generation) loading.value = false;
    }
  },
  { immediate: true },
);
function openSettings() {
  configure.value = true;
}
const lexicalLabels: Record<string, string> = {
  phrases: "常用短语",
  synonyms: "近义词",
  antonyms: "反义词",
  related_words: "相关词",
};
function collectionName(value: unknown) {
  const id = (value as { catalog_id?: string })?.catalog_id;
  return ctx.catalogs.value.find((catalog) => catalog.id === id)?.title || "";
}
</script>
<template>
  <article class="v3-word-card" :class="{ compact }" aria-label="单词词卡">
    <div class="v3-card-heading">
      <small>词条资料</small
      ><button
        type="button"
        title="词卡显示设置"
        aria-label="词卡显示设置"
        @click="openSettings"
      >
        <Icon name="adjustments-horizontal" />
      </button>
    </div>
    <header>
      <h2>{{ word || cardItem?.word }}</h2>
      <button
        type="button"
        class="v3-pronounce"
        :aria-label="`朗读 ${word || cardItem?.word}`"
        @click="
          ctx.audio.play(
            entry?.word || word || cardItem?.word || '',
            preferences.pronunciation,
          )
        "
      >
        <Icon name="volume" />
      </button>
    </header>
    <p v-if="visible.has('pronunciations')" class="v3-card-pronunciation">
      {{ entry?.phonetic || "暂无 IPA 音标" }}
    </p>
    <p v-if="audioState.phase === 'error'" role="status" class="v3-muted">
      {{ audioState.message }}
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!hideMeaning" class="v3-card-summary">{{ meaning }}</p>
    <div v-if="cardItem" class="v3-card-origin">
      <span v-if="cardItem.inTarget">学习目标</span
      ><span v-if="cardItem.collected">手动采集</span
      ><span v-if="contexts.length">遇见 {{ contexts.length }}</span
      ><span>{{
        ["due", "review"].includes(cardItem.status)
          ? "待复习"
          : cardItem.status === "learning"
            ? "学习中"
            : cardItem.status === "mastered"
              ? "已熟悉"
              : cardItem.scheduled
                ? "待学习"
                : "未学习"
      }}</span
      ><span
        v-if="cardItem.familiarity"
        :title="
          cardItem.dueAt
            ? `复习时间：${new Date(cardItem.dueAt).toLocaleString()}`
            : cardItem.familiarity.nextDecayAt
              ? `下一次衰减：${new Date(cardItem.familiarity.nextDecayAt).toLocaleString()}`
              : '初始 10 分，20 分完成初学，30 分进入休息期'
        "
        >{{ cardItem.familiarity.score }} / 30 分</span
      >
    </div>
    <button
      v-if="compact && !hideMeaning"
      type="button"
      class="v3-card-expand"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ expanded ? "收起详情" : "更多词卡信息" }}
    </button>
    <div v-if="!hideMeaning && (!compact || expanded)" class="v3-card-details">
      <nav class="v3-tabs" aria-label="词卡内容">
        <button
          v-if="visible.has('contexts')"
          :class="{ active: tab === 'context' }"
          :aria-pressed="tab === 'context'"
          @click="tab = 'context'"
        >
          语境 {{ contexts.length || "" }}</button
        ><button
          :class="{ active: tab === 'meaning' }"
          :aria-pressed="tab === 'meaning'"
          @click="tab = 'meaning'"
        >
          释义</button
        ><button
          :class="{ active: tab === 'records' }"
          :aria-pressed="tab === 'records'"
          @click="tab = 'records'"
        >
          记录
        </button>
      </nav>
      <div class="v3-card-scroll">
        <template v-if="tab === 'context' && visible.has('contexts')"
          ><p v-if="!contexts.length" class="v3-muted">尚未保存阅读语境</p>
          <section v-for="event in contexts" :key="event.id" class="v3-context">
            <small
              >{{ event.source.title }} ·
              {{ new Date(event.occurredAt).toLocaleDateString() }}</small
            >
            <blockquote>{{ event.savedExcerpt }}</blockquote>
            <p v-if="event.annotation.note">{{ event.annotation.note }}</p>
            <a :href="event.source.url" target="_blank" rel="noreferrer">返回来源 ↗</a>
          </section></template
        >
        <template v-else-if="tab === 'records'"
          ><p
            v-for="p in ctx.attempts.value.filter(
              (p) => p.wordId === cardItem?.personal?.id && p.learning,
            )"
            :key="p.id"
          >
            {{ new Date(p.createdAt).toLocaleString() }} ·
            {{ PRACTICE_LABELS.find((m) => m[0] === p.mode)?.[1] }} ·
            {{
              p.learning?.signal === "reveal"
                ? "查看答案"
                : p.correct
                  ? "正确"
                  : "未掌握"
            }}{{ p.learning?.assisted ? " · 辅助" : ""
            }}{{ p.learning?.undoneAt ? " · 已撤销" : "" }}
          </p>
          <p
            v-for="f in reviews.filter(
              (f) => f.wordId === cardItem?.personal?.id && !f.sourceSubmissionId,
            )"
            :key="f.id"
          >
            {{ new Date(f.createdAt).toLocaleString() }} ·
            {{
              {
                again: "再想想",
                hard: "有点难",
                good: "记住了",
                easy: "很熟悉",
              }[f.rating]
            }}{{ f.undoneAt ? " · 已撤销" : "" }}
          </p>
          <p
            v-if="
              !reviews.some((f) => f.wordId === cardItem?.personal?.id) &&
              !ctx.attempts.value.some((p) => p.wordId === cardItem?.personal?.id)
            "
            class="v3-muted"
          >
            尚未留下学习评价
          </p></template
        >
        <template v-else-if="entry"
          ><section v-if="visible.has('senses')">
            <h3>逐义释义</h3>
            <div
              v-for="sense in senses"
              :key="sense.sense_id"
              class="lm-sense v3-card-sense"
            >
              <p>
                <em>{{ sense.pos }}</em>
                <strong>{{
                  sense.short_gloss || sense.english_gloss || sense.learner_explanation_zh
                }}</strong>
              </p>
              <ReadableText
                v-if="visible.has('explanations') && sense.learner_explanation_zh"
                :text="sense.learner_explanation_zh"
              />
              <ReadableText
                v-if="visible.has('explanations') && sense.english_gloss"
                :text="sense.english_gloss"
              />
              <div v-if="visible.has('usage')">
                <ReadableText v-if="sense.usage_note_zh" :text="sense.usage_note_zh" />
                <small>{{
                  [...sense.labels, ...sense.topics].map((x) => x.code).join(" · ")
                }}</small>
              </div>
              <small v-if="visible.has('sources')"
                >义项来源：{{ sense.source_ref.source }}</small
              >
            </div>
            <p v-if="!senses.length">
              {{ entry.raw.ecdict.zh_fallback || "暂无逐义数据" }}
            </p>
            <details v-if="entry.senses.length > senses.length">
              <summary>展开全部 {{ entry.senses.length }} 个义项</summary>
              <p v-for="s in entry.senses.slice(senses.length)" :key="s.sense_id">
                {{ s.pos }} ·
                {{ s.short_gloss || s.learner_explanation_zh || s.english_gloss }}
              </p>
            </details>
          </section>
          <section v-if="visible.has('examples')">
            <h3>词典例句</h3>
            <div
              v-for="(example, i) in senses
                .flatMap((s) => s.examples)
                .slice(0, preferences.card.level === 'moderate' ? 3 : undefined)"
              :key="i"
              class="v3-context"
            >
              <blockquote>{{ example.text }}</blockquote>
              <p>{{ example.translation }}</p>
              <small>{{ example.source }}</small>
            </div>
            <p v-if="!senses.some((s) => s.examples.length)" class="v3-muted">
              本词暂无例句
            </p>
          </section>
          <section
            v-if="visible.has('pronunciations') && preferences.card.level !== 'moderate'"
          >
            <h3>候选音标</h3>
            <p v-for="(p, i) in entry.raw.pronunciations" :key="i">
              {{ p.notation }} · {{ p.region || "地区未标注" }} · {{ p.text }}
              <small>{{ p.pos }} {{ p.source }}</small>
            </p>
            <small v-if="entry.raw.ecdict.legacy_phonetic"
              >ECDICT 旧音标：{{ entry.raw.ecdict.legacy_phonetic }}</small
            >
          </section>
          <section v-if="visible.has('forms')">
            <h3>词形变化</h3>
            <p v-for="(f, i) in entry.raw.forms" :key="i">
              {{ f.text }}
              <small>{{ f.tags.join(" · ") }} · {{ f.source }}</small>
            </p>
            <p v-if="!entry.raw.forms.length">本词暂无</p>
          </section>
          <section v-if="visible.has('memory')">
            <h3>短助记</h3>
            <p>{{ entry.raw.memory_hook_zh || "本词暂无" }}</p>
            <template v-if="entry.raw.study_notes_zh.length">
              <h3>学习提示</h3>
              <ReadableText
                v-for="(note, i) in entry.raw.study_notes_zh"
                :key="i"
                :text="note"
              />
            </template>
          </section>
          <section v-if="visible.has('articles')">
            <h3>助记文章</h3>
            <div
              v-for="(m, i) in entry.raw.learning?.mnemonics.filter(
                (m) => m.kind !== 'memory-hook',
              ) || []"
              :key="i"
            >
              <ReadableText v-if="m.format === 'markdown'" :text="m.content" />
              <p v-else>{{ m.content }}</p>
              <small>{{ m.source }} · {{ (m as any).review_status || "未审校" }}</small>
            </div>
            <p
              v-if="!entry.raw.learning?.mnemonics.some((m) => m.kind !== 'memory-hook')"
            >
              本词暂无
            </p>
          </section>
          <section v-if="visible.has('lexical')">
            <h3>词汇关系与短语</h3>
            <div v-for="(list, key) in entry.raw.learning?.lexical" :key="key">
              <strong>{{ lexicalLabels[key] || "相关表达" }}</strong>
              <p v-for="(value, i) in list" :key="i">{{ lexicalText(value) }}</p>
              <small v-if="!list.length">本词暂无</small>
            </div>
          </section>
          <section v-if="visible.has('collections')">
            <h3>词书归属与词频</h3>
            <p
              v-for="(c, i) in (entry.raw.learning?.collections || []).filter(
                collectionName,
              )"
              :key="i"
            >
              {{ collectionName(c) }}
            </p>
            <p v-for="(rank, name) in entry.raw.ecdict.frequency_ranks" :key="name">
              {{ name }} 原始名次：{{ rank }}
            </p>
          </section>
          <section v-if="visible.has('personal') && cardItem?.personal">
            <h3>个人笔记</h3>
            <p>{{ cardItem.personal.note || "尚未添加笔记" }}</p>
            <small v-if="cardItem.personal.notebookIds.length"
              >单词本：{{
                ctx.notebooks.value
                  .filter(
                    (book) =>
                      !book.deletedAt &&
                      cardItem?.personal?.notebookIds.includes(book.id),
                  )
                  .map((book) => book.name)
                  .join(" · ")
              }}</small
            >
          </section>
          <section v-if="visible.has('sources')">
            <h3>来源与审核</h3>
            <p>
              词遇词典 {{ entry.source.revision }} ·
              {{ entry.source.edition === "lite-text" ? "轻量文字包" : "核心文字包" }}
            </p>
            <small>{{
              entry.source.origin === "curated" ? "整理词条" : "ECDICT 补充词条"
            }}</small>
          </section>
        </template>
        <p v-else class="v3-muted">
          {{ loading ? "正在读取词条…" : "词典未匹配，可继续保存个人笔记。" }}
        </p>
      </div>
    </div>
    <CardSettings v-if="configure" @close="configure = false" />
  </article>
</template>
