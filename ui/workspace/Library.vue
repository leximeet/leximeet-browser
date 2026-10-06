<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import Dialog from "./Dialog.vue";
import WordCard from "./WordCard.vue";
import Icon from "../Icon.vue";
import { useWorkspace } from "./useWorkspace.ts";
import { primaryWordPos, wordPosLabel } from "../../lib/library-filters.ts";
import type { LibraryItem } from "../../lib/workspace-model.ts";
const props = defineProps<{ notebookId?: string | null }>(),
  ctx = useWorkspace(),
  { items, notebooks, busy } = ctx;
const emit = defineEmits<{ learn: [item: LibraryItem] }>();
const search = ref(""),
  status = ref("all"),
  sort = ref("recent"),
  pos = ref("all"),
  collection = ref("all"),
  page = ref(0),
  selectedKey = ref(""),
  edit = ref(false),
  add = ref(false),
  lookup = ref(""),
  note = ref(""),
  links = ref<string[]>([]),
  selecting = ref(false),
  checkedKeys = ref<string[]>([]),
  bulkBooks = ref(false),
  bulkLinks = ref<string[]>([]),
  detail = ref<HTMLElement>();
// 对话框固定使用打开时的词条版本；并发改变则拒绝整次保存并保留输入。
const editingItem = shallowRef<LibraryItem | null>(null),
  recycleItems = shallowRef<LibraryItem[]>([]),
  addingItems = shallowRef<LibraryItem[]>([]);
const activeBooks = computed(() => notebooks.value.filter((b) => !b.deletedAt));
const posIndex = computed(() => new Map(ctx.allMembers.value.map((m) => [m.entryId, m])));
const itemPos = (item: LibraryItem) =>
  primaryWordPos(posIndex.value.get(item.entryId) || item);
const posOptions = computed(() =>
  [...new Set(items.value.map(itemPos))].sort((a, b) =>
    wordPosLabel(a).localeCompare(wordPosLabel(b), "zh-CN"),
  ),
);
const rows = computed(() => {
  let list = items.value.filter(
    (i) => !props.notebookId || i.personal?.notebookIds.includes(props.notebookId),
  );
  if (search.value.trim()) {
    const q = search.value.trim().toLowerCase();
    list = list.filter((i) =>
      `${i.word} ${i.meaning} ${i.personal?.note || ""}`.toLowerCase().includes(q),
    );
  }
  if (status.value !== "all")
    list = list.filter((i) =>
      status.value === "unfamiliar"
        ? i.familiarity?.unfamiliarWord
        : i.status === status.value,
    );
  if (pos.value !== "all") list = list.filter((i) => itemPos(i) === pos.value);
  if (collection.value !== "all")
    list = list.filter((i) =>
      collection.value === "collected" ? i.collected : i.inTarget,
    );
  return [...list].sort((a, b) =>
    sort.value === "alphabetical"
      ? a.word.localeCompare(b.word)
      : sort.value === "encounters"
        ? b.encounterCount - a.encounterCount
        : (b.personal?.updatedAt || "").localeCompare(a.personal?.updatedAt || ""),
  );
});
const selected = computed(
    () => items.value.find((i) => i.key === selectedKey.value) || null,
  ),
  pages = computed(() => Math.max(1, Math.ceil(rows.value.length / 50))),
  pageRows = computed(() => rows.value.slice(page.value * 50, (page.value + 1) * 50)),
  checkedItems = computed(() =>
    items.value.filter((i) => checkedKeys.value.includes(i.key)),
  ),
  checkedPage = computed(
    () => pageRows.value.filter((i) => checkedKeys.value.includes(i.key)).length,
  ),
  pageAll = computed(
    () => !!pageRows.value.length && checkedPage.value === pageRows.value.length,
  );
