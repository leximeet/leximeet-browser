<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, provide } from "vue";
import { browser } from "wxt/browser";
import { call } from "./api.ts";
import type { BookMeta, LocalSettings } from "../lib/local-model.ts";
import type { Draft, PageState } from "../lib/types.ts";
import type { CaptureSwitch } from "../lib/page-session.ts";
import { encounterRows } from "../lib/page-session.ts";
import CaptureSwitchDialog from "./workspace/CaptureSwitchDialog.vue";
import type { LexiconEntry } from "../lib/lexicon.ts";
import { createWorkspace, workspaceKey } from "./workspace/useWorkspace.ts";
import WordCard from "./workspace/WordCard.vue";
import type { CurrentPage } from "../lib/site-access.ts";
import GuideCoach from "./workspace/GuideCoach.vue";
import Dialog from "./workspace/Dialog.vue";
import type { IntegrationStatus } from "../lib/application-services.ts";
import type { ConnectionView } from "../lib/desktop-connection.ts";
import type { NotebookRecord } from "../lib/connector/types.ts";
import ConnectedWordCard from "./ConnectedWordCard.vue";

type PanelState = {
  revision: number;
  workerEpoch: string;
  currentPage: CurrentPage;
  book: BookMeta | null;
  settings: LocalSettings;
  wordCount: number;
  page: PageState | null;
  captureSwitch: CaptureSwitch | null;
  storage: "local" | "desktop";
  connection: ConnectionView;
  tutorialPage: boolean;
  integration: IntegrationStatus;
};
const state = ref<PanelState | null>(null);
const desktopMode = computed(() => state.value?.storage === "desktop");
const desktopReady = computed(
  () => desktopMode.value && state.value?.connection.status === "connected",
);
const desktopBooks = ref<NotebookRecord[]>([]);
let booksGeneration = 0;
let booksPending = false;
let nextBooksRead = 0;
let booksExpiry: ReturnType<typeof setTimeout> | undefined;
let mounted = true;
async function refreshDesktopBooks() {
  if (!desktopReady.value) {
    ++booksGeneration;
    clearTimeout(booksExpiry);
    desktopBooks.value = [];
    nextBooksRead = 0;
    return;
  }
  if (booksPending || Date.now() < nextBooksRead) return;
  const generation = ++booksGeneration;
  booksPending = true;
  nextBooksRead = Date.now() + 10_000;
  try {
    const result = await call<{
      items: NotebookRecord[];
      refreshAfterMs: number;
    }>("desktop-notebooks");
    if (mounted && generation === booksGeneration && desktopReady.value) {
      clearTimeout(booksExpiry);
      desktopBooks.value = result.items;
      booksExpiry = setTimeout(
        () => {
          desktopBooks.value = [];
          nextBooksRead = 0;
          void refreshDesktopBooks();
        },
        Math.max(1, Math.min(result.refreshAfterMs, 30_000)),
      );
    }
  } catch (cause) {
    if (mounted && generation === booksGeneration) {
      clearTimeout(booksExpiry);
      desktopBooks.value = [];
      error.value = (cause as Error).message;
    }
  } finally {
    booksPending = false;
  }
}
const tab = ref<"encounter" | "capture">("encounter");
const error = ref("");
const notice = ref("");
const busy = ref(false);
const search = ref("");
const entry = ref<LexiconEntry | null>(null);
const ctx = createWorkspace();
provide(workspaceKey, ctx);
const cardItem = computed(() =>
  ctx.items.value.find((i) => i.key === selectedWord.value?.toLowerCase()),
);
const notebookId = ref("");
const editing = ref(false);
const endIntent = ref<"cancel" | "close" | null>(null);
const switchingTab = ref<"encounter" | "capture" | null>(null);
const openingManager = ref(false);
const captureSwitch = computed(
  () =>
    state.value?.captureSwitch ||
    (switchingTab.value || openingManager.value
      ? {
          title: state.value?.currentPage.title || "当前网页",
          unsavedCount: page.value?.drafts.length || 0,
        }
      : null),
);
const operation = ref("");
const incoming = ref(new Set<string>());
const flightWord = ref("");
let flightTimer: ReturnType<typeof setTimeout>;
const availableBooks = computed(() =>
  desktopMode.value
    ? desktopBooks.value
        .filter((n) => !n.deletedAt)
        .map((n) => ({ id: n.entityId, name: n.data.name }))
    : ctx.notebooks.value.filter((n) => !n.deletedAt),
);
const canSubmit = computed(
  () => !busy.value && (desktopMode.value ? desktopReady.value : !!notebookId.value),
);
const selectedWord = computed(() =>
  tab.value === "capture" ? selectedDraft.value?.surface : selected.value?.surface,
);

