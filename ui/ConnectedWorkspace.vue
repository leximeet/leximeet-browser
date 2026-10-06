<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { call } from "./api.ts";
import { browser } from "wxt/browser";
import type { ConnectionView } from "../lib/desktop-connection.ts";
import Dialog from "./workspace/Dialog.vue";
import Icon from "./Icon.vue";
const props = defineProps<{ connection: ConnectionView }>();
const emit = defineEmits<{ changed: [] }>();
const settings = ref(location.hash === "#/settings");
const dark = ref(matchMedia("(prefers-color-scheme: dark)").matches);
const theme = computed(() => (dark.value ? "dark" : "light"));
const available = computed(() => props.connection.status === "connected");
const accountName = computed(() =>
  props.connection.account?.status === "signed-in"
    ? props.connection.account.account.displayName
    : "",
);
const busy = ref(false),
  error = ref(""),
  disconnectOpen = ref(false);
const media = matchMedia("(prefers-color-scheme: dark)");
function onTheme() {
  dark.value = media.matches;
}
function onHash() {
  settings.value = location.hash === "#/settings";
  error.value = "";
}
function navigate(next: boolean) {
  location.hash = next ? "/settings" : "/today";
}
async function open(target: "library" | "plan" | "settings") {
  if (busy.value || !available.value) return;
  busy.value = true;
  error.value = "";
  try {
    await call("desktop-open", { target });
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
async function disconnect() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await call("desktop-disconnect");
    disconnectOpen.value = false;
    emit("changed");
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
let ownTabId: number | undefined;
async function prepareManagementTab() {
  const tab = await browser.tabs.getCurrent();
  ownTabId = tab?.id;
  if (ownTabId !== undefined) await call("workspace-ready", { tabId: ownTabId });
}
function onActivation(message: { channel?: string; event?: string; tabId?: number }) {
  if (
    message.channel === "leximeet-workspace" &&
    message.event === "activated" &&
    message.tabId === ownTabId
  )
    void prepareManagementTab().catch(
      (cause) => (error.value = (cause as Error).message),
    );
}
function onVisibility() {
  if (document.visibilityState === "visible")
    void prepareManagementTab().catch(
      (cause) => (error.value = (cause as Error).message),
    );
}
onMounted(() => {
  // 连接管理页也注册真实扩展 tab，让 Chrome 在此页关闭阅读侧栏。
  void prepareManagementTab().catch((cause) => (error.value = (cause as Error).message));
  browser.runtime.onMessage.addListener(onActivation);
  document.addEventListener("visibilitychange", onVisibility);
  media.addEventListener("change", onTheme);
  window.addEventListener("hashchange", onHash);
});
onUnmounted(() => {
  browser.runtime.onMessage.removeListener(onActivation);
  document.removeEventListener("visibilitychange", onVisibility);
  media.removeEventListener("change", onTheme);
  window.removeEventListener("hashchange", onHash);
});
</script>

<template>
  <main
    class="app v3-app connected-workspace"
    :data-theme="theme"
    data-workspace-mode="desktop"
    :data-desktop-state="connection.status"
  >
    <header class="connected-header">
      <img
        :src="
          theme === 'dark'
            ? '/assets/brand/logo-dark.png'
            : '/assets/brand/logo-light.png'
        "
        alt="词遇 LexiMeet"
      />
      <span class="connected-status"
        ><i :class="{ waiting: !available }" />{{
          available ? "已连接桌面端" : "等待桌面恢复连接"
        }}</span
      >
    </header>
    <div class="connected-layout">
      <nav aria-label="管理导航">
        <button
          type="button"
          :class="{ active: !settings }"
          :aria-current="!settings ? 'page' : undefined"
          @click="navigate(false)"
        >
          <Icon name="book-2" />桌面工作区
        </button>
        <button
          type="button"
          :class="{ active: settings }"
          :aria-current="settings ? 'page' : undefined"
          @click="navigate(true)"
        >
          <Icon name="settings" />设置
        </button>
      </nav>
      <section class="connected-content">
        <template v-if="!settings">
          <small class="connected-eyebrow">DESKTOP WORKSPACE</small>
          <h1>阅读在浏览器，学习在桌面。</h1>
          <p class="connected-intro">
            侧栏与悬浮球继续提供遇见、词卡与采集。单词本、学习规划和练习请在词遇桌面端管理。
          </p>
          <section class="connected-owner" aria-label="当前资料归属">
            <span class="connected-status"
              ><i :class="{ waiting: !available }" />桌面资料</span
            >
            <strong>{{ accountName || "词遇桌面工作区" }}</strong>
            <p>
              {{
                available
                  ? "新采集的单词与语境直接保存到桌面端。"
                  : "连接中断期间暂停读写，原浏览器资料继续封存。"
              }}
            </p>
            <small v-if="connection.dictionaryEdition"
              >{{ connection.dictionaryEdition.replace("-text", " Text") }} ·
              词典由桌面端提供</small
            >
          </section>
          <div class="connected-actions">
            <button
              type="button"
              class="mg-primary"
              :disabled="busy || !available"
              @click="open('library')"
            >
              打开桌面单词本 <span aria-hidden="true">↗</span>
            </button>
            <button
              type="button"
              class="v3-secondary"
              :disabled="busy || !available"
              @click="open('plan')"
            >
              学习规划 <span aria-hidden="true">↗</span>
            </button>
            <button
              type="button"
              class="v3-secondary"
              :disabled="busy || !available"
              @click="open('settings')"
            >
              桌面设置 <span aria-hidden="true">↗</span>
            </button>
          </div>
          <p class="connected-archive-note">
            原独立资料已封存，没有上传或合并。断开连接并恢复独立使用后，可以继续使用这些资料。
          </p>
        </template>
        <template v-else>
          <small class="connected-eyebrow">CONNECTION</small>
          <h1>连接设置</h1>
          <section class="connected-owner">
            <h2>恢复浏览器独立使用</h2>
            <p>断开后恢复原独立资料；已保存到桌面端的内容仍留在桌面端。</p>
            <button
              type="button"
              class="v3-secondary"
              :disabled="busy"
              @click="disconnectOpen = true"
            >
              断开连接，恢复独立使用
            </button>
          </section>
        </template>
        <p v-if="connection.message" class="connected-message" role="status">
          {{ connection.message }}
        </p>
        <p v-if="connection.unknownOperations" class="connected-message" role="status">
          {{ connection.unknownOperations }}
          项保存结果正在确认，恢复连接后会继续核对。
        </p>
        <p v-if="error" class="connected-error" role="alert">{{ error }}</p>
      </section>
    </div>
    <footer>当前使用桌面资料 · 原独立资料已封存</footer>
    <Dialog
      v-if="disconnectOpen"
      title="断开桌面连接？"
      @close="!busy && (disconnectOpen = false)"
    >
      <p>恢复原浏览器独立资料。连接期间已采集的内容保留在桌面端，不会复制到浏览器。</p>
      <p v-if="connection.unknownOperations">
        还有
        {{ connection.unknownOperations }}
        项保存结果未确认。断开不会把它们另存到独立资料。
      </p>
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="v3-dialog-actions">
        <button
          type="button"
          class="v3-secondary"
          :disabled="busy"
          @click="disconnectOpen = false"
        >
          继续连接</button
        ><button
          type="button"
          class="mg-primary"
          :disabled="busy"
          :aria-busy="busy"
          @click="disconnect"
        >
          {{ busy ? "正在断开…" : "断开并恢复独立使用" }}
        </button>
      </div>
    </Dialog>
  </main>
</template>

<style scoped>
.connected-workspace {
  padding: 0;
  min-height: 100dvh;
  background: var(--surface);
  display: flex;
  flex-direction: column;
}
.connected-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 25px 32px;
  border-bottom: 1px solid var(--line);
}
.connected-header img {
  width: 132px;
}
.connected-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}
.connected-status i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
.connected-status i.waiting {
  background: var(--amber);
}
.connected-layout {
  display: grid;
  grid-template-columns: 218px minmax(0, 1fr);
  flex: 1;
}
nav {
  padding: 28px 15px;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}