watch([search, status, sort, pos, collection, () => props.notebookId], () => {
  page.value = 0;
  // 更换筛选/排序时清除批量选择，避免操作不可见的旧范围；翻页则保留选择。
  checkedKeys.value = [];
});
watch(
  rows,
  () => {
    if (!selected.value || !rows.value.some((i) => i.key === selectedKey.value))
      selectedKey.value = rows.value[0]?.key || "";
    page.value = Math.min(page.value, pages.value - 1);
  },
  { immediate: true },
);
watch(items, () => {
  const active = new Set(items.value.map((i) => i.key));
  checkedKeys.value = checkedKeys.value.filter((key) => active.has(key));
});
function toggleSelection() {
  if (busy.value) return;
  selecting.value = !selecting.value;
  checkedKeys.value = [];
}
function togglePage() {
  const keys = new Set(checkedKeys.value),
    remove = pageAll.value;
  for (const item of pageRows.value) remove ? keys.delete(item.key) : keys.add(item.key);
  checkedKeys.value = [...keys];
}
async function selectWord(item: LibraryItem) {
  selectedKey.value = item.key;
  await nextTick();
  if (matchMedia("(max-width: 1100px)").matches)
    detail.value?.scrollIntoView({ block: "start" });
}
async function openEdit() {
  if (busy.value) return;
  try {
    await ctx.refresh();
  } catch (e) {
    ctx.error.value = (e as Error).message;
    return;
  }
  const item = selected.value;
  if (!item) return;
  editingItem.value = item;
  note.value = item.personal?.note || "";
  links.value = [...(item.personal?.notebookIds || [])].filter((id) =>
    activeBooks.value.some((b) => b.id === id),
  );
  edit.value = true;
}
async function save() {
  const item = editingItem.value;
  if (!item) return;
  const ok = await ctx.work(
    () =>
      ctx.library.updatePersonalWords([ctx.wordSelection(item)], {
        kind: "edit",
        note: note.value,
        notebookIds: [...links.value],
      }),
    "个人笔记与单词本已保存到本机",
  );
  if (ok) edit.value = false;
}
async function addWord() {
  const text = lookup.value.trim();
  if (!text) return;
  const ok = await ctx.work(async () => {
    const e = await ctx.lexicon.lookup(text);
    await ctx.library.addWord(
      e?.word || text,
      { meaning: e?.translation || "", phonetic: e?.phonetic || "" },
      true,
      e?.entryId || null,
    );
  }, "已加入我的词库");
  if (ok) {
    add.value = false;
    selectedKey.value = text.toLowerCase();
  }
}
function recycle(list: LibraryItem[]) {
  if (!busy.value && list.length) recycleItems.value = [...list];
}
async function confirmRecycle() {
  const list = recycleItems.value;
  const ok = await ctx.work(
    () =>
      ctx.library.updatePersonalWords(list.map(ctx.wordSelection), { kind: "recycle" }),
    `已将 ${list.length} 个单词移到回收站`,
  );
  if (ok) {
    recycleItems.value = [];
    checkedKeys.value = [];
  }
}
function openBulkBooks() {
  if (busy.value || !checkedItems.value.length) return;
  addingItems.value = [...checkedItems.value];
  bulkLinks.value = [];
  bulkBooks.value = true;
}
async function saveBulkBooks() {
  const ok = await ctx.work(
    () =>
      ctx.library.updatePersonalWords(addingItems.value.map(ctx.wordSelection), {
        kind: "add-to-notebooks",
        notebookIds: [...bulkLinks.value],
      }),
    `已将 ${addingItems.value.length} 个单词加入所选单词本`,
  );
  if (ok) {
    bulkBooks.value = false;
    checkedKeys.value = [];
  }
}
</script>
<template>
  <section class="v3-library" :class="{ 'is-selecting': selecting }">
    <div class="mg-library-tools">
      <nav class="v3-segmented" aria-label="词条状态">
        <button
          v-for="[id, label] in [
            ['all', '全部'],
            ['new', '未学习'],
            ['learning', '学习中'],
            ['review', '待复习'],
            ['mastered', '已熟悉'],
            ['unfamiliar', '不熟悉'],
          ] as const"
          :key="id"
          :aria-pressed="status === id"
          @click="status = id"
        >
          {{ label }}
        </button>
      </nav>
      <label class="mg-search"
        ><Icon name="search" /><input
          v-model="search"
          type="search"
          placeholder="搜索单词、释义或笔记"
          aria-label="搜索我的词库"
      /></label>
      <button
        class="v3-icon-button"
        title="添加单词"
        aria-label="添加单词"
        @click="add = true"
      >
        <Icon name="plus" />
      </button>
      <button
        class="v3-icon-button"
        :aria-label="selecting ? '结束批量编辑' : '编辑单词列表'"
        :title="selecting ? '结束批量编辑' : '编辑单词列表'"
        :aria-pressed="selecting"
        :disabled="busy"
        @click="toggleSelection"
      >
        <Icon :name="selecting ? 'check' : 'pencil'" />
      </button>
    </div>
    <div class="v3-list-toolbar v3-library-filters">
      <div class="v3-library-filter-fields">
        <select v-model="sort" aria-label="单词排序">
          <option value="recent">最近更新</option>
          <option value="alphabetical">字母顺序</option>
          <option value="encounters">遇见次数</option>
        </select>
        <select
          v-model="pos"
          aria-label="按主词性筛选"
          title="按词典实际主词性筛选；无资料的词不推测词性"
        >
          <option value="all">全部词性</option>
          <option v-for="id in posOptions" :key="id" :value="id">
            {{ wordPosLabel(id) }}
          </option>
        </select>
        <select v-model="collection" aria-label="按来源筛选">
          <option value="all">全部来源</option>
          <option value="target">当前学习目标</option>
          <option value="collected">已采集与收藏</option>
        </select>
      </div>
      <small>{{ rows.length.toLocaleString() }} 词</small>
    </div>
    <div v-if="checkedItems.length" class="v3-library-bulk" aria-label="批量单词操作">
      <span>已选择 {{ checkedItems.length }} 词</span>
      <button class="v3-secondary" :disabled="busy" @click="openBulkBooks">
        加入单词本
      </button>
      <button class="v3-secondary" :disabled="busy" @click="recycle(checkedItems)">
        批量移到回收站
      </button>
      <button :disabled="busy" @click="checkedKeys = []">取消选择</button>
    </div>
    <div class="v3-library-split">
      <div class="v3-library-table">
        <div class="v3-table-head">
          <input
            v-if="selecting"
            type="checkbox"
            :checked="pageAll"
            :indeterminate="checkedPage > 0 && !pageAll"
            :disabled="!pageRows.length || busy"
            aria-label="选择当前页全部单词"
            @change="togglePage"
          />
          <span>单词</span><span>释义</span><span>状态</span><span>遇见</span>
        </div>
        <div class="v3-table-body">
          <div
            v-for="item in pageRows"
            :key="item.key"
            class="v3-library-row"
            :data-selected="selectedKey === item.key"
          >
            <label v-if="selecting" class="v3-library-select"
              ><input
                v-model="checkedKeys"
                type="checkbox"
                :value="item.key"
                :disabled="busy"
                :aria-label="`选择单词 ${item.word}`"
            /></label>
            <button :aria-pressed="selectedKey === item.key" @click="selectWord(item)">
              <strong>{{ item.word }}</strong
              ><span>{{ item.meaning }}</span>
              <small>{{
                {
                  new: item.scheduled ? "待学习" : "未学习",
                  learning: "学习中",
                  due: "待复习",
                  review: "待复习",
                  mastered: "已熟悉",
                }[item.status]
              }}</small
              ><small>{{ item.encounterCount }}</small>
            </button>
          </div>
          <p v-if="!rows.length" class="v3-empty">这里还没有单词</p>
        </div>
        <footer class="v3-pagination">
          <button :disabled="!page" @click="page--">上一页</button
          ><span>{{ page + 1 }} / {{ pages }}</span
          ><button :disabled="page >= pages - 1" @click="page++">下一页</button>
        </footer>
      </div>
      <aside ref="detail" class="v3-library-detail" aria-label="所选单词详情">
        <div class="v3-list-toolbar">
          <small
            >{{ selected ? rows.findIndex((i) => i.key === selected!.key) + 1 : 0 }} /
            {{ rows.length }}</small
          ><button :disabled="!selected || busy" @click="openEdit">
            <Icon name="pencil" />编辑个人内容
          </button>
        </div>
        <WordCard v-if="selected" :item="selected" />
        <footer v-if="selected" class="v3-actions">
          <button class="v3-secondary" :disabled="busy" @click="recycle([selected!])">
            <Icon name="trash" />移到回收站</button
          ><button class="v3-secondary" @click="emit('learn', selected!)">去练习</button>
        </footer>
      </aside>
    </div>
    <Dialog v-if="edit" title="编辑个人内容" @close="edit = false">
      <label class="v3-form-field"
        >我的笔记<textarea v-model="note" maxlength="4000" rows="4" />
      </label>
      <fieldset>
        <legend>加入单词本（可多选）</legend>
        <label v-for="book in activeBooks" :key="book.id" class="v3-check-row"
          ><input v-model="links" type="checkbox" :value="book.id" />{{
            book.name
          }}</label
        >
        <p v-if="!activeBooks.length" class="v3-muted">
          先在左侧新建单词本，即可加入多个分组。
        </p>
      </fieldset>
      <footer class="v3-dialog-actions">
        <button class="v3-secondary" @click="edit = false">取消</button
        ><button class="mg-primary" :disabled="busy" @click="save">保存修改</button>
      </footer>
    </Dialog>
    <Dialog v-if="recycleItems.length" title="移到回收站？" @close="recycleItems = []">
      <p>将 {{ recycleItems.length }} 个单词移到回收站？</p>
      <p class="v3-muted">
        {{
          recycleItems
            .slice(0, 5)
            .map((i) => i.word)
            .join("、")
        }}{{ recycleItems.length > 5 ? "…" : "" }}
      </p>
      <p>词条将从词库、学习目标队列和练习中隐藏；笔记与学习记录保留，可在回收站恢复。</p>
      <footer class="v3-dialog-actions">
        <button class="v3-secondary" :disabled="busy" @click="recycleItems = []">
          取消</button
        ><button class="mg-primary" :disabled="busy" @click="confirmRecycle">
          确认移到回收站
        </button>
      </footer>
    </Dialog>
    <Dialog v-if="bulkBooks" title="批量加入单词本" @close="bulkBooks = false">
      <p>将 {{ addingItems.length }} 个单词加入以下单词本，保留原有分组。</p>
      <fieldset>
        <legend>选择单词本（可多选）</legend>
        <label v-for="book in activeBooks" :key="book.id" class="v3-check-row"
          ><input v-model="bulkLinks" type="checkbox" :value="book.id" />{{
            book.name
          }}</label
        >
        <p v-if="!activeBooks.length" class="v3-muted">
          先在左侧新建单词本，即可加入多个分组。
        </p>
      </fieldset>
      <footer class="v3-dialog-actions">
        <button class="v3-secondary" @click="bulkBooks = false">取消</button
        ><button
          class="mg-primary"
          :disabled="busy || !bulkLinks.length"
          @click="saveBulkBooks"
        >
          保存单词本关联
        </button>
      </footer>
    </Dialog>
    <Dialog v-if="add" title="查词与添加" @close="add = false"
      ><form @submit.prevent="addWord">
        <label class="v3-form-field"
          >输入英文单词<input
            v-model="lookup"
            required
            maxlength="120"
            placeholder="例如 resilient" /></label
        ><WordCard v-if="lookup.trim()" :word="lookup.trim()" />
        <footer class="v3-dialog-actions">
          <button type="button" class="v3-secondary" @click="add = false">取消</button
          ><button class="mg-primary" :disabled="busy">加入我的词库</button>
        </footer>
      </form></Dialog
    >
  </section>
</template>
