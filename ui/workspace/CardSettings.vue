<script setup lang="ts">
import { ref } from "vue";
import Dialog from "./Dialog.vue";
import { useWorkspace } from "./useWorkspace.ts";
import {
  cardSettingsDraft,
  CARD_SECTION_LABELS,
  readableCardSections,
} from "../../lib/word-card-content.ts";
import type { CardField, WorkspacePreferences } from "../../lib/workspace-model.ts";
const props = defineProps<{ initialLevel?: WorkspacePreferences["card"]["level"] }>();
const emit = defineEmits<{ close: [] }>();
const ctx = useWorkspace();
const current = ctx.preferences.value.card;
const draft = ref(cardSettingsDraft(current, props.initialLevel));
function choose(level: WorkspacePreferences["card"]["level"]) {
  draft.value = cardSettingsDraft(draft.value, level);
}
function toggle(field: CardField, checked: boolean) {
  const sections = readableCardSections(draft.value);
  draft.value = {
    level: "custom",
    sections: checked
      ? [...new Set([...sections, field])]
      : sections.filter((item) => item !== field),
  };
}
async function save() {
  if (
    await ctx.savePreferences({
      ...ctx.preferences.value,
      card: { ...draft.value, sections: readableCardSections(draft.value) },
    })
  )
    emit("close");
}
</script>
<template>
  <Dialog title="词卡显示设置" wide @close="emit('close')">
    <p class="card-settings-help">
      完整预设默认全选。调整字段会转为自定义，点击保存后生效。
    </p>
    <div class="card-settings-levels" aria-label="词卡内容预设">
      <button
        v-for="[id, label] in [
          ['minimal', '极简'],
          ['moderate', '适中'],
          ['detailed', '详细'],
          ['complete', '完整'],
          ['custom', '自定义'],
        ] as const"
        :key="id"
        type="button"
        :aria-pressed="draft.level === id"
        @click="choose(id)"
      >
        {{ label }}
      </button>
    </div>
    <div class="card-settings-fields">
      <label v-for="(label, field) in CARD_SECTION_LABELS" :key="field">
        <input
          type="checkbox"
          :checked="readableCardSections(draft).includes(field)"
          @change="toggle(field, ($event.target as HTMLInputElement).checked)"
        /><span>{{ label }}</span>
      </label>
    </div>
    <footer class="v3-dialog-actions">
      <button
        class="v3-secondary"
        type="button"
        :disabled="ctx.busy.value"
        @click="emit('close')"
      >
        取消
      </button>
      <button class="mg-primary" type="button" :disabled="ctx.busy.value" @click="save">
        保存词卡设置
      </button>
    </footer>
  </Dialog>
</template>
<style scoped>
.card-settings-help {
  color: var(--muted);
  line-height: 1.8;
}
.card-settings-levels {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 18px 0;
}
.card-settings-levels button {
  min-height: 36px;
  padding: 7px 14px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  background: var(--surface);
}
.card-settings-levels button[aria-pressed="true"] {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent);
}
.card-settings-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(190px, 100%), 1fr));
  gap: 12px 18px;
}
.card-settings-fields label {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  line-height: 1.6;
}
.card-settings-fields input {
  flex: none;
  margin-top: 4px;
}
</style>
