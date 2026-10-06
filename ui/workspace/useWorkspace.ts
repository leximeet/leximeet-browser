import { defaultLocalSettings } from "../../lib/local-model.ts";
import { localWriteError } from "../../lib/storage-health.ts";
import { computed, shallowRef, ref, inject, type InjectionKey } from "vue";
import { browser } from "wxt/browser";
import { localLibrary } from "../../lib/local-database.ts";
import { CoreLexiconProvider } from "../../lib/lexicon.ts";
import type { CatalogMember, CoreCatalog } from "../../lib/lexicon.ts";
import {
  defaultWorkspacePreferences,
  validWorkspacePreferences,
  localDay,
  type LibraryItem,
  type WorkspacePreferences,
} from "../../lib/workspace-model.ts";
import type {
  LocalEncounter,
  ReviewFact,
  UserWord,
  Notebook,
  StudyPlan,
  PracticeAttempt,
} from "../../lib/local-model.ts";
import type { DictionaryState } from "../../lib/dictionary-cache.ts";
import { LearningService } from "../../lib/learning-service.ts";
import { learningLibrary, learningDaily } from "../../lib/learning-workspace.ts";
import { call } from "../api.ts";
import { createPronunciationPlayer, type AudioState } from "../../lib/pronunciation.ts";
import type { PracticeSession } from "../../lib/practice-session.ts";
export function createWorkspace(
  options: {
    library?: import("../../lib/application-services.ts").PersonalLibraryRepository;
    lexicon?: CoreLexiconProvider;
  } = {},
) {
  const library = options.library ?? localLibrary,
    lexicon =
      options.lexicon ??
      new CoreLexiconProvider(
        browser.runtime
          .getURL("/dictionaries/core/manifest.json")
          .replace(/manifest\.json$/, ""),
      );
  const settings =
      ref<import("../../lib/local-model.ts").LocalSettings>(defaultLocalSettings()),
    preferences = ref<WorkspacePreferences>(defaultWorkspacePreferences());
  const words = shallowRef<UserWord[]>([]),
    encounters = shallowRef<LocalEncounter[]>([]),
    reviews = shallowRef<ReviewFact[]>([]),
    notebooks = shallowRef<Notebook[]>([]),
    attempts = shallowRef<PracticeAttempt[]>([]);
  const plan = ref<StudyPlan | null>(null),
    members = shallowRef<CatalogMember[]>([]),
    allMembers = shallowRef<CatalogMember[]>([]),
    catalogs = shallowRef<CoreCatalog[]>([]),
    dictionary = ref<DictionaryState | null>(null),
    checkpoints = shallowRef<Record<string, PracticeSession>>({});
  const busy = ref(false),
    error = ref(""),
    notice = ref(""),
    noticeVersion = ref(0),
    audioState = ref<AudioState>({ phase: "idle" }),
    ready = ref(false),
    changeVersion = ref(0);
  const audio = createPronunciationPlayer(
    () => {
      const a = document.createElement("audio");
      a.hidden = true;
      document.body.append(a);
      return a;
    },
    (s) => (audioState.value = s),
  );
  const learning = new LearningService(library.learning, lexicon);
  const now = ref(new Date());
  const baseItems = computed(() =>
    learningLibrary(
      members.value,
      words.value,
      encounters.value,
      reviews.value,
      attempts.value,
      now.value,
    ),
  );
  const daily = computed(() =>
    learningDaily(
      baseItems.value,
      encounters.value,
      attempts.value,
      plan.value,
      now.value,
    ),
  );
  // 待学习只是今日队列展示，不写学习事件，也不改变未学习筛选。
  const items = computed(() => {
    const scheduled = new Set(daily.value.pending.map((i) => i.key));
    return baseItems.value.map((i) =>
      i.status === "new" && scheduled.has(i.key) ? { ...i, scheduled: true } : i,
    );
  });
  const targetName = computed(() =>
    plan.value?.sourceKind === "dictionary"
      ? dictionary.value?.active === "core-text"
        ? "Core Text"
        : "Lite Text"
      : catalogs.value.find((c) => c.id === plan.value?.sourceId)?.title || "尚未设置",
  );
  async function refresh() {
    const [s, w, e, r, n, p, a, pref, cp, ds, cs, all] = await Promise.all([
      library.settings(),
      library.listWords(true),
      library.encounters(),
      library.reviews(),
      library.listNotebooks(true),
      library.plan(),
      library.practice(),
      library.workspaceMeta<WorkspacePreferences>("workspace"),
      library.workspaceMeta<Record<string, PracticeSession>>("checkpoints"),
      lexicon.state(),
      lexicon.listCatalogs(),
      lexicon.allMembers(),
    ]);
    const current = p;
    if (pref !== undefined && !validWorkspacePreferences(pref))
      throw new Error("工作区设置格式无效，原数据未修改");
    const source =
      current?.sourceKind === "dictionary"
        ? all
        : current
          ? await lexicon.catalogMembers(current.sourceId)
          : [];
    now.value = new Date();
    settings.value = s;
    words.value = w;
    encounters.value = e;
    reviews.value = r;
    notebooks.value = n;
    attempts.value = a;
    plan.value = current;
    preferences.value = pref ?? defaultWorkspacePreferences();
    checkpoints.value = cp || {};
    dictionary.value = ds;
    catalogs.value = cs;
    allMembers.value = all;
    members.value = source;
    ready.value = true;
  }
  function announce(message: string) {
    notice.value = message;
    noticeVersion.value++;
  }
  async function work(fn: () => Promise<unknown>, message = "") {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    notice.value = "";
    try {
      await fn();
      await refresh();
      // 提交事实后再通知其他管理页；不依赖提示文案是否为空或与上次相同。
      changeVersion.value++;
      announce(message);
      await call("settings-changed").catch(() => {});
      return true;
    } catch (e) {
      error.value = localWriteError(e);
      return false;
    } finally {
      busy.value = false;
    }
  }
  async function savePreferences(next: WorkspacePreferences) {
    return work(async () => {
      if (!validWorkspacePreferences(next))
        throw new Error("设置无效，请检查每词重复次数是否为 1–10 的整数");
      await library.saveWorkspaceMeta("workspace", next);
    }, "设置已保存");
  }
  async function savePlan(
    sourceKind: "catalog" | "dictionary",
    sourceId: string,
    dailyNew: number,
    dailyReview: number,
    expectedRevision = plan.value?.revision ?? 0,
  ) {
    const same =
      plan.value?.sourceKind === sourceKind && plan.value?.sourceId === sourceId;
    const ok = await work(
      () =>
        library.savePlan(
          {
            id: same ? plan.value!.id : crypto.randomUUID(),
            sourceKind,
            sourceId,
            sourceVersion: "0.0.3",
            dailyNew,
            dailyReview,
            startedOn: same
              ? plan.value!.startedOn
              : localDay(new Date(), plan.value?.timeZone),
            timeZone:
              plan.value?.timeZone ||
              Intl.DateTimeFormat().resolvedOptions().timeZone ||
              "UTC",
            savedAt: new Date().toISOString(),
            paused: same ? plan.value!.paused : false,
          },
          expectedRevision,
        ),
      "学习规划已保存",
    );
    if (ok) await call("plan-saved").catch(() => {});
    return ok;
  }
  async function ensurePersonal(item: LibraryItem, collected = false) {
    return (
      item.personal ||
      library.addWord(
        item.word,
        { meaning: item.meaning, phonetic: "" },
        collected,
        item.entryId,
      )
    );
  }
  function wordSelection(item: LibraryItem) {
    return {
      word: item.word,
      entryId: item.entryId || null,
      dictionaryHint: item.meaning,
      expectedRevision: item.personal?.revision ?? null,
    };
  }
  async function pausePlan(paused: boolean) {
    if (!plan.value) return;
    return work(
      () => library.savePlan({ ...plan.value!, paused }, plan.value!.revision ?? 0),
      paused ? "新词计划已暂停" : "新词计划已启用",
    );
  }
  async function saveCheckpoint(s: PracticeSession) {
    const next = {
      ...checkpoints.value,
      [s.scope]: { ...s, savedAt: new Date().toISOString() },
    };
    await library.saveWorkspaceMeta("checkpoints", next);
    checkpoints.value = JSON.parse(JSON.stringify(next));
    changeVersion.value++;
    announce("练习进度已保存");
  }
  return {
    library,
    lexicon,
    learning,
    now,
    pausePlan,
    settings,
    preferences,
    words,
    encounters,
    reviews,
    notebooks,
    attempts,
    plan,
    members,
    allMembers,
    catalogs,
    dictionary,
    checkpoints,
    busy,
    error,
    notice,
    noticeVersion,
    announce,
    ready,
    changeVersion,
    audioState,
    audio,
    items,
    daily,
    targetName,
    refresh,
    work,
    savePreferences,
    savePlan,
    ensurePersonal,
    wordSelection,
    saveCheckpoint,
  };
}
export type Workspace = ReturnType<typeof createWorkspace>;
export const workspaceKey: InjectionKey<Workspace> = Symbol("词遇工作区");
export function useWorkspace() {
  const ctx = inject(workspaceKey);
  if (!ctx) throw new Error("工作区未初始化");
  return ctx;
}