const selectedDraftId = ref<string | null>(null);
const excerpt = ref("");
const note = ref("");
const systemDark = ref(matchMedia("(prefers-color-scheme: dark)").matches);
const theme = computed(() =>
  state.value?.settings.theme === "system" || !state.value
    ? systemDark.value
      ? "dark"
      : "light"
    : state.value.settings.theme,
);
const page = computed(() => state.value?.page);
const occurrences = computed(() =>
  page.value?.resultMode === tab.value ? page.value.occurrences : [],
);
// 采集入口不建立候选列表；这里只显示用户实际点选的草稿。
const rows = computed(() =>
  (tab.value === "capture"
    ? (page.value?.drafts || []).map((draft) => ({
        ...occurrences.value.find((item) => item.id === draft.occurrenceId),
        id: draft.occurrenceId,
        eventId: draft.eventId,
        surface: draft.surface,
        normalized: draft.surface.toLowerCase(),
      }))
    : encounterRows(occurrences.value, page.value?.selectedId).map((item) => ({
        ...item,
        eventId: "",
      }))
  ).filter(
    (item) =>
      !search.value || item.surface.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const selected = computed(() =>
  occurrences.value.find((item) => item.id === page.value?.selectedId),
);
const selectedDraft = computed<Draft | undefined>(() =>
  tab.value === "capture"
    ? page.value?.drafts.find((item) =>
        selectedDraftId.value
          ? item.eventId === selectedDraftId.value
          : item.occurrenceId === page.value?.selectedId,
      )
    : undefined,
);
async function selectRow(item: (typeof rows.value)[number]) {
  selectedDraftId.value = item.eventId || null;
  if (occurrences.value.some((i) => i.id === item.id))
    await action("select", { id: item.id });
}
async function changeTab(next: "encounter" | "capture") {
  if (!state.value || next === tab.value || busy.value || captureSwitch.value) return;
  if (activeCapture.value) {
    switchingTab.value = next;
    return;
  }
  if (page.value?.phase === "analyzing") await action("cancel");
  tab.value = next;
  // 选择采集即是开始进行采集；网页不可读/失联仍走真实业务闸门并显示原因。
  if (next === "capture" && !page.value?.drafts.length)
    await action("analyze", { mode: "capture" });
}
async function finishSwitch(keep: boolean) {
  const remote = state.value?.captureSwitch;
  if (remote) {
    const ok = await action("capture-switch-decision", {
      decisionId: remote.id,
      continue: keep,
    });
    if (ok) {
      tab.value = keep ? "capture" : "encounter";
      switchingTab.value = null;
    }
  } else if (switchingTab.value || openingManager.value) {
    if (!keep && !(await action("discard-capture"))) return;
    const open = openingManager.value;
    if (!keep && switchingTab.value) tab.value = switchingTab.value;
    switchingTab.value = null;
    openingManager.value = false;
    if (!keep && open) await action("open-workspace");
    else if (keep && open && !activeCapture.value) {
      tab.value = "capture";
      await action("analyze", { mode: "capture" });
    }
  }
}
async function openManager() {
  if (busy.value || captureSwitch.value) return;
  if (activeCapture.value || page.value?.drafts.length) {
    openingManager.value = true;
    return;
  }
  await action("open-workspace");
}
async function requestEnd(intent: "cancel" | "close") {
  if (page.value?.drafts.length) {
    endIntent.value = intent;
    return;
  }
  await action(intent);
}
async function finishCapture(join: boolean) {
  const intent = endIntent.value;
  if (!intent) return;
  const ok = await action(
    join ? "submit" : "cancel",
    join ? { notebookId: notebookId.value } : {},
  );
  if (!ok) return; // 保存失败时保留草稿与确认框，用户可以重试或返回采集。
  endIntent.value = null;
  if (intent === "close") await action("close");
}
const activeCapture = computed(() => page.value?.phase === "capture");
let windowId: number | undefined;
let port: ReturnType<typeof browser.runtime.connect> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
let lookupGeneration = 0;
const media = matchMedia("(prefers-color-scheme: dark)");
const onTheme = () => {
  systemDark.value = media.matches;
};

async function refresh() {
  if (windowId === undefined) return;
  acceptState(await call<PanelState>("state", {}, windowId));
}
function acceptState(next: PanelState) {
  if (
    next.workerEpoch === state.value?.workerEpoch &&
    next.revision <= (state.value?.revision || 0)
  )
    return;
  if (
    next.currentPage.tabId !== state.value?.currentPage.tabId ||
    next.page?.generation !== state.value?.page?.generation ||
    next.storage !== state.value?.storage ||
    next.connection.status !== state.value?.connection.status
  ) {
    error.value = "";
    notice.value = "";
    selectedDraftId.value = null;
    entry.value = null;
    // 关闭后草稿仍在；首次附着或换回有草稿的网页时直接展示采集列表。
    if (next.page?.drafts.length) tab.value = "capture";
    ++lookupGeneration;
  }
  state.value = next;
  // 连接下不读取独立词库、学习偏好或单词本等。
  if (next.storage === "local")
    void ctx.refresh().catch((e) => {
      if (mounted && state.value?.storage === "local") error.value = (e as Error).message;
    });
  else void refreshDesktopBooks();
}
async function action(name: string, data: Record<string, unknown> = {}) {
  if (windowId === undefined || busy.value) return false;
  busy.value = true;
  operation.value = name;
  error.value = "";
  notice.value = "";
  try {
    const result = await call<any>(
      name,
      {
        ...(!["open-workspace", "close"].includes(name)
          ? { expectedTabId: state.value?.currentPage.tabId }
          : {}),
        ...data,
      },
      windowId,
    );
    if (name === "submit")
      notice.value = result.message || `已将 ${result.saved} 条语境加入单词本`;
    await refresh();
    return true;
  } catch (cause) {
    error.value = (cause as Error).message;
    return false;
  } finally {
    busy.value = false;
    operation.value = "";
  }
}
function connect() {
  if (windowId === undefined) return;
  port = browser.runtime.connect({ name: "leximeet-panel" });
  port.onMessage.addListener((message) => {
    if (message?.type === "state") acceptState(message.state as PanelState);
  });
  port.onDisconnect.addListener(() => {
    port = undefined;
  });
  port.postMessage({ type: "init", windowId });
}
async function editDraft() {
  if (!selectedDraft.value) return;
  await action("edit-draft", {
    eventId: selectedDraft.value.eventId,
    savedExcerpt: excerpt.value,
    note: note.value,
  });
}
watch(
  () => [
    page.value?.generation,
    page.value?.selectedId,
    selectedWord.value,
    desktopMode.value,
  ],
  async () => {
    const word = selectedWord.value;
    const generation = ++lookupGeneration;
    entry.value = null;
    if (!word || desktopMode.value) return;
    try {
      const found = await call<LexiconEntry | null>("lookup", { word }, windowId);
      if (generation === lookupGeneration) entry.value = found;
    } catch (cause) {
      if (generation === lookupGeneration) error.value = (cause as Error).message;
    }
  },
);
watch(
  () => selectedDraft.value?.eventId,
  () => {
    excerpt.value = selectedDraft.value?.savedExcerpt || "";
    note.value = selectedDraft.value?.annotation.note || "";
  },
);
watch(availableBooks, (books) => {
  if (!books.some((n) => n.id === notebookId.value))
    notebookId.value = books[0]?.id || "";
});
watch(
  () => page.value?.drafts,
  (next, before) => {
    if (!next || !before || next.length <= before.length) return;
    const added = next.filter((d) => !before.some((b) => b.eventId === d.eventId));
    if (!added.length) return;
    selectedDraftId.value = added.at(-1)!.eventId;
    incoming.value = new Set(added.map((d) => d.eventId));
    flightWord.value = added.at(-1)!.surface;
    clearTimeout(flightTimer);
    flightTimer = setTimeout(() => {
      incoming.value = new Set();
      flightWord.value = "";
    }, 850);
  },
);
// worker 重建只查询真实侧栏所属窗口，不能把普通扩展 tab 当作侧栏。
const presence = (message: any) => {
  if (message?.channel === "leximeet-panel-presence" && message.windowId === windowId)
    return Promise.resolve({ visible: document.visibilityState === "visible" });
};
onMounted(async () => {
  media.addEventListener("change", onTheme);
  const window = await browser.windows.getCurrent();
  windowId = window.id;
  browser.runtime.onMessage.addListener(presence);
  connect();
  await refresh().catch((cause) => {
    error.value = (cause as Error).message;
  });
  poll = setInterval(() => {
    if (!port) connect();
    void refresh().catch(() => {});
    // 有效侧栏持续续租，确保用户慢慢编辑摘录不会被 6 秒保护超时中断。
    if (activeCapture.value && !captureSwitch.value)
      void call(
        "lease",
        { expectedTabId: state.value?.currentPage.tabId },
        windowId,
      ).catch(() => {});
  }, 2000);
});
onUnmounted(() => {
  mounted = false;
  ++booksGeneration;
  ++lookupGeneration;
  media.removeEventListener("change", onTheme);
  if (poll) clearInterval(poll);
  port?.disconnect();
  clearTimeout(flightTimer);
  clearTimeout(booksExpiry);
  browser.runtime.onMessage.removeListener(presence);
  ctx.audio.stop();
});
</script>

<template>
  <main class="app v3-app lm-panel" :data-theme="theme">
    <header class="lm-header" aria-label="网页分析与采集操作">
      <button
        v-if="!activeCapture"
        data-guide="analyze"
        class="lm-primary"
        type="button"
        :disabled="
          busy ||
          page?.phase === 'analyzing' ||
          state?.currentPage.access !== 'ready' ||
          !!captureSwitch ||
          (desktopMode && !desktopReady)
        "
        :aria-busy="(busy && operation === 'analyze') || page?.phase === 'analyzing'"
        @click="action('analyze', { mode: tab })"
      >
        <span
          v-if="(busy && operation === 'analyze') || page?.phase === 'analyzing'"
          class="lm-spinner"
          aria-hidden="true"
        />
        {{
          (busy && operation === "analyze") || page?.phase === "analyzing"
            ? tab === "capture"
              ? "进入采集"
              : "分析本页"
            : tab === "capture"
              ? "开始采集"
              : "分析本页"
        }}
      </button>
      <button
        v-else
        class="lm-subtle"
        type="button"
        :disabled="busy || !state"
        @click="requestEnd('cancel')"
      >
        结束采集
      </button>

      <span v-if="activeCapture" class="lm-capturing" role="status"><i />采集中</span>
      <button
        class="lm-manage-button"
        data-guide="manage"
        type="button"
        aria-label="打开管理"
        :disabled="busy || !state"
        @click="openManager"
      >
        打开管理 <span aria-hidden="true">→</span>
      </button>
    </header>
    <div v-if="desktopMode" class="lm-local-banner">
      桌面工作区<span class="lm-muted">{{ desktopReady ? "已连接" : "等待连接" }}</span>
    </div>
    <div v-else class="lm-local-banner">
      我的词库<span class="lm-muted">{{ state?.wordCount ?? 0 }} 词</span>
    </div>
    <GuideCoach
      v-if="state && !desktopMode"
      surface="panel"
      :tab="tab"
      :capturing="activeCapture"
      :drafts="page?.drafts.length || 0"
      :tutorial-page="state?.tutorialPage"
      :encounter-ready="page?.phase === 'encounter' && !!page.occurrences.length"
    />
    <nav class="lm-tabs" aria-label="网页操作">
      <button
        type="button"
        data-guide="encounter-tab"
        :class="{ active: tab === 'encounter' }"
        :disabled="!state || busy || !!captureSwitch"
        :aria-busy="
          (busy && tab === 'encounter' && operation === 'analyze') ||
          (page?.phase === 'analyzing' && page.resultMode === 'encounter')
        "
        @click="changeTab('encounter')"
      >
        <span
          v-if="
            (busy && tab === 'encounter' && operation === 'analyze') ||
            (page?.phase === 'analyzing' && page.resultMode === 'encounter')
          "
          class="lm-spinner"
          aria-hidden="true"
        />遇见
      </button>
      <button
        type="button"
        data-guide="capture-tab"
        :class="{ active: tab === 'capture' }"
        :disabled="!state || busy || !!captureSwitch"
        :aria-busy="busy && tab === 'capture' && operation === 'analyze'"
        @click="changeTab('capture')"
      >
        <span
          v-if="busy && tab === 'capture' && operation === 'analyze'"
          class="lm-spinner"
          aria-hidden="true"
        />采集
      </button>
    </nav>
    <p v-if="!state" class="lm-access-note" role="status">正在加载词遇…</p>
    <p v-else-if="desktopMode && !desktopReady" class="lm-access-note" role="status">
      桌面连接暂不可用，遇见与采集暂停。
    </p>
    <p v-else-if="state?.currentPage.access !== 'ready'" class="lm-access-note">
      {{
        state?.currentPage.access === "loading"
          ? "正在等待网页加载"
          : "此页面不可用，请打开普通网页。"
      }}
    </p>
    <section
      class="lm-results"
      data-guide="picked-list"
      :aria-label="tab === 'capture' ? '已采集单词列表' : '遇见单词列表'"
    >
      <header class="lm-region-title">
        <strong>{{ tab === "capture" ? "已采集" : "本页遇见" }}</strong
        ><span>{{ rows.length }} {{ tab === "capture" ? "处" : "词" }}</span>
      </header>
      <label class="lm-search"
        ><span>⌕</span
        ><input
          v-model="search"
          type="search"
          aria-label="搜索本页单词"
          placeholder="搜索列表单词"
      /></label>
      <div class="lm-result-scroll">
        <button
          v-for="item in rows"
          :key="item.eventId || item.normalized"
          :data-event="item.eventId"
          type="button"
          class="lm-row"
          :class="{
            selected:
              tab === 'capture'
                ? item.eventId === selectedDraft?.eventId
                : item.id === selected?.id,
            incoming: incoming.has(item.eventId),
          }"
          @click="selectRow(item)"
        >
          <span
            ><strong>{{ item.surface }}</strong
            ><small>{{
              tab === "capture"
                ? "待加入"
                : item.status === "mastered"
                  ? "已熟悉"
                  : item.status === "review"
                    ? "待复习"
                    : item.status === "learning"
                      ? "学习中"
                      : "未学"
            }}</small></span
          ><span>›</span>
        </button>
        <div v-if="!rows.length" class="lm-empty">
          <img src="/assets/icons/book-2.svg" alt="" /><strong>{{
            search
              ? "没有匹配的词"
              : tab === "capture"
                ? "等待你摘下第一个词"
                : "遇见，从这里开始"
          }}</strong
          ><span>{{
            tab === "capture"
              ? "直接点击正文中的英文单词，它会来到这里。"
              : "分析当前网页，查看目标与已采集的词。"
          }}</span>
        </div>
      </div>
      <span v-if="flightWord" class="lm-pick-flight" aria-hidden="true">{{
        flightWord
      }}</span>
    </section>
    <section
      class="lm-detail"
      :class="{ 'has-word': !!selectedWord }"
      aria-label="选中单词的词卡"
    >
      <header class="lm-region-title">
        <strong>词卡</strong
        ><button
          v-if="selectedDraft && !desktopMode"
          type="button"
          title="编辑摘录和笔记"
          @click="editing = true"
        >
          编辑语境
        </button>
      </header>
      <div class="lm-card-body">
        <ConnectedWordCard
          v-if="desktopMode && selectedWord"
          :key="`${page?.generation}:${selectedWord}`"
          :word="selectedWord"
          :available="desktopReady"
        />
        <WordCard
          v-else-if="selectedWord && state && !desktopMode"
          :key="`${page?.generation}:${selectedWord}`"
          :item="cardItem"
          :word="selectedWord"
        />
        <p v-else class="lm-card-empty">选择列表中的词，查看释义与发音。</p>
      </div>
    </section>
    <section v-if="page?.drafts.length" class="lm-submit" aria-label="加入单词本">
      <div class="lm-submit-target">
        <span>待加入语境 · {{ page.drafts.length }} 条</span
        ><select
          v-model="notebookId"
          aria-label="选择单词本"
          :disabled="desktopMode && !desktopReady"
        >
          <option v-if="desktopMode" value="">默认归属</option>
          <option v-for="book in availableBooks" :key="book.id" :value="book.id">
            {{ book.name }}
          </option>
        </select>
      </div>
      <button
        data-guide="join"
        class="lm-primary"
        type="button"
        :disabled="!canSubmit"
        @click="action('submit', { notebookId })"
      >
        加入单词本
      </button>
    </section>
    <p v-if="error" class="lm-alert" role="alert">{{ error }}</p>
    <p v-if="notice" class="lm-notice" role="status">{{ notice }}</p>
    <footer
      class="lm-footer"
      role="contentinfo"
      aria-label="运行状态"
      :data-desktop-state="state?.connection.status || 'independent'"
    >
      <span v-if="desktopReady" class="lm-connection"
        ><i class="lm-dot" />已连接桌面端</span
      >
      <span v-else-if="desktopMode">等待桌面恢复连接 · 独立资料已封存</span>
      <span v-else-if="state?.connection.status === 'connecting'">正在连接桌面端…</span>
      <span v-else>浏览器独立运行</span>
    </footer>
    <CaptureSwitchDialog
      v-if="captureSwitch"
      :context="captureSwitch"
      :busy="busy"
      :error="error"
      @decide="finishSwitch"
    />
    <Dialog
      v-if="endIntent && !captureSwitch"
      title="将采集的单词加入单词本？"
      @close="endIntent = null"
    >
      <p>还有 {{ page?.drafts.length || 0 }} 条语境未加入。</p>
      <label class="lm-confirm-book"
        >单词本<select
          v-model="notebookId"
          aria-label="结束采集时选择单词本"
          :disabled="desktopMode && !desktopReady"
        >
          <option v-if="desktopMode" value="">默认归属</option>
          <option v-for="book in availableBooks" :key="book.id" :value="book.id">
            {{ book.name }}
          </option>
        </select></label
      >
      <p class="lm-muted">暂不加入会保留草稿，之后可以继续保存。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <footer class="lm-confirm-actions">
        <button
          type="button"
          class="lm-subtle"
          :disabled="busy"
          @click="endIntent = null"
        >
          继续采集</button
        ><button
          type="button"
          class="lm-subtle"
          :disabled="busy"
          @click="finishCapture(false)"
        >
          暂不加入，结束采集</button
        ><button
          type="button"
          class="lm-primary"
          :disabled="!canSubmit"
          @click="finishCapture(true)"
        >
          加入并结束
        </button>
      </footer>
    </Dialog>
    <Dialog
      v-if="editing && selectedDraft && !desktopMode"
      title="编辑采集语境"
      @close="editing = false"
    >
      <div class="lm-draft-edit">
        <label
          >保存摘录<textarea
            v-model="excerpt"
            rows="4"
            maxlength="4000"
            @change="editDraft"
          /></label
        ><label
          >笔记<textarea
            v-model="note"
            rows="2"
            maxlength="4000"
            @change="editDraft"
          /></label
        ><button
          class="lm-subtle"
          type="button"
          :disabled="busy"
          @click="
            action('remove-draft', {
              eventId: selectedDraft.eventId,
              occurrenceId: selectedDraft.occurrenceId,
            });
            editing = false;
          "
        >
          移除此处
        </button>
      </div>
    </Dialog>
  </main>
</template>
