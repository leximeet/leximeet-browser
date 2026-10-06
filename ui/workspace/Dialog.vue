<script setup lang="ts">
import { onMounted, ref } from "vue";
import Icon from "../Icon.vue";
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const element = ref<HTMLDialogElement>();
onMounted(() => element.value?.showModal());
</script>
<template>
  <dialog
    ref="element"
    class="v3-dialog"
    :class="{ wide }"
    :aria-label="title"
    @cancel.prevent="emit('close')"
  >
    <header>
      <h2>{{ title }}</h2>
      <button
        class="v3-icon-button"
        type="button"
        aria-label="关闭对话框"
        @click="emit('close')"
      >
        <Icon name="x" />
      </button>
    </header>
    <div class="v3-dialog-body"><slot /></div>
  </dialog>
</template>
