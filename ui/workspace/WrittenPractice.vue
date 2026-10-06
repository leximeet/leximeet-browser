<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import Icon from "../Icon.vue";
const props = defineProps<{
  mode: "listening" | "cloze";
  question: string;
  input: string;
  phase: string;
  active: boolean;
  cueKey: string;
  loadingAudio: boolean;
  hint: boolean;
  answer: string;
  complete: boolean;
  canPrevious: boolean;
}>();
const emit = defineEmits<{
  update: [value: string];
  submit: [];
  play: [];
  hint: [];
  next: [];
  previous: [];
}>();
const field = ref<HTMLInputElement>(),
  composing = ref(false);
watch(
  () => [props.active, props.cueKey],
  async () => {
    await nextTick();
    if (props.active) field.value?.focus({ preventScroll: true });
  },
  { immediate: true },
);
function update(event: Event) {
  if (!composing.value) emit("update", (event.target as HTMLInputElement).value);
}
function submit() {
  if (!composing.value && props.active) emit("submit");
}
</script>
<template>
  <div class="v3-written-practice">
    <button
      v-if="mode === 'listening'"
      class="v3-listening-play v3-secondary"
      :aria-busy="loadingAudio"
      @click="emit('play')"
    >
      <Icon name="volume" />{{ loadingAudio ? "正在加载发音…" : "再听一次" }}
    </button>
    <blockquote v-else-if="question" class="v3-cloze-question">
      {{ question }}
    </blockquote>
    <p v-else class="v3-muted" role="status">
      本词暂无包含目标词的例句，换一种方式练习吧。
    </p>
    <template v-if="mode === 'listening' || question">
      <!-- 原生输入保留选择、粘贴、退格与输入法；答案只在明确查看提示后展示。 -->
      <form class="v3-written-form" @submit.prevent="submit">
        <input
          ref="field"
          :value="input"
          :readonly="phase === 'success'"
          :disabled="!active"
          maxlength="120"
          aria-label="练习答案"
          :aria-invalid="phase === 'answered'"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="输入听到或缺少的单词"
          @input="update"
          @compositionstart="composing = true"
          @compositionend="
            composing = false;
            update($event);
          "
          @keydown.enter="
            if (!$event.isComposing && $event.keyCode !== 229) {
              $event.preventDefault();
              submit();
            }
          "
        />
        <button
          class="mg-primary"
          type="submit"
          :disabled="!active || !input.trim() || phase === 'success'"
        >
          确认答案
        </button>
      </form>
      <p v-if="hint" class="v3-written-hint">{{ answer }}</p>
    </template>
    <div class="v3-practice-bottom">
      <button
        class="v3-secondary"
        :disabled="!active || !canPrevious"
        @click="emit('previous')"
      >
        <Icon name="arrow-left" />上一个
      </button>
      <button
        v-if="mode === 'listening' || question"
        class="v3-secondary"
        :disabled="!active"
        @click="emit('hint')"
      >
        <Icon name="bulb" />{{ hint ? "隐藏提示" : "显示提示" }}
      </button>
      <button
        class="v3-secondary"
        :disabled="(!!question || mode === 'listening') && (!active || !complete)"
        @click="emit('next')"
      >
        下一个<Icon name="arrow-right" />
      </button>
    </div>
  </div>
</template>
