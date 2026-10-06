<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { browser } from "wxt/browser";
import { createWorkspace, workspaceKey } from "./workspace/useWorkspace.ts";
import Icon from "./Icon.vue";
import Today from "./workspace/Today.vue";
import Library from "./workspace/Library.vue";
import Encounters from "./workspace/Encounters.vue";
import Catalog from "./workspace/Catalog.vue";
import Practice from "./workspace/Practice.vue";
import Settings from "./workspace/Settings.vue";
import Insights from "./workspace/Insights.vue";
import PlanDialog from "./workspace/PlanDialog.vue";
import Dialog from "./workspace/Dialog.vue";
import WordCard from "./workspace/WordCard.vue";
import GuideCoach from "./workspace/GuideCoach.vue";
import { useOnboardingGuide } from "./workspace/useOnboardingGuide.ts";
import { call } from "./api.ts";
import { DEFAULT_READING_URL } from "../lib/reading-page.mjs";
import type { LibraryItem } from "../lib/workspace-model.ts";
import LearningForecast from "./workspace/LearningForecast.vue";
import type { Notebook } from "../lib/local-model.ts";
const tutorial = useOnboardingGuide();
const guideReturning = computed(
  () =>
    tutorial.state.value.active &&
    ["panel", "encounter", "capture", "floating"].includes(tutorial.step.value),
);
const ctx = createWorkspace();
provide(workspaceKey, ctx);
const {
  items,
  notebooks,
  plan,
  preferences,
  settings,
  busy,
  error,
  notice,
  ready,
  dictionary,
  daily,
  targetName,
} = ctx;
const nav: [string, string, string][] = [
  ["today", "今日学习", "sun"],
  ["plan", "学习规划", "list-check"],
  ["practice", "练习中心", "keyboard"],
  ["insights", "学习洞察", "eye"],
  ["library", "我的词库", "book-2"],
  ["encounters", "遇见记录", "history"],
  ["catalog", "词库中心", "folder"],
];
// 与桌面导航保持相同分组；浏览器继续使用“学习规划”的产品名称。
const navigationGroups = [
  { label: "学习", items: nav.slice(0, 4) },
  { label: "资料", items: nav.slice(4) },
];
const view = ref("today"),
  selectedNotebook = ref<string | null>(null),
  planOpen = ref(false),
  adjustPlan = ref(false),
  bookDialog = ref(false),
  editingBook = ref<Notebook | null>(null),
  bookName = ref(""),
  bookRecycle = ref<Notebook | null>(null),
  practice = ref<InstanceType<typeof Practice>>(),
  systemDark = ref(matchMedia("(prefers-color-scheme: dark)").matches),
  seedTarget = ref("");
const theme = computed(() =>
    settings.value.theme === "system"
      ? systemDark.value
        ? "dark"
        : "light"
      : settings.value.theme,
  ),
  title = computed(() =>
    view.value === "library" && selectedNotebook.value
      ? notebooks.value.find((n) => n.id === selectedNotebook.value)?.name
      : nav.find((n) => n[0] === view.value)?.[1] ||
        ({ settings: "设置", trash: "回收站" } as any)[view.value],
  );
async function openGuide() {
  try {
    await call("guide-start");
    // 后台打开独立教学阅读页；管理页仍保留当前路由与资料。
  } catch (e) {
    error.value = (e as Error).message;
  }
}
function navigate(next: string) {
  ctx.audio.stop();
  view.value = next;
  selectedNotebook.value = null;
  error.value = "";
  notice.value = "";
  location.hash = `/${next}`;
}
function chooseTarget(id?: string) {
  seedTarget.value = id || "";
  adjustPlan.value = false;
  planOpen.value = true;
}
async function learn(list: LibraryItem[]) {
  if (!list.length) return;
  navigate("practice");
  await nextTick();
  practice.value?.start(list);
}
function editNotebook(book: Notebook | null) {
  editingBook.value = book;
  bookName.value = book?.name || "";
  bookDialog.value = true;
}
async function saveNotebook() {
  const ok = await ctx.work(
    () =>
      editingBook.value
        ? ctx.library.updateNotebook(editingBook.value.id, editingBook.value.revision, {
            name: bookName.value,
          })
        : ctx.library.createNotebook(bookName.value),
    "单词本已保存",
  );
  if (ok) bookDialog.value = false;
}
async function recycleNotebook() {
  const book = bookRecycle.value;
  if (
    book &&
    (await ctx.work(
      () => ctx.library.updateNotebook(book.id, book.revision, { deleted: true }),
      "单词本已移到回收站",
    ))
  )
    bookRecycle.value = null;
}
const media = matchMedia("(prefers-color-scheme: dark)"),
  onTheme = () => (systemDark.value = media.matches);
