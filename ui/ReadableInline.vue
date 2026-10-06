<script setup lang="ts">
import { computed } from "vue";
import { readableInline } from "../lib/readable-markdown.ts";
const props = defineProps<{ text: string }>();
const nodes = computed(() => readableInline(props.text));
</script>
<template>
  <template v-for="(node, i) in nodes" :key="i">
    <strong v-if="node.kind === 'strong'">{{ node.text }}</strong>
    <em v-else-if="node.kind === 'em'">{{ node.text }}</em>
    <code v-else-if="node.kind === 'code'">{{ node.text }}</code>
    <a
      v-else-if="node.kind === 'link'"
      :href="node.href"
      target="_blank"
      rel="noopener noreferrer"
      >{{ node.text }}</a
    >
    <template v-else>{{ node.text }}</template>
  </template>
</template>