nav button {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  width: 100%;
  text-align: left;
  border-radius: 7px;
  color: var(--muted);
  margin-bottom: 7px;
}
nav button.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
nav :deep(img) {
  width: 16px;
  height: 16px;
}
.connected-content {
  width: 100%;
  max-width: 930px;
  padding: clamp(28px, 6vw, 76px);
}
.connected-eyebrow {
  color: var(--accent);
  letter-spacing: 0.15em;
  font-size: 10px;
}
h1 {
  font-size: clamp(26px, 3vw, 38px);
  line-height: 1.45;
  margin: 14px 0 20px;
  font-weight: 600;
}
h2 {
  font-size: 18px;
  margin-top: 0;
}
.connected-intro {
  font-size: 15px;
  line-height: 1.95;
  max-width: 660px;
  color: var(--muted);
  margin-bottom: 32px;
}
.connected-owner {
  padding: 26px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--subtle);
}
.connected-owner strong {
  display: block;
  font-size: 20px;
  margin-top: 12px;
}
.connected-owner p {
  margin: 12px 0;
  color: var(--muted);
  line-height: 1.85;
}
.connected-owner small {
  color: var(--muted);
  font-size: 11px;
}
.connected-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 24px;
}
.connected-actions button {
  min-height: 42px;
}
.connected-archive-note {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
  margin: 28px 0 0;
}
.connected-message {
  padding: 12px 16px;
  border-left: 2px solid var(--amber);
  background: var(--amber-bg);
  color: var(--muted);
  margin-top: 20px;
}
.connected-error {
  color: var(--danger);
  margin-top: 20px;
}
footer {
  border-top: 1px solid var(--line);
  padding: 12px 32px;
  color: var(--muted);
  font-size: 11px;
}
@media (max-width: 700px) {
  .connected-header {
    padding: 18px 22px;
  }
  .connected-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  nav {
    display: flex;
    padding: 10px 16px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    gap: 8px;
  }
  nav button {
    justify-content: center;
    margin: 0;
  }
  .connected-content {
    padding: 28px 22px;
  }
  footer {
    padding: 12px 22px;
  }
}
@media (max-width: 420px) {
  .connected-header {
    flex-wrap: wrap;
    gap: 12px;
  }
  .connected-owner {
    padding: 20px;
  }
  .connected-actions {
    display: grid;
  }
  nav button {
    padding: 10px;
    gap: 7px;
  }
}
</style>
