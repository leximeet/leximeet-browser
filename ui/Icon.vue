<script setup lang="ts">
defineProps<{ name: string }>();
</script>
<template>
  <img class="icon" :src="`/assets/icons/${name}.svg`" alt="" aria-hidden="true" />
</template>
