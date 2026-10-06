<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { browser } from "wxt/browser";
import { call } from "./api.ts";
import {
  readyWorkspaceMode,
  type WorkspaceConnectionState,
} from "../lib/workspace-owner.ts";
import StandaloneWorkspace from "./StandaloneWorkspace.vue";
import ConnectedWorkspace from "./ConnectedWorkspace.vue";

const connection = ref<WorkspaceConnectionState | null>(null);
const workspaceMode = computed(() => readyWorkspaceMode(connection.value));
const error = ref("");
const dark = ref(matchMedia("(prefers-color-scheme: dark)").matches);
const theme = computed(() => (dark.value ? "dark" : "light"));
const media = matchMedia("(prefers-color-scheme: dark)");
let poll: ReturnType<typeof setInterval> | undefined;
let pending = false;
let mounted = true;
function onTheme() {
  dark.value = media.matches;
}
async function refresh() {
  if (pending) return;
  pending = true;
  try {
    const next = await call<WorkspaceConnectionState>("connection-state");
    if (!mounted) return;
    connection.value = next;
    error.value = "";
  } catch (cause) {
    if (mounted) error.value = (cause as Error).message;
  } finally {
    pending = false;
  }
}
function onMessage(message: { channel?: string }) {
  if (message?.channel === "leximeet-connection-changed") void refresh();
}
onMounted(() => {
  media.addEventListener("change", onTheme);
  browser.runtime.onMessage.addListener(onMessage);
  // 先确认归属，再挂载业务页面，避免已连接时初始化原独立学习库。
  void refresh();
  poll = setInterval(() => void refresh(), 2000);
});
onUnmounted(() => {
  mounted = false;
  clearInterval(poll);
  media.removeEventListener("change", onTheme);
  browser.runtime.onMessage.removeListener(onMessage);
});
</script>

<template>
  <ConnectedWorkspace
    v-if="workspaceMode === 'desktop' && connection"
    :connection="connection"
    @changed="refresh"
  />
  <StandaloneWorkspace v-else-if="workspaceMode === 'independent'" />
  <main v-else class="app v3-app connection-loading" :data-theme="theme" aria-busy="true">
    <img
      :src="
        theme === 'dark' ? '/assets/brand/logo-dark.png' : '/assets/brand/logo-light.png'
      "
      alt="词遇 LexiMeet"
    />
    <p role="status">
      {{ connection?.ownerReady === false ? "正在切换工作区…" : "正在确认工作区…" }}
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="error" class="v3-secondary" type="button" @click="refresh">重试</button>
  </main>
</template>

<style scoped>
.connection-loading {
  min-height: 100dvh;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 16px;
  padding: 32px;
}
.connection-loading img {
  width: 150px;
}
.connection-loading p {
  margin: 0;
  color: var(--muted);
  text-align: center;
}
</style>
