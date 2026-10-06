<script setup lang="ts">
import { computed } from "vue";
import { readableMarkdown } from "../lib/readable-markdown.ts";
import ReadableInline from "./ReadableInline.vue";
const props = defineProps<{ text: string }>();
const blocks = computed(() => readableMarkdown(props.text));
</script>
<template>
  <div class="lm-readable-text">
    <component :is="block.tag" v-for="(block, i) in blocks" :key="i">
      <template v-if="block.items"
        ><li v-for="(item, n) in block.items" :key="n">
          <ReadableInline :text="item" /></li
      ></template>
      <template v-else-if="block.tag === 'pre'">{{ block.text }}</template>
      <ReadableInline v-else :text="block.text || ''" />
    </component>
  </div>
</template>
<style scoped>
.lm-readable-text {
  font-size: 14px;
  line-height: 1.75;
  overflow-wrap: anywhere;
}
.lm-readable-text :is(h4, h5, h6) {
  font-size: 1em;
  font-weight: 650;
  margin: 20px 0 8px;
}
.lm-readable-text :is(p, blockquote, pre) {
  margin: 8px 0;
  white-space: pre-wrap;
}
.lm-readable-text :is(ol, ul) {
  padding-left: 24px;
  margin: 8px 0;
}
.lm-readable-text li {
  margin: 4px 0;
}
.lm-readable-text pre {
  padding: 10px;
  border: 1px solid currentColor;
  border-radius: 6px;
  overflow-x: auto;
}
.lm-readable-text blockquote {
  padding-left: 12px;
  border-left: 2px solid currentColor;
}
</style>
