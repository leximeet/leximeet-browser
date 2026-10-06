<script setup lang="ts">
import Dialog from "./Dialog.vue";
defineProps<{
  context: { title: string; unsavedCount: number; destinationTabId?: number };
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{ decide: [keep: boolean] }>();
</script>
<template>
  <Dialog title="继续采集吗？" @close="!busy && emit('decide', true)">
    <p class="lm-switch-source">{{ context.title }}</p>
    <p v-if="context.unsavedCount">
      还有 <strong>{{ context.unsavedCount }}</strong> 条语境未加入单词本。
    </p>
    <p v-else>当前没有待加入的单词。</p>
    <p v-if="context.destinationTabId !== undefined" class="lm-muted">
      标签已切换，原网页采集已暂停。
    </p>
    <p class="lm-muted">
      {{
        context.destinationTabId !== undefined
          ? "继续会返回原网页采集；"
          : "继续会留在原网页采集；"
      }}不继续会丢弃未加入的内容。已加入单词本的内容会保留。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <footer class="lm-confirm-actions">
      <button
        class="lm-subtle"
        type="button"
        :disabled="busy"
        @click="emit('decide', false)"
      >
        不继续，丢弃未加入
      </button>
      <button
        class="lm-primary"
        type="button"
        :disabled="busy"
        @click="emit('decide', true)"
      >
        <span v-if="busy" class="lm-spinner" aria-hidden="true" />继续采集
      </button>
    </footer>
  </Dialog>
</template>
