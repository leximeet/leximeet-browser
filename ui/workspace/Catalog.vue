<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { browser } from "wxt/browser";
import Icon from "../Icon.vue";
import { call } from "../api.ts";
import Dialog from "./Dialog.vue";
import WordCard from "./WordCard.vue";
import { useWorkspace } from "./useWorkspace.ts";
import { dictionaryCache, CORE_DELTA } from "../../lib/dictionary-cache.ts";
import type { CoreCatalog, CatalogMember } from "../../lib/lexicon.ts";
import { fetchCoreDelta } from "../../lib/dictionary-download.ts";
import type { InstallProgress } from "../../lib/dictionary-installer.ts";
const emit = defineEmits<{ target: [id?: string] }>(),
  ctx = useWorkspace(),
  { catalogs, dictionary } = ctx;
const tab = ref("themes"),
  category = ref("exam"),
  search = ref(""),
  selected = ref<CoreCatalog | null>(null),
  selectedMembers = ref<CatalogMember[]>([]),
  selectedWord = ref(""),
  fileInput = ref<HTMLInputElement>(),
  upgrading = ref(false),
  progress = ref<InstallProgress | null>(null),
  confirmCore = ref(false);
type UpgradeTask = {
  controller: AbortController;
  worker?: Worker;
  rejectInstall?: (e: Error) => void;
};
let upgradeTask: UpgradeTask | null = null;

