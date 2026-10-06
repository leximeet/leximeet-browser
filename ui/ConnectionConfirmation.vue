<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { call } from "./api.ts";
import type { DiscoveryView } from "../lib/desktop-discovery.ts";
const view = ref<DiscoveryView | null>(null),
  error = ref(""),
  busy = ref(false);
const media = matchMedia("(prefers-color-scheme: dark)"),
  dark = ref(media.matches);
const theme = computed(() => (dark.value ? "dark" : "light"));
const connected = computed(() => view.value?.connection.status === "connected");
let timer: ReturnType<typeof setInterval> | undefined,
  disposed = false;
function closeWindow() {
  window.close();
}
function changed() {
  dark.value = media.matches;
}
async function refresh() {
  try {
    const value = await call<DiscoveryView>("desktop-discovery-state");
    if (!disposed) view.value = value;
  } catch (cause) {
    if (!disposed) error.value = (cause as Error).message;
  }
}
async function confirm() {
  const id = view.value?.invitation?.invitationId;
  if (!id || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    view.value = await call("desktop-confirm-connection", { invitationId: id });
  } catch (cause) {
    error.value = (cause as Error).message;
    await refresh();
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (view.value?.invitation)
      await call("desktop-cancel-connection", {
        invitationId: view.value.invitation.invitationId,
      });
    window.close();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  media.addEventListener("change", changed);
  void refresh();
  timer = setInterval(() => void refresh(), 1000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  media.removeEventListener("change", changed);
});
</script>
<template>
  <main class="app confirmation" :data-theme="theme">
    <section role="dialog" aria-modal="true" aria-labelledby="connection-heading">
      <img :src="`/assets/brand/logo-${theme}.png`" alt="词遇 LexiMeet" />
      <small>本机连接</small>
      <h1 id="connection-heading">连接桌面端</h1>
      <template v-if="connected">
        <p class="success" role="status">已连接桌面端</p>
        <p>遇见和采集已使用桌面资料。</p>
        <button class="mg-primary" @click="closeWindow">关闭窗口</button>
      </template>
      <template v-else>
        <p>{{ view?.desktop?.displayName || "正在查找桌面端…" }}</p>
        <div class="ownership">
          <strong>保留原资料，切换到桌面</strong
          ><span>浏览器独立资料会封存，不上传、不合并。明确断开后即可恢复。</span>
        </div>
        <p v-if="error" role="alert" class="failure">{{ error }}</p>
        <p v-else-if="view?.connection.mode === 'desktop'" role="status">
          {{ view.connection.message || "正在确认原连接结果，独立资料仍封存。" }}
        </p>
        <p v-else-if="!view?.invitation && view" role="status">
          邀请已取消或过期，请重新发起。
        </p>
        <footer>
          <button
            class="v3-secondary"
            :disabled="busy || view?.connection.mode === 'desktop'"
            @click="cancel"
          >
            取消
          </button>
          <button
            class="mg-primary"
            :disabled="busy || !view?.invitation || view?.connection.mode === 'desktop'"
            :aria-busy="busy"
            @click="confirm"
          >
            {{ busy ? "正在连接…" : "确认连接" }}
          </button>
        </footer>
      </template>
    </section>
  </main>
</template>
<style scoped>
.confirmation {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 28px;
  background: var(--surface);
  color: var(--text);
}
section {
  width: 100%;
  max-width: 440px;
}
img {
  width: 120px;
  display: block;
  margin-bottom: 22px;
}
small {
  color: var(--muted);
  font-size: 11px;
}
h1 {
  font-size: 24px;
  margin: 8px 0 12px;
  font-weight: 700;
}
p {
  font-size: 13px;
  line-height: 1.7;
  color: var(--muted);
}
.ownership {
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 10px;
  display: grid;
  gap: 8px;
  margin: 18px 0;
}
.ownership strong {
  font-size: 14px;
}
.ownership span {
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}
.failure {
  color: var(--danger, #b34444);
}
.success {
  color: var(--accent, #147761);
  font-size: 18px;
  font-weight: 700;
}
button {
  min-height: 38px;
}
</style>