const channel = new BroadcastChannel("leximeet-personal-changed");
let polling: ReturnType<typeof setInterval> | undefined;
function acceptHash() {
  const route = location.hash.replace(/^#\//, "");
  if (route === "onboarding") {
    void call("guide-overview");
    navigate("today");
    return;
  }
  if ([...nav.map((n) => n[0]), "settings", "trash"].includes(route)) {
    // 引导页与管理页共享入口，明确路由应退出引导而不丢失个人资料。
    selectedNotebook.value = null;
    view.value = route;
  }
}
watch(
  () => theme.value,
  () => (document.documentElement.style.colorScheme = theme.value),
);
watch(
  () => ctx.changeVersion.value,
  () => channel.postMessage({ changed: true }),
);
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
    void prepareManagementTab().catch((e) => (error.value = (e as Error).message));
}
function onVisibility() {
  if (document.visibilityState === "visible")
    void prepareManagementTab().catch((e) => (error.value = (e as Error).message));
}
let learningClock: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  learningClock = setInterval(() => {
    ctx.now.value = new Date();
  }, 30_000);
  browser.runtime.onMessage.addListener(onActivation);
  document.addEventListener("visibilitychange", onVisibility);
  media.addEventListener("change", onTheme);
  window.addEventListener("hashchange", acceptHash);
  acceptHash();
  channel.onmessage = () => {
    void ctx.refresh().catch((e) => (error.value = (e as Error).message));
  };
  try {
    await prepareManagementTab();
    await ctx.refresh();
  } catch (e) {
    error.value = (e as Error).message;
  }
  polling = setInterval(() => {
    if (document.visibilityState === "visible" && !busy.value)
      void ctx.refresh().catch((e) => (error.value = (e as Error).message));
  }, 15000);
});
onUnmounted(() => {
  clearInterval(learningClock);
  browser.runtime.onMessage.removeListener(onActivation);
  document.removeEventListener("visibilitychange", onVisibility);
  media.removeEventListener("change", onTheme);
  window.removeEventListener("hashchange", acceptHash);
  channel.close();
  if (polling) clearInterval(polling);
  ctx.audio.stop();
});
</script>
<template>
  <main
    class="app v3-app v3-management lm-workspace"
    :data-theme="theme"
    data-account-state="unavailable"
    data-desktop-state="unavailable"
  >
    <section class="mg-scene">
      <div class="mg-window">
        <header class="mg-titlebar">
          <span>词遇 LexiMeet</span
          ><small
            >{{ dictionary?.active === "core-text" ? "Core Text" : "Lite Text" }} 0.0.3
            <span class="v3-version">v1.0.0</span></small
          >
        </header>
        <div class="mg-frame">
          <aside class="mg-sidebar">
            <div class="mg-brand">
              <img
                :src="
                  theme === 'dark'
                    ? '/assets/brand/logo-dark.png'
                    : '/assets/brand/logo-light.png'
                "
                alt="词遇 LexiMeet"
              />
            </div>
            <nav aria-label="工作区导航">
              <section
                v-for="group in navigationGroups"
                :key="group.label"
                class="mg-navigation-group"
                role="group"
                :aria-label="group.label"
              >
                <h2 class="mg-navigation-label">{{ group.label }}</h2>
                <button
                  v-for="[id, label, icon] in group.items"
                  :key="id"
                  :data-guide="id === 'plan' ? 'plan-nav' : undefined"
                  :aria-current="
                    view === id && !(id === 'library' && selectedNotebook)
                      ? 'page'
                      : undefined
                  "
                  :class="{
                    active: view === id && !(id === 'library' && selectedNotebook),
                  }"
                  @click="navigate(id)"
                >
                  <Icon :name="icon" />{{ label
                  }}<small v-if="id === 'library'">{{
                    items.length.toLocaleString()
                  }}</small
                  ><small v-if="id === 'today'">{{ daily.pending.length }}</small>
                </button>
              </section>
            </nav>
            <div class="v3-notebooks">
              <div class="v3-notebook-head">
                <small>我的单词本</small
                ><button
                  aria-label="新建单词本"
                  title="新建单词本"
                  @click="editNotebook(null)"
                >
                  <Icon name="plus" />
                </button>
              </div>
              <div
                v-for="book in notebooks.filter((n) => !n.deletedAt)"
                :key="book.id"
                class="v3-notebook-item"
              >
                <button
                  :class="{ active: selectedNotebook === book.id }"
                  @click="
                    view = 'library';
                    selectedNotebook = book.id;
                  "
                >
                  <Icon name="bookmark" /><span>{{ book.name }}</span
                  ><small>{{
                    items.filter((i) => i.personal?.notebookIds.includes(book.id)).length
                  }}</small></button
                ><button :aria-label="`管理 ${book.name}`" @click="editNotebook(book)">
                  <Icon name="dots" />
                </button>
              </div>
            </div>
            <div class="mg-sidebar-bottom">
              <button :class="{ active: view === 'trash' }" @click="navigate('trash')">
                <Icon name="trash" />回收站</button
              ><button
                :class="{ active: view === 'settings' }"
                @click="navigate('settings')"
              >
                <Icon name="settings" />设置
              </button>
              <div class="mg-local-user">
                <!-- 本机身份使用通用头像，避免与产品品牌图标混淆。 -->
                <span class="local-user-avatar" aria-hidden="true">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <circle cx="12" cy="9" r="3" />
                    <path d="M6.6 18.5a5.5 5.5 0 0 1 10.8 0" />
                  </svg>
                </span>
                <strong>本机使用</strong>
              </div>
            </div>
          </aside>
          <section class="mg-main">
            <header class="mg-page-head">
              <h1>{{ title }}</h1>
              <button
                v-if="guideReturning"
                data-guide="guide-return"
                class="v3-secondary"
                @click="tutorial.act('guide-reading')"
              >
                返回阅读页 ↗
              </button>
              <button
                v-if="view === 'plan' && plan"
                class="v3-secondary"
                @click="
                  adjustPlan = true;
                  planOpen = true;
                "
              >
                调整计划
              </button>
            </header>
            <div class="mg-page-body">
              <GuideCoach surface="workspace" />
              <p v-if="!ready" role="status">正在读取本机资料与词典…</p>
              <Today
                v-if="view === 'today' && ready"
                @learn="learn"
                @plan="navigate('plan')"
                @target="chooseTarget"
                @practice="navigate('practice')"
                @read="browser.tabs.create({ url: DEFAULT_READING_URL })"
              />
              <section v-if="view === 'plan' && ready" class="v3-plan">
                <div v-if="!plan" class="v3-empty">
                  <h2>一个目标，一份清晰的安排。</h2>
                  <button
                    class="mg-primary"
                    data-guide="choose-target"
                    @click="chooseTarget()"
                  >
                    设置学习规划
                  </button>
                </div>
                <template v-else
                  ><article class="v3-current-plan">
                    <div>
                      <small>当前学习目标</small>
                      <h2>{{ targetName }}</h2>
                      <p>
                        {{ ctx.members.value.length.toLocaleString() }} 词 · 每天
                        {{ plan.dailyNew }} 新词 + {{ plan.dailyReview ?? 20 }} 复习词
                      </p>
                    </div>
                    <button
                      class="v3-secondary"
                      data-guide="choose-target"
                      @click="chooseTarget()"
                    >
                      更换学习目标
                    </button>
                  </article>
                  <section class="v3-forecast">
                    <label class="v3-check-row"
                      ><input
                        type="checkbox"
                        :checked="!plan.paused"
                        :disabled="busy"
                        @change="
                          ctx.pausePlan(!($event.target as HTMLInputElement).checked)
                        "
                      />启用学习计划</label
                    >
                    <p v-if="plan.paused">新词计划已暂停，已开始的词和到期复习可继续。</p>
                    <LearningForecast
                      @adjust="
                        adjustPlan = true;
                        planOpen = true;
                      "
                    /></section
                ></template>
              </section>
              <Library
                v-if="view === 'library' && ready"
                :notebook-id="selectedNotebook"
                @learn="learn([$event])"
              /><Encounters v-if="view === 'encounters' && ready" /><Catalog
                v-if="view === 'catalog' && ready"
                @target="chooseTarget"
              /><Practice
                ref="practice"
                v-if="ready"
                v-show="view === 'practice'"
                :active="view === 'practice'"
              /><Insights v-if="view === 'insights' && ready" /><Settings
                v-if="view === 'settings' && ready"
                @onboard="openGuide"
              />
              <section v-if="view === 'trash'" class="v3-trash">
                <h2>词条</h2>
                <div
                  v-for="word in ctx.words.value.filter((w) => w.deletedAt)"
                  :key="word.id"
                  class="v3-setting-row"
                >
                  <strong>{{ word.word }}</strong
                  ><button
                    class="v3-secondary"
                    @click="
                      ctx.work(() => ctx.library.setDeleted(word.id, false), '词条已恢复')
                    "
                  >
                    恢复词条
                  </button>
                </div>
                <h2>单词本</h2>
                <div
                  v-for="book in notebooks.filter((n) => n.deletedAt)"
                  :key="book.id"
                  class="v3-setting-row"
                >
                  <strong>{{ book.name }}</strong
                  ><button
                    class="v3-secondary"
                    @click="
                      ctx.work(
                        () =>
                          ctx.library.updateNotebook(book.id, book.revision, {
                            deleted: false,
                          }),
                        '单词本已恢复',
                      )
                    "
                  >
                    恢复单词本
                  </button>
                </div>
                <p
                  v-if="
                    !ctx.words.value.some((w) => w.deletedAt) &&
                    !notebooks.some((n) => n.deletedAt)
                  "
                  class="v3-empty"
                >
                  回收站是空的
                </p>
              </section>
            </div>
          </section>
        </div>
        <footer class="mg-statusbar">
          <span>资料保存在此浏览器</span><span>{{ targetName }}</span>
        </footer>
      </div>
    </section>
    <p v-if="error" class="v3-runtime-error" role="alert">{{ error }}</p>
    <p
      v-if="notice"
      :key="ctx.noticeVersion.value"
      class="v3-runtime-notice v3-notice-replay"
      role="status"
    >
      {{ notice }}
    </p>
    <PlanDialog
      v-if="planOpen"
      :adjust="adjustPlan"
      :source-id="seedTarget"
      @close="planOpen = false"
    /><Dialog
      v-if="bookDialog"
      :title="editingBook ? '管理单词本' : '新建单词本'"
      @close="bookDialog = false"
      ><form @submit.prevent="saveNotebook">
        <label class="v3-form-field"
          >单词本名称<input v-model="bookName" required maxlength="80" autofocus
        /></label>
        <footer class="v3-dialog-actions">
          <button
            v-if="editingBook"
            type="button"
            class="v3-danger"
            @click="
              bookRecycle = editingBook;
              bookDialog = false;
            "
          >
            移到回收站</button
          ><button type="button" class="v3-secondary" @click="bookDialog = false">
            取消</button
          ><button class="mg-primary" :disabled="busy || !bookName.trim()">
            保存单词本
          </button>
        </footer>
      </form></Dialog
    ><Dialog v-if="bookRecycle" title="回收单词本" @close="bookRecycle = null"
      ><p>回收“{{ bookRecycle.name }}”后，词条与阅读语境仍然保留。</p>
      <footer class="v3-dialog-actions">
        <button class="v3-secondary" @click="bookRecycle = null">取消</button
        ><button class="mg-primary" @click="recycleNotebook">确认回收</button>
      </footer></Dialog
    >
  </main>
</template>

<style scoped>
.v3-notice-replay {
  animation: notice-arrive 240ms ease-out;
}
@keyframes notice-arrive {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .v3-notice-replay {
    animation: none;
  }
}
</style>