// 请求和 Worker 属于同一次升级；取消后的旧任务不能影响下一次安装。
function beginUpgrade(): UpgradeTask | null {
  if (upgradeTask) return null;
  const task = { controller: new AbortController() };
  upgradeTask = task;
  upgrading.value = true;
  progress.value = null;
  ctx.error.value = "";
  return task;
}
function finishUpgrade(task: UpgradeTask) {
  task.rejectInstall = undefined;
  task.controller.abort();
  task.worker?.terminate();
  task.worker = undefined;
  if (upgradeTask !== task) return;
  upgradeTask = null;
  upgrading.value = false;
  progress.value = null;
}
function stopUpgrade() {
  const task = upgradeTask;
  if (!task) return;
  // 先使任务失效，再中止异步操作，避免 catch/finally 覆盖新任务的状态。
  upgradeTask = null;
  task.rejectInstall?.(new Error("安装已取消"));
  finishUpgrade(task);
  upgrading.value = false;
  progress.value = null;
}
const books = computed(() =>
  catalogs.value.filter((c) =>
    search.value
      ? `${c.title} ${c.source}`.toLowerCase().includes(search.value.toLowerCase())
      : c.category === category.value,
  ),
);
async function preview(book: CoreCatalog) {
  selected.value = book;
  try {
    selectedMembers.value = await ctx.lexicon.catalogMembers(book.id);
    selectedWord.value = selectedMembers.value[0]?.word || "";
  } catch (e) {
    ctx.error.value = (e as Error).message;
  }
}
async function activate(edition: "lite-text" | "core-text") {
  await ctx.work(() => dictionaryCache.activate(edition), "词典已切换");
}
async function install(file: Blob, task = beginUpgrade()) {
  if (!task || upgradeTask !== task) return;
  try {
    const manifest = JSON.parse(
      await fetch(browser.runtime.getURL("/dictionaries/core/release.json"), {
        signal: task.controller.signal,
      }).then((r) => r.text()),
    );
    if (upgradeTask !== task) return;
    if (manifest.assets[CORE_DELTA.file].sha256 !== CORE_DELTA.sha256)
      throw new Error("内置清单与增量锁不符");
    const lite = ctx.allMembers.value.filter(
      (m) => m.matchMethod !== "dictionary" || m.position <= 26417,
    );
    await new Promise<void>((resolve, reject) => {
      task.rejectInstall = reject;
      const worker = new Worker(
        new URL("../../lib/dictionary-worker.ts", import.meta.url),
        { type: "module" },
      );
      task.worker = worker;
      worker.onmessage = ({ data }) => {
        if (upgradeTask !== task) return;
        if (data.progress) progress.value = data.progress;
        if (data.done) resolve();
        if (data.error) reject(new Error(data.error));
      };
      worker.onerror = () => reject(new Error("增量安装中断，原词典仍然生效"));
      worker.postMessage({
        file,
        liteIds: lite.slice(0, 26417).map((m) => m.entryId),
      });
    });
    if (upgradeTask !== task) return;
    // 首次安装也使后台原 Lite 匹配缓存失效，不能只刷新管理页而继续沿用旧候选。
    await call("settings-changed");
    if (upgradeTask !== task) return;
    await ctx.refresh();
    if (upgradeTask !== task) return;
    ctx.notice.value = "Core Text 已校验并生效";
    confirmCore.value = false;
  } catch (e) {
    if (upgradeTask === task) ctx.error.value = (e as Error).message;
  } finally {
    finishUpgrade(task);
  }
}
async function chooseFile(e: Event) {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (file) await install(file);
}
async function download() {
  const task = beginUpgrade();
  if (!task) return;
  try {
    // 请求始终在点击手势中；等待授权也属于这次任务，不改变默认四项权限。
    const grant = browser.permissions.request({
      origins: ["https://github.com/*", "https://release-assets.githubusercontent.com/*"],
    });
    const granted = await grant;
    if (upgradeTask !== task) return;
    if (!granted) {
      ctx.notice.value = "未授权下载，可选择本地增量包";
      return;
    }
    const file = await fetchCoreDelta(fetch, task.controller.signal);
    await install(file, task);
  } catch (e) {
    if (upgradeTask === task) ctx.error.value = (e as Error).message;
  } finally {
    finishUpgrade(task);
  }
}
function cancel() {
  stopUpgrade();
  ctx.notice.value = "安装已中止，可重新选择相同增量包；个人资料保留";
}
onUnmounted(stopUpgrade);
</script>
<template>
  <section class="v3-catalog">
    <nav class="v3-tabs" aria-label="词库中心内容">
      <button
        :class="{ active: tab === 'themes' }"
        :aria-pressed="tab === 'themes'"
        @click="tab = 'themes'"
      >
        主题词库</button
      ><button
        :class="{ active: tab === 'local' }"
        :aria-pressed="tab === 'local'"
        @click="tab = 'local'"
      >
        本地词典
      </button>
    </nav>
    <template v-if="tab === 'themes'"
      ><div class="v3-catalog-tools">
        <div class="v3-segmented" aria-label="主题词库分类">
          <button :aria-pressed="category === 'exam'" @click="category = 'exam'">
            考试</button
          ><button :aria-pressed="category === 'subject'" @click="category = 'subject'">
            专业
          </button>
        </div>
        <input
          v-model="search"
          type="search"
          aria-label="搜索考试与专业词书"
          placeholder="搜索考试与专业词书"
        />
      </div>
      <small class="v3-muted">{{ books.length }} 个主题</small>
      <div class="v3-catalog-grid">
        <button
          v-for="book in books"
          :key="book.id"
          class="mg-theme-card"
          @click="preview(book)"
        >
          <div>
            <span class="v3-catalog-icon"><Icon name="book-2" /></span
            ><small>{{ book.count.toLocaleString() }} 词</small>
          </div>
          <h3>{{ book.title }}</h3>
          <p>
            {{
              book.category === "exam"
                ? "在阅读中积累考试词汇。"
                : "连接专业阅读与真实语境。"
            }}
          </p>
          <footer>
            <small>{{ book.previewWords.join(" · ") }}</small
            ><Icon name="chevron-right" />
          </footer>
        </button>
      </div>
      <div v-if="!books.length" class="v3-empty">没有匹配的词书</div></template
    >
    <template v-else
      ><h2 class="v3-local-heading">本地词典</h2>
      <div
        v-for="(edition, i) in ['lite-text', 'core-text'] as const"
        :key="edition"
        class="v3-dictionary-row"
      >
        <span class="v3-dictionary-number">0{{ i + 1 }}</span>
        <div>
          <strong>{{ i === 0 ? "Lite Text" : "Core Text" }}</strong
          ><small
            >0.0.3 · {{ i === 0 ? "26,417 词 · 内置" : "117,902 词 · 增量升级" }} ·
            文字版</small
          >
        </div>
        <button
          v-if="dictionary?.active === edition"
          role="switch"
          aria-checked="true"
          :aria-label="`${i === 0 ? 'Lite Text' : 'Core Text'} 已启用`"
          class="v3-switch"
          disabled
        >
          <span /></button
        ><button
          v-else-if="i === 0 || dictionary?.coreInstalled"
          class="v3-secondary"
          @click="activate(edition)"
        >
          切换使用</button
        ><button v-else class="v3-secondary" @click="confirmCore = true">增量升级</button>
      </div>
      <div class="v3-dictionary-row disabled">
        <span class="v3-dictionary-number">03</span>
        <div><strong>Full Text</strong><small>仅桌面端 · 811,092 词</small></div>
        <button class="v3-secondary" disabled>桌面端提供</button>
      </div>
      <div class="v3-actions">
        <button class="v3-secondary" @click="emit('target', 'active-dictionary')">
          将当前词典设为学习目标</button
        ><a
          href="https://github.com/leximeet/leximeet-dictionary/releases/tag/v0.0.3"
          target="_blank"
          rel="noreferrer"
          >版本与来源 ↗</a
        >
      </div>
      <p v-if="upgrading" role="status">
        {{
          progress?.phase === "checking"
            ? "校验增量包…"
            : progress
              ? `安装 ${progress.count.toLocaleString()} / ${progress.total.toLocaleString()} 词`
              : "下载增量包…"
        }}
        <button @click="cancel">取消</button>
      </p></template
    >
    <Dialog v-if="selected" :title="selected.title" wide @close="selected = null"
      ><div class="v3-book-preview">
        <div class="v3-target-list">
          <button
            v-for="m in selectedMembers.slice(0, 100)"
            :key="m.entryId"
            :aria-pressed="selectedWord === m.word"
            @click="selectedWord = m.word"
          >
            <strong>{{ m.word }}</strong
            ><small>{{ m.meaning }}</small>
          </button>
        </div>
        <WordCard :word="selectedWord" />
      </div>
      <small>{{ selectedMembers.length.toLocaleString() }} 词 · 预览前 100 词</small>
      <footer class="v3-dialog-actions">
        <button class="v3-secondary" @click="selected = null">关闭</button
        ><button
          class="mg-primary"
          @click="
            emit('target', selected.id);
            selected = null;
          "
        >
          选择这本词库
        </button>
      </footer></Dialog
    >
    <Dialog v-if="confirmCore" title="升级 Core Text" @close="confirmCore = false"
      ><p>增加 91,485 词，下载约 50.8 MB 文字增量；校验成功后切换，个人资料保留。</p>
      <p v-if="upgrading" role="status">
        {{
          progress?.phase === "checking"
            ? "正在校验"
            : progress
              ? `安装 ${progress.count} / ${progress.total}`
              : "正在下载…"
        }}
      </p>
      <input ref="fileInput" type="file" accept=".zst" hidden @change="chooseFile" />
      <footer class="v3-dialog-actions">
        <button class="v3-secondary" :disabled="upgrading" @click="fileInput?.click()">
          选择本地增量包</button
        ><button class="mg-primary" :disabled="upgrading" @click="download">
          下载并升级</button
        ><button v-if="upgrading" class="v3-secondary" @click="cancel">取消安装</button>
      </footer></Dialog
    >
  </section>
</template>
