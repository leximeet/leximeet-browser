<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkspace } from "./useWorkspace.ts";
import Icon from "../Icon.vue";
import type { LibraryItem } from "../../lib/workspace-model.ts";
const ctx = useWorkspace(),
  { daily, targetName, plan } = ctx,
  emit = defineEmits<{
    learn: [items: LibraryItem[]];
    plan: [];
    target: [];
    practice: [];
    read: [];
  }>();
const groups = [
  { id: "encountered", label: "今日遇见", icon: "history" },
  { id: "planned", label: "学习计划", icon: "list-check" },
  { id: "review", label: "复习计划", icon: "rotate-clockwise" },
] as const;
const selected = ref<(typeof groups)[number]["id"]>("encountered");
const group = computed(() => groups.find((g) => g.id === selected.value)!);
const currentItems = computed(() => daily.value[selected.value]);
function moveTab(event: KeyboardEvent, index: number) {
  const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!offset && !["Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next =
    event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + offset + 3) % 3;
  selected.value = groups[next]!.id;
  document.getElementById(`today-${selected.value}`)?.focus();
}
</script>
<template>
  <section class="v3-today">
    <section class="v3-home-dashboard" aria-label="今日学习概览">
      <div class="v3-home-lead">
        <div>
          <small>今日安排</small>
          <h2>
            {{
              daily.pending.length
                ? `还有 ${daily.pending.length} 个词，等你重逢`
                : daily.completed
                  ? "今天，继续按自己的节奏来"
                  : plan
                    ? "今天，按自己的节奏来"
                    : "从一次遇见，或一个目标开始"
            }}
          </h2>
          <p v-if="plan">{{ targetName }}</p>
          <button
            class="mg-primary"
            @click="
              daily.pending.length
                ? emit('learn', daily.pending)
                : plan
                  ? emit('plan')
                  : emit('target')
            "
          >
            <Icon name="player-play" />{{
              daily.pending.length
                ? "开始今日学习"
                : plan
                  ? "查看学习规划"
                  : "设置学习规划"
            }}<Icon name="arrow-right" />
          </button>
        </div>
        <div class="v3-home-completion">
          <span
            >初学 {{ daily.newDone }} / {{ plan?.dailyNew ?? 0 }} · 复习
            {{ daily.reviewDone }} / {{ plan?.dailyReview ?? 20 }}</span
          >
          <strong
            >{{ daily.completed
            }}<small> / {{ daily.completed + daily.pending.length }}</small></strong
          ><span>今日完成</span
          ><progress
            aria-label="今日完成进度"
            :value="daily.completed"
            :max="daily.completed + daily.pending.length || 1"
          />
        </div>
      </div>
      <div class="v3-home-sources" role="tablist" aria-label="今日任务">
        <button
          v-for="(g, index) in groups"
          :key="g.id"
          :id="`today-${g.id}`"
          role="tab"
          :aria-selected="selected === g.id"
          aria-controls="today-tasks"
          :tabindex="selected === g.id ? 0 : -1"
          @click="selected = g.id"
          @keydown="moveTab($event, index)"
        >
          <Icon :name="g.icon" /><span>{{ g.label }}</span>
          <strong>{{ daily[g.id].length }}</strong
          ><small>{{ selected === g.id ? "正在查看" : "查看单词" }}</small>
        </button>
      </div>
    </section>
    <section
      id="today-tasks"
      class="v3-daily-group"
      role="tabpanel"
      :aria-labelledby="`today-${selected}`"
    >
      <header>
        <h3>{{ group.label }}</h3>
        <small>{{ currentItems.length }} 词</small>
      </header>
      <button v-for="item in currentItems" :key="item.key" @click="emit('learn', [item])">
        <strong>{{ item.word }}</strong
        ><span>{{ item.meaning }}</span>
        <small>{{ daily.done.has(item.key) ? "巩固" : "学习" }}</small
        ><Icon name="chevron-right" />
      </button>
      <div v-if="!currentItems.length" class="v3-today-empty">
        <Icon :name="group.icon" />
        <p>
          {{
            selected === "encountered"
              ? "阅读时留下的语境，会出现在这里。"
              : selected === "planned"
                ? plan
                  ? "今天的新词已学完。"
                  : "选择一本词书，安排每天的学习。"
                : "暂时没有到期复习，按自己的节奏来。"
          }}
        </p>
        <button
          v-if="selected === 'encountered'"
          class="v3-secondary"
          @click="emit('read')"
        >
          去阅读<Icon name="arrow-right" />
        </button>
        <button
          v-if="selected === 'planned' && !plan"
          class="v3-secondary"
          @click="emit('target')"
        >
          设置学习规划
        </button>
      </div>
    </section>
  </section>
</template>
