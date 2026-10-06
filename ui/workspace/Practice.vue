<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { learningDay } from "../../lib/learning.ts";
import { createPracticeFeedback } from "../../lib/practice-feedback.ts";
import { useWorkspace } from "./useWorkspace.ts";
import Dialog from "./Dialog.vue";
import Icon from "../Icon.vue";
import WordCard from "./WordCard.vue";
import PracticeList from "./PracticeList.vue";
import WrittenPractice from "./WrittenPractice.vue";
import {
  currentTurn,
  createPracticeSession,
  setPracticeMode,
  chooseMeaning,
  typeCharacter,
  backspaceCharacter,
  revealSpelling,
  settleSpelling,
  nextPracticeWord,
  previousPracticeWord,
  practiceCompletedCount,
  practiceWordCompleted,
  restorePracticeSession,
  validPracticeSession,
  retainPracticeWords,
  spellingSentence,
  conciseMeaning,
  PRACTICE_LABELS,
  selectPracticeWord,
  revealListWord,
  answerListWord,
  listRecall,
  updateWrittenAnswer,
  submitWrittenAnswer,
  clozeQuestion,
  maskHeadword,
  type PracticeMode,
  type PracticeSession,
} from "../../lib/practice-session.ts";
import type {
  FrozenQuestion,
  PracticeSubmission,
} from "../../lib/learning-repository.ts";
import type { LexiconEntry } from "../../lib/lexicon.ts";
import type { LibraryItem } from "../../lib/workspace-model.ts";
const props = defineProps<{ active: boolean }>(),
  ctx = useWorkspace(),
  { items, daily, notebooks, preferences, checkpoints } = ctx;
const sounds = createPracticeFeedback();
const session = ref<PracticeSession | null>(null),
  scope = ref("today"),
  snapshot = ref<LibraryItem[]>([]),
  entry = ref<LexiconEntry | null>(null),
  typingInput = ref<HTMLInputElement>(),
  settingsOpen = ref(false),
  showWords = ref(false),
  showCard = ref(false),
  pendingScope = ref(""),
  feedback = ref(""),
  draft = ref({ ...preferences.value.practice }),
  loading = ref(false),
  transitioning = ref(false),
  question = ref<FrozenQuestion | null>(null),
  saving = ref(0),
  retry = ref<(() => Promise<void>) | null>(null),
  scoreFeedback = ref<{
    sessionId: string;
    key: string;
    mode: PracticeMode;
    score: number;
    delta: number;
    effective: boolean;
  } | null>(null);
let recordQueue: Promise<unknown> = Promise.resolve();
let requestedStart: LibraryItem[] | null = null;
let timer: ReturnType<typeof setTimeout> | undefined,
  generation = 0,
  started = Date.now(),
  dirty = false,
  disposed = false,
  preparedCue = "";
let acknowledgedCue: { key: string; deadline: number } | null = null;
const modes = PRACTICE_LABELS;
const current = computed(() => snapshot.value[session.value?.index || 0] || null),
  turn = computed(() => (session.value ? currentTurn(session.value) : null)),
  mode = computed(() => session.value?.mode || "meaning-choice"),
  finished = computed(
    () =>
      !!session.value &&
      session.value.index >= snapshot.value.length &&
      snapshot.value.length > 0,
  ),
  completedCount = computed(() =>
    session.value ? practiceCompletedCount(session.value) : 0,
  ),
  currentCompleted = computed(() =>
    session.value ? practiceWordCompleted(session.value) : false,
  ),
  spellingComplete = computed(
    () =>
      turn.value?.phase === "success" &&
      (currentCompleted.value ||
        (turn.value.round || 0) >= (session.value?.preferences.repeat || 1)),
  ),
  currentRepeat = computed(() =>
    currentCompleted.value
      ? Math.max(1, turn.value?.round || 0)
      : session.value?.preferences.repeat || 1,
  );
const choices = computed(
  () =>
    question.value?.options.map((c) => ({
      ...c,
      correct: c.id === question.value!.correctChoiceId,
    })) || [],
);
const liveItem = computed(
  () => items.value.find((i) => i.key === current.value?.key) || current.value,
);
// 回执必须属于当前词、方式和本次练习；不能把另一行的揭示分数放到顶部。
const scoreLabel = computed(() => {
  const receipt = scoreFeedback.value;
  if (
    receipt?.sessionId === session.value?.id &&
    receipt?.key === current.value?.key &&
    receipt?.mode === mode.value
  )
    return `${receipt.score} / 30 分 · ${receipt.delta > 0 ? "+" : ""}${receipt.delta}${receipt.effective ? "" : "（已记录）"}`;
  return `${liveItem.value?.familiarity?.score ?? 10} / 30 分`;
});
const listItems = computed(() => {
  const live = new Map(items.value.map((item) => [item.key, item]));
  return snapshot.value.map((item) => live.get(item.key) || item);
});
// 今日断点属于某一天、某个目标；调整额度可继续，换目标或跨日重新建立范围。
function practiceContext(next = scope.value) {
  if (next !== "today") return undefined;
  const plan = ctx.plan.value;
  return {
    studyDay: learningDay(
      new Date(),
      plan?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    ),
    goalKey: plan
      ? JSON.stringify([plan.id, plan.sourceKind, plan.sourceId, plan.sourceVersion])
      : null,
  };
}
const meaning = computed(() =>
  entry.value
    ? conciseMeaning(entry.value.raw) || entry.value.translation
    : current.value?.meaning || "本词暂无释义",
);
// 从真实语境和公共例句挑选，填空必须精确包含本词，不能使用无关句子。
const examples = computed(() => [
  ...ctx.encounters.value
    .filter((e) => !e.undoneAt && e.wordId === current.value?.personal?.id)
    .map((e) => e.savedExcerpt),
  ...(entry.value?.senses.flatMap((s) => s.examples).map((e) => e.text) || []),
]);
const example = computed(() => examples.value[0] || "");
const cloze = computed(() => clozeQuestion(current.value?.word || "", examples.value));
const interactionsReady = computed(
  () =>
    props.active &&
    !transitioning.value &&
    !retry.value &&
    !settingsOpen.value &&
    !pendingScope.value &&
    !showWords.value &&
    !showCard.value,
);
const targetItems = (next: string) =>
  next === "today"
    ? daily.value.pending
    : next === "library"
      ? items.value
      : next === "target"
        ? items.value.filter((i) => i.inTarget)
        : items.value.filter((i) => i.personal?.notebookIds.includes(next.slice(9)));
const scopes = computed(() => [
  { id: "today", label: "今日学习", count: daily.value.pending.length },
  {
    id: "target",
    label: "当前学习目标",
    count: items.value.filter((i) => i.inTarget).length,
  },
  { id: "library", label: "我的词库", count: items.value.length },
  ...notebooks.value
    .filter((n) => !n.deletedAt)
    .map((n) => ({
      id: `notebook:${n.id}`,
      label: n.name,
      count: items.value.filter((i) => i.personal?.notebookIds.includes(n.id)).length,
    })),
]);
function cueKey(s: PracticeSession, item = snapshot.value[s.index]) {
  return JSON.stringify([s.id, item?.key, s.mode]);
}
// 离开、换方式或重开同时废弃旧倒计时和在途题目，迟到结果不能换掉当前画面。
function cancelTransition() {
  clearTimeout(timer);
  acknowledgedCue = null;
  generation++;
  transitioning.value = false;
  loading.value = false;
}
function activate(next: string, preferred: PracticeMode = mode.value) {
  cancelTransition();
  scope.value = next;
  const live = targetItems(next),
    known = new Map(items.value.map((i) => [i.key, i])),
    checkpoint = checkpoints.value[next],
    activeKeys = new Set(known.keys());
  const saved = restorePracticeSession(
    validPracticeSession(checkpoint)
      ? retainPracticeWords(checkpoint, activeKeys)
      : checkpoint,
    activeKeys,
    practiceContext(next),
  );
  session.value =
    (saved && { ...saved, preferences: { ...preferences.value.practice } }) ||
    createPracticeSession(
      live.map((i) => i.key),
      next,
      preferred,
      preferences.value.practice,
      practiceContext(next),
    );
  snapshot.value = saved ? saved.ids.map((id) => known.get(id)!) : live;
  dirty = false;
  feedback.value = "";
  scoreFeedback.value = null;
  started = Date.now();
}
function changeScope(next: string) {
  if (saving.value || retry.value) return;
  if (next === scope.value) return;
  if (dirty && session.value) {
    pendingScope.value = next;
    return;
  }
  activate(next);
}
async function confirmScope(save: boolean) {
  const next = pendingScope.value;
  if (save && session.value)
    try {
      await ctx.saveCheckpoint(JSON.parse(JSON.stringify(session.value)));
    } catch (e) {
      ctx.error.value = (e as Error).message;
      return;
    }
  pendingScope.value = "";
  activate(next);
  if (requestedStart) {
    const list = requestedStart;
    requestedStart = null;
    start(list);
  }
}
function changeMode(next: PracticeMode) {
  if (saving.value || retry.value) return;
  if (session.value && next === mode.value) return;
  cancelTransition();
  if (!session.value) activate(scope.value, next);
  else session.value = setPracticeMode(session.value, next);
  dirty = true;
  feedback.value = "";
  scoreFeedback.value = null;
  ctx.audio.stop();
}
// 每次提交先等待事务确认；失败保留同一 submissionId 重试，不能带着未保存反馈换词。
function record(
  correct: boolean,
  answer: string,
  item = current.value,
  signal?: PracticeSubmission["signal"],
) {
  if (!session.value || !item || retry.value) return Promise.resolve();
  const activeSession = session.value,
    activeMode = mode.value,
    index = snapshot.value.indexOf(item),
    at = Date.now(),
    submittedCue = cueKey(activeSession, item),
    shownQuestion = preparedCue === submittedCue ? question.value : null,
    completed =
      !signal &&
      (activeMode === "word-list"
        ? ["familiar", "unfamiliar"].includes(answer)
        : activeMode === "meaning-choice"
          ? currentTurn(activeSession).phase === "answered"
          : correct &&
            currentTurn(activeSession).phase === "success" &&
            currentTurn(activeSession).round >= activeSession.preferences.repeat);
  const submissionId = crypto.randomUUID();
  let submittedGeneration = generation;
  const perform = async () => {
    try {
      const q =
        shownQuestion ||
        (await ctx.learning.prepare(
          activeSession.id,
          item,
          activeMode,
          activeSession.preferences.ignoreCase,
          ctx.encounters.value
            .filter((e) => !e.undoneAt && e.wordId === item.personal?.id)
            .map((e) => e.savedExcerpt),
          index,
        ));
      const receipt = await ctx.library.learning.submit({
        submissionId,
        attemptId: q.attemptId,
        ...(signal
          ? { signal }
          : activeMode === "word-list"
            ? { signal: answer as "familiar" | "unfamiliar" }
            : activeMode === "meaning-choice"
              ? { choiceId: answer }
              : { answer }),
        assisted:
          activeMode === "word-list"
            ? listRecall(activeSession, item.key).revealed
            : !!currentTurn(activeSession).hint,
        durationMs: Math.max(0, at - started),
      });
      // 事务回执属于已冻结的原题；卸载/归属切换后不再刷新或恢复旧管理界面。
      if (disposed) return;
      await ctx.refresh();
      if (disposed) return;
      ctx.changeVersion.value++;
      retry.value = null;
      ctx.error.value = "";
      if (session.value?.id === activeSession.id) {
        session.value = {
          ...session.value,
          results: [
            ...session.value.results,
            {
              key: item.key,
              mode: activeMode,
              correct: receipt.event.correct,
              completed:
                completed &&
                (["word-list", "meaning-choice"].includes(activeMode) ||
                  receipt.event.correct),
            },
          ],
        };
        scoreFeedback.value = {
          sessionId: activeSession.id,
          key: item.key,
          mode: activeMode,
          score: receipt.score,
          delta: receipt.delta,
          effective: receipt.effective,
        };
        if (
          props.active &&
          generation === submittedGeneration &&
          cueKey(session.value) === submittedCue &&
          receipt.event.correct
        )
          acknowledgedCue = { key: submittedCue, deadline: performance.now() + 1000 };
      }
    } catch (e) {
      if (disposed) return;
      ctx.error.value = (e as Error).message;
      retry.value = async () => {
        // 显式重试是新的继续意图，沿用事实ID，但重新绑定当前未撤销的界面代次。
        submittedGeneration = generation;
        saving.value++;
        await perform();
      };
    } finally {
      saving.value--;
      schedule();
    }
  };
  saving.value++;
  recordQueue = recordQueue.then(perform);
  return recordQueue;
}
function choose(id: string) {
  if (
    !session.value ||
    !question.value ||
    preparedCue !== cueKey(session.value) ||
    loading.value ||
    transitioning.value ||
    turn.value?.answer !== null ||
    saving.value ||
    retry.value
  )
    return;
  const correct = id === question.value.correctChoiceId;
  session.value = chooseMeaning(session.value, id, question.value.correctChoiceId!);
  dirty = true;
  void record(correct, id);
  feedback.value = correct ? "选择正确" : "看看正确释义，再继续";
  void sounds.play(
    correct ? "correct" : "incorrect",
    session.value.preferences.soundFeedback !== false,
  );
}
function selectListWord(index: number) {
  if (!session.value || saving.value || retry.value) return;
  const next = selectPracticeWord(session.value, index);
  if (next === session.value) return;
  ctx.audio.stop();
  cancelTransition();
  session.value = next;
  dirty = true;
  feedback.value = "";
  scoreFeedback.value = null;
  started = Date.now();
}
function revealList(key: string) {
  if (
    saving.value ||
    retry.value ||
    !session.value ||
    listRecall(session.value, key).revealed
  )
    return;
  const item = snapshot.value.find((i) => i.key === key);
  void record(false, "", item, "reveal");
  if (session.value) session.value = revealListWord(session.value, key);
  dirty = true;
}
function maskList() {
  if (saving.value || retry.value) return;
  if (!session.value) return;
  session.value = {
    ...session.value,
    listMask: session.value.listMask === "word" ? "meaning" : "word",
  };
  dirty = true;
}
function answerList(index: number, answer: "familiar" | "unfamiliar") {
  const item = snapshot.value[index];
  if (!session.value || !item || listRecall(session.value, item.key).answer !== null)
    return;
  if (saving.value || retry.value) return;
  selectListWord(index);
  session.value = answerListWord(session.value, item.key, answer);
  dirty = true;
  void record(answer === "familiar", answer, item);
  void sounds.play(
    answer === "familiar" ? "correct" : "incorrect",
    session.value.preferences.soundFeedback !== false,
  );
}
function updateAnswer(input: string) {
  if (!session.value) return;
  const next = updateWrittenAnswer(session.value, input);
  if (next === session.value) return;
  session.value = next;
  dirty = true;
  feedback.value = "";
  void sounds.play("type", next.preferences.soundFeedback !== false);
}
function submitAnswer() {
  if (loading.value || saving.value || retry.value) return;
  if (!session.value || !current.value || (mode.value === "cloze" && !cloze.value))
    return;
  const next = submitWrittenAnswer(session.value, current.value.word);
  if (next === session.value) return;
  session.value = next;
  dirty = true;
  const correct = currentTurn(next).correct === true;
  feedback.value = correct ? "拼写正确" : "再回想一下";
  void record(correct, currentTurn(next).input || "");
  void sounds.play(
    correct ? "correct" : "incorrect",
    next.preferences.soundFeedback !== false,
  );
}
function hintSpelling() {
  if (saving.value || retry.value) return;
  if (!turn.value?.hint && mode.value !== "copy")
    void record(false, "", current.value, "reveal");
  if (session.value) session.value = revealSpelling(session.value);
  dirty = true;
  typingInput.value?.focus();
}
function playListening() {
  if (current.value && interactionsReady.value)
    void ctx.audio.play(current.value.word, preferences.value.pronunciation);
}
// 听音是题目本身：进入该方式或下一词时播放；换方式、弹窗及离开页面停止旧音频。
watch(
  [
    () => current.value?.key,
    () => mode.value,
    () => interactionsReady.value,
    () => session.value?.id,
  ],
  ([, nextMode, ready], previous) => {
    if (nextMode === "listening" && ready) playListening();
    // 自动换词允许完成后的朗读播完；换方式、弹窗和退出才取消旧声音。
    else if (!ready || nextMode !== previous[1]) ctx.audio.stop();
  },
);
// 新一轮生成新题身份；分数保留且次数不限，先保存新断点再替换当前草稿。
async function restartPractice() {
  if (saving.value || retry.value || !snapshot.value.length) return;
  cancelTransition();
  ctx.audio.stop();
  const context = practiceContext();
  const sameScope =
    !context ||
    (session.value &&
      restorePracticeSession(
        session.value,
        new Set(snapshot.value.map((item) => item.key)),
        context,
      ));
  // 同日同目标保留冻结队列，仍可不限次巩固；跨日/换目标不能给旧队列冒用新身份。
  const nextItems = sameScope ? snapshot.value : targetItems(scope.value);
  const next = createPracticeSession(
    nextItems.map((item) => item.key),
    scope.value,
    mode.value,
    preferences.value.practice,
    context,
  );
  saving.value++;
  try {
    await ctx.saveCheckpoint(JSON.parse(JSON.stringify(next)));
    snapshot.value = nextItems;
    session.value = next;
    dirty = false;
    feedback.value = "";
    scoreFeedback.value = null;
    ctx.error.value = "";
    started = Date.now();
  } catch (e) {
    ctx.error.value = (e as Error).message;
  } finally {
    saving.value--;
    schedule();
  }
}
// 先准备真实下一题，再把词头、游标、题目和草稿一次提交给渲染器；旧卡片不塌成加载文字。
async function moveTo(next: PracticeSession, automatic = false) {
  if (
    saving.value ||
    retry.value ||
    loading.value ||
    transitioning.value ||
    !interactionsReady.value
  )
    return;
  if (!session.value) return;
  const previous = session.value,
    item = snapshot.value[next.index];
  if (next === previous) return;
  cancelTransition();
  if (!automatic) ctx.audio.stop();
  if (!item) {
    session.value = next;
    feedback.value = "";
    scoreFeedback.value = null;
    dirty = true;
    return;
  }
  const ticket = ++generation,
    previousCue = cueKey(previous);
  transitioning.value = true;
  try {
    const cue = await prepareCue(next, item);
    if (
      disposed ||
      ticket !== generation ||
      !props.active ||
      !session.value ||
      cueKey(session.value) !== previousCue
    )
      return;
    // 三个字段在同一 Vue 更新批次切换；watch 看到已准备身份，不重新清空选项。
    preparedCue = cueKey(next, item);
    entry.value = cue.entry;
    question.value = cue.question;
    session.value = {
      ...next,
      preferences: { ...next.preferences, ignoreCase: cue.question.ignoreCase },
    };
    feedback.value = "";
    scoreFeedback.value = null;
    started = Date.now();
    dirty = true;
    ctx.error.value = "";
  } catch (e) {
    if (ticket === generation && !disposed) ctx.error.value = (e as Error).message;
  } finally {
    if (ticket === generation) transitioning.value = false;
    await nextTick();
    if (ticket === generation && interactionsReady.value) typingInput.value?.focus();
  }
}
function advance(automatic = false) {
  if (session.value) return moveTo(nextPracticeWord(session.value), automatic);
}
function previous() {
  if (session.value) return moveTo(previousPracticeWord(session.value));
}
function revisitPending() {
  const active = session.value;
  if (!active) return;
  const index = active.ids.findIndex((key) => !practiceWordCompleted(active, key));
  if (index >= 0) void moveTo(selectPracticeWord(active, index));
}
// 只有已作答且事务确认后的空白区点击才继续；操作控件、文字选择与弹窗不参与。
function advanceFromBlank(event: MouseEvent) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    !session.value ||
    !current.value ||
    saving.value ||
    retry.value ||
    loading.value ||
    !interactionsReady.value ||
    window.getSelection()?.toString() ||
    !(event.target instanceof Element) ||
    event.target.closest(
      "button, input, select, textarea, a, label, progress, [role='dialog'], [role='button'], .v3-practice-toolbar, .v3-progress-line, .v3-practice-list, .v3-character-stage",
    )
  )
    return;
  const answered =
    mode.value === "word-list"
      ? listRecall(session.value, current.value.key).answer !== null
      : mode.value === "meaning-choice"
        ? turn.value?.phase === "answered"
        : spellingComplete.value;
  if (answered) void advance();
}
function keydown(e: KeyboardEvent) {
  if (
    !interactionsReady.value ||
    loading.value ||
    saving.value ||
    !question.value ||
    !session.value ||
    !current.value ||
    !["copy", "recall"].includes(mode.value) ||
    e.isComposing ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey
  )
    return;
  if (e.key === "Backspace") {
    e.preventDefault();
    session.value = backspaceCharacter(session.value);
    dirty = true;
    return;
  }
  if (e.key.length !== 1) return;
  e.preventDefault();
  const next = typeCharacter(session.value, current.value.word, e.key);
  if (next === session.value) return;
  session.value = next;
  void sounds.play(
    currentTurn(next).phase === "error"
      ? "incorrect"
      : currentTurn(next).phase === "success"
        ? "correct"
        : "type",
    next.preferences.soundFeedback !== false,
  );
  dirty = true;
  if (currentTurn(next).phase === "error") {
    feedback.value = "重写一次";
    void record(false, e.key);
  } else if (currentTurn(next).phase === "success") {
    feedback.value = "拼写正确";
    if (currentTurn(next).round >= next.preferences.repeat) {
      void record(true, current.value.word);
      if (next.preferences.autoPronounce)
        void ctx.audio.play(current.value.word, preferences.value.pronunciation);
    }
  }
}
function schedule() {
  clearTimeout(timer);
  if (
    !session.value ||
    !interactionsReady.value ||
    loading.value ||
    !question.value ||
    saving.value ||
    retry.value
  )
    return;
  const phase = turn.value?.phase;
  const choiceComplete =
    mode.value === "meaning-choice" && phase === "answered" && turn.value?.correct;
  // 一秒从写事务确认开始；打开弹窗/离开会永久取消此题旧计时，不在返回时重建。
  // 中间重复仅短暂反馈，错字重写不是自动进入下一题。
  const writtenComplete = spellingComplete.value;
  const completed = choiceComplete || writtenComplete;
  if (completed && (!acknowledgedCue || acknowledgedCue.key !== cueKey(session.value)))
    return;
  // 一秒是保存后的最短反馈。当前词仍在真实加载/发音时等待结束；错误、超时或停止会重新调度。
  // 不把播放器的状态归到下一题，切方式/离开仍由 cancelTransition 撤销旧回执。
  const audio = ctx.audioState.value;
  if (
    completed &&
    audio.word === current.value?.word &&
    (audio.phase === "loading" || audio.phase === "playing")
  )
    return;
  if (phase === "error" || phase === "success" || choiceComplete) {
    const scopeId = session.value.id,
      index = session.value.index,
      modeId = session.value.mode;
    timer = setTimeout(
      () => {
        if (
          !session.value ||
          session.value.id !== scopeId ||
          session.value.index !== index ||
          session.value.mode !== modeId ||
          !interactionsReady.value ||
          loading.value ||
          !question.value ||
          saving.value ||
          retry.value
        )
          return;
        if (choiceComplete || (writtenComplete && session.value.preferences.autoNext))
          advance(true);
        else session.value = settleSpelling(session.value);
        typingInput.value?.focus();
      },
      phase === "error"
        ? 300
        : completed
          ? Math.max(0, acknowledgedCue!.deadline - performance.now())
          : 650,
    );
  }
}
watch(
  () => [
    turn.value?.phase,
    turn.value?.correct,
    turn.value?.round,
    loading.value,
    props.active,
    settingsOpen.value,
    pendingScope.value,
    mode.value,
    current.value?.key,
    showWords.value,
    showCard.value,
    ctx.audioState.value.phase,
    ctx.audioState.value.word,
  ],
  schedule,
);
// 传入冻结的候选，不在 await 后读取会变化的当前词或方式。
async function prepareCue(activeSession: PracticeSession, item: LibraryItem) {
  const candidates = await ctx.lexicon.lookupAll(item.word);
  const found =
    candidates.find((e) => e.entryId === (item.personal?.entryId || item.entryId)) ||
    candidates[0] ||
    null;
  const contexts = [
    ...ctx.encounters.value
      .filter((e) => !e.undoneAt && e.wordId === item.personal?.id)
      .map((e) => e.savedExcerpt),
    ...(found?.senses.flatMap((s) => s.examples).map((e) => e.text) || []),
  ];
  const prepared = await ctx.learning.prepare(
    activeSession.id,
    item,
    activeSession.mode,
    activeSession.preferences.ignoreCase,
    contexts,
    activeSession.index,
  );
  return { entry: found, question: prepared };
}
watch(
  [
    () => current.value?.key,
    () => mode.value,
    () => session.value?.id,
    () => props.active,
    settingsOpen,
    pendingScope,
    showWords,
    showCard,
  ],
  async () => {
    const activeSession = session.value,
      item = current.value;
    if (
      !activeSession ||
      !item ||
      !props.active ||
      settingsOpen.value ||
      pendingScope.value ||
      showWords.value ||
      showCard.value
    )
      return;
    const identity = cueKey(activeSession, item);
    // advance 已经把整题准备好；禁止第二次加载把刚到位的四个选项卸载。
    if (preparedCue === identity && question.value) {
      // 当前已冻结题的大小写口径不能因设置弹窗变成另一道判题规则。
      if (activeSession.preferences.ignoreCase !== question.value.ignoreCase)
        session.value = {
          ...activeSession,
          preferences: {
            ...activeSession.preferences,
            ignoreCase: question.value.ignoreCase,
          },
        };
      return;
    }
    const id = ++generation;
    entry.value = null;
    question.value = null;
    loading.value = true;
    started = Date.now();
    try {
      const cue = await prepareCue(activeSession, item);
      if (disposed || id !== generation) return;
      preparedCue = identity;
      entry.value = cue.entry;
      question.value = cue.question;
      if (session.value && cueKey(session.value) === identity)
        session.value = {
          ...session.value,
          preferences: {
            ...session.value.preferences,
            ignoreCase: cue.question.ignoreCase,
          },
        };
    } catch (e) {
      if (id === generation && !disposed) ctx.error.value = (e as Error).message;
    } finally {
      if (id === generation) loading.value = false;
      await nextTick();
      if (id === generation && interactionsReady.value) typingInput.value?.focus();
    }
  },
);
watch(
  () => props.active,
  (active) => {
    if (active && !session.value) activate(scope.value);
    if (!active) {
      cancelTransition();
      ctx.audio.stop();
      sounds.stop();
    }
  },
);
watch(
  () => ctx.ready.value,
  (ready) => {
    if (ready && props.active && !session.value) activate(scope.value);
  },
  { immediate: true },
);
watch(
  () => preferences.value.practice,
  (next) => {
    if (session.value) session.value = { ...session.value, preferences: { ...next } };
    if (!next.autoPronounce && props.active) ctx.audio.stop();
    if (next.soundFeedback === false) sounds.stop();
  },
);
watch(items, (activeItems) => {
  if (!session.value) return;
  const active = new Map(activeItems.map((item) => [item.key, item])),
    next = retainPracticeWords(session.value, new Set(active.keys()));
  if (next === session.value) return;
  cancelTransition();
  ctx.audio.stop();
  snapshot.value = next.ids.map((key) => active.get(key)!);
  session.value = next;
  feedback.value = "";
  scoreFeedback.value = null;
  dirty = true;
});
watch([settingsOpen, pendingScope, showWords, showCard], (states) => {
  if (states.some(Boolean)) cancelTransition();
});
async function saveProgress() {
  if (saving.value || retry.value) return;
  if (session.value)
    try {
      await ctx.saveCheckpoint(JSON.parse(JSON.stringify(session.value)));
      dirty = false;
    } catch (e) {
      ctx.error.value = (e as Error).message;
    }
}
async function saveSettings() {
  if (await ctx.savePreferences({ ...preferences.value, practice: draft.value })) {
    if (session.value)
      session.value = { ...session.value, preferences: { ...draft.value } };
    settingsOpen.value = false;
  }
}
function openCard() {
  if (saving.value || retry.value) return;
  if (
    mode.value !== "copy" &&
    turn.value?.phase !== "answered" &&
    turn.value?.phase !== "success"
  )
    void record(false, "", current.value, "reveal");
  showCard.value = true;
}
function start(list: LibraryItem[]) {
  if (!list.length) return;
  if (
    session.value &&
    scope.value === "today" &&
    !!restorePracticeSession(
      session.value,
      new Set(snapshot.value.map((item) => item.key)),
      practiceContext("today"),
    ) &&
    list.every((i) => snapshot.value.some((w) => w.key === i.key))
  ) {
    selectListWord(snapshot.value.findIndex((i) => i.key === list[0]!.key));
    return;
  }
  if (dirty && session.value) {
    requestedStart = list;
    pendingScope.value = "today";
    return;
  }
  activate("today");
  if (!list.every((item) => snapshot.value.some((saved) => saved.key === item.key))) {
    snapshot.value = list;
    session.value = createPracticeSession(
      list.map((i) => i.key),
      "today",
      mode.value,
      preferences.value.practice,
      practiceContext("today"),
    );
  } else selectListWord(snapshot.value.findIndex((i) => i.key === list[0]!.key));
}
defineExpose({ start });
onUnmounted(() => {
  disposed = true;
  cancelTransition();
  sounds.dispose();
  ctx.audio.stop();
});
</script>
<template>
  <section class="v3-practice" @click="advanceFromBlank">
    <div class="v3-practice-toolbar">
      <nav class="v3-tabs" aria-label="练习模式">
        <button
          v-for="[id, label] in modes"
          :key="id"
          :class="{ active: mode === id }"
          :aria-pressed="mode === id"
          :disabled="saving > 0 || transitioning || !!retry"
          @click="changeMode(id)"
        >
          {{ label }}
        </button>
      </nav>
      <div class="v3-practice-controls" role="group" aria-label="练习范围和操作">
        <label
          >练习范围<select
            :value="scope"
            aria-label="练习范围"
            :disabled="saving > 0 || transitioning || !!retry"
            @change="changeScope(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="s in scopes" :key="s.id" :value="s.id">
              {{ s.label }} · {{ s.count }}
            </option>
          </select></label
        >
        <button
          class="v3-secondary v3-practice-restart"
          :disabled="saving > 0 || transitioning || !!retry || !snapshot.length"
          title="从第一个词重新练习，已记录的分数保留"
          @click="restartPractice"
        >
          重新开始
        </button>
        <button
          class="v3-icon-button"
          title="查看范围单词"
          aria-label="查看范围单词"
          @click="showWords = true"
        >
          <Icon name="eye" />
        </button>
        <button
          class="v3-icon-button"
          title="拼写设置"
          aria-label="拼写设置"
          @click="
            draft = { ...preferences.practice };
            settingsOpen = true;
          "
        >
          <Icon name="adjustments-horizontal" />
        </button>
      </div>
    </div>
    <div v-if="!snapshot.length" class="v3-practice-empty">
      <small>练习范围</small>
      <h2>今天还没有要练的单词</h2>
      <p>选择学习目标，或从单词本与我的词库开始。</p>
      <div class="v3-word-chips">
        <button
          v-for="s in scopes.filter((s) => s.count)"
          :key="s.id"
          @click="changeScope(s.id)"
        >
          <strong>{{ s.label }}</strong
          ><small>{{ s.count }} 词</small>
        </button>
      </div>
    </div>
    <div v-else-if="finished" class="v3-practice-empty">
      <small>{{ completedCount === snapshot.length ? "本轮完成" : "本轮结束" }}</small>
      <h2>和 {{ snapshot.length }} 个词重新见面</h2>
      <p>
        已完成 {{ completedCount }} 词<span v-if="completedCount < snapshot.length">
          · 跳过 {{ snapshot.length - completedCount }} 词</span
        >
      </p>
      <p>
        {{ modes.find((m) => m[0] === mode)?.[1] }} · 练习
        {{ session?.results.filter((r) => r.mode === mode).length }} 次 · 正确
        {{ session?.results.filter((r) => r.mode === mode && r.correct).length }} 次
      </p>
      <progress :value="completedCount" :max="snapshot.length" aria-label="练习进度" />
      <div class="v3-practice-bottom">
        <button class="v3-secondary" @click="previous">
          <Icon name="arrow-left" />上一个
        </button>
        <button
          v-if="completedCount < snapshot.length"
          class="v3-secondary"
          :disabled="saving > 0 || transitioning || !!retry"
          @click="revisitPending"
        >
          补练未完成
        </button>
      </div>
    </div>
    <div
      v-else-if="current && session"
      class="v3-practice-stage"
      :data-attempt-id="question?.attemptId"
      :aria-busy="loading || transitioning || saving > 0"
      :class="{ 'list-mode': mode === 'word-list' }"
    >
      <div class="v3-progress-line">
        <span
          >第 {{ session.index + 1 }} / {{ snapshot.length }} 词
          <small class="v3-practice-completion"
            >已完成 {{ completedCount }} / {{ snapshot.length }}</small
          > </span
        ><span class="v3-learning-score" aria-live="polite">{{
          `${current.word} · ${scoreLabel}`
        }}</span
        ><button :disabled="saving > 0 || transitioning || !!retry" @click="saveProgress">
          保存进度
        </button>
      </div>
      <div v-if="retry" class="v3-learning-write-error" role="alert">
        本题尚未保存<button
          class="v3-secondary"
          @click="retry?.()"
          :disabled="saving > 0"
        >
          重试保存
        </button>
      </div>
      <progress
        :value="completedCount"
        :max="snapshot.length"
        :aria-valuetext="`已完成 ${completedCount} / ${snapshot.length} 词`"
        aria-label="练习进度"
      />
      <div
        v-if="
          session.index === snapshot.length - 1 &&
          currentCompleted &&
          completedCount < snapshot.length
        "
        class="v3-practice-remaining"
      >
        <span>还有 {{ snapshot.length - completedCount }} 词未完成</span>
        <button
          class="v3-secondary"
          :disabled="saving > 0 || transitioning || !!retry"
          @click="revisitPending"
        >
          补练未完成
        </button>
      </div>
      <PracticeList
        v-if="mode === 'word-list'"
        :session="session"
        :items="listItems"
        :busy="saving > 0 || transitioning || !!retry"
        @select="selectListWord"
        @reveal="revealList"
        @answer="answerList"
        @mask="maskList"
      />
      <div v-if="mode === 'word-list'" class="v3-practice-bottom">
        <button
          class="v3-secondary"
          :disabled="saving > 0 || transitioning || !!retry || session.index === 0"
          @click="previous"
        >
          <Icon name="arrow-left" />上一个
        </button>
        <button
          class="v3-secondary"
          :disabled="
            saving > 0 ||
            transitioning ||
            !!retry ||
            listRecall(session, current.key).answer === null
          "
          @click="advance()"
        >
          下一个<Icon name="arrow-right" />
        </button>
      </div>
      <div v-if="mode !== 'word-list'" class="v3-practice-word-line">
        <button
          v-if="mode !== 'listening'"
          :aria-label="`朗读 ${current.word}`"
          @click="ctx.audio.play(current.word, preferences.pronunciation)"
        >
          <Icon name="volume" /></button
        ><small
          >{{ modes.find((m) => m[0] === mode)?.[1]
          }}{{
            mode === "meaning-choice"
              ? ""
              : ` · ${turn?.round || 0} / ${currentRepeat} 次`
          }}</small
        ><button title="查看词卡" aria-label="查看词卡" @click="openCard">
          <Icon name="book-2" />
        </button>
      </div>
      <h2 v-if="mode === 'meaning-choice'" class="v3-practice-headword">
        {{ current.word }}
      </h2>
      <template v-if="mode === 'meaning-choice'"
        ><p v-if="loading" class="v3-muted">正在准备释义…</p>
        <div v-else-if="choices.length >= 2" class="v3-meaning-choices">
          <button
            v-for="(choice, i) in choices"
            :key="choice.id"
            :disabled="
              turn?.phase === 'answered' ||
              loading ||
              saving > 0 ||
              transitioning ||
              !!retry
            "
            :class="{
              correct: turn?.phase === 'answered' && choice.correct,
              wrong: turn?.answer === choice.id && !choice.correct,
            }"
            @click="choose(choice.id)"
          >
            <span>{{ String.fromCharCode(65 + i) }}</span
            ><strong>{{ choice.text }}</strong
            ><span
              class="v3-choice-result"
              aria-hidden="true"
              :class="{
                visible:
                  turn?.phase === 'answered' &&
                  (choice.correct || turn?.answer === choice.id),
              }"
              ><Icon :name="choice.correct ? 'check' : 'x'"
            /></span>
          </button>
        </div>
        <p v-else class="v3-muted">本词缺少短释义选项，可以切换临摹或默写。</p>
        <div class="v3-practice-bottom">
          <button
            class="v3-secondary"
            :disabled="saving > 0 || transitioning || !!retry || session.index === 0"
            @click="previous"
          >
            <Icon name="arrow-left" />上一个
          </button>
          <button
            class="v3-secondary"
            :disabled="
              saving > 0 ||
              transitioning ||
              !!retry ||
              loading ||
              (turn?.phase !== 'answered' && choices.length >= 2)
            "
            @click="advance()"
          >
            下一个<Icon name="arrow-right" />
          </button></div
      ></template>
      <template v-else-if="mode === 'copy' || mode === 'recall'"
        ><div
          class="v3-character-stage"
          :class="{
            error: turn?.phase === 'error',
            success: turn?.phase === 'success',
          }"
          tabindex="-1"
          @click="typingInput?.focus()"
        >
          <span
            v-for="(char, i) in [...current.word]"
            :key="i"
            class="v3-character"
            :class="{
              typed: i < (turn?.position || 0),
              current: i === turn?.position,
            }"
            >{{
              i < (turn?.position || 0) ||
              turn?.hint ||
              (mode === "copy" && !session.preferences.hideWord)
                ? char
                : "·"
            }}</span
          ><input
            v-if="!loading && question"
            ref="typingInput"
            class="v3-character-input"
            :disabled="loading || saving > 0 || !question || !!retry"
            :aria-busy="loading"
            aria-label="逐字拼写"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            @keydown="keydown"
            @paste.prevent
            @input="($event.target as HTMLInputElement).value = ''"
            @compositionend="($event.target as HTMLInputElement).value = ''"
          />
        </div>
        <p v-if="loading" class="v3-muted" role="status">正在准备单词…</p>
        <p v-if="!session.preferences.hideMeaning" class="v3-practice-meaning">
          {{
            mode === "recall" && !turn?.hint
              ? maskHeadword(meaning, current.word)
              : meaning
          }}
        </p>
        <blockquote
          v-if="!session.preferences.hideSentence && example"
          class="v3-practice-sentence"
        >
          {{
            spellingSentence(
              example,
              current.word,
              (mode === "copy" && !session.preferences.hideWord) || !!turn?.hint,
            )
          }}
        </blockquote>
        <div class="v3-practice-bottom">
          <button
            class="v3-secondary"
            :disabled="saving > 0 || transitioning || !!retry || session.index === 0"
            @click="previous"
          >
            <Icon name="arrow-left" />上一个
          </button>
          <button
            class="v3-secondary"
            :disabled="saving > 0 || transitioning || !!retry"
            @click="hintSpelling"
          >
            <Icon name="bulb" />{{ turn?.hint ? "隐藏提示" : "显示提示" }}</button
          ><button
            class="v3-secondary"
            :disabled="saving > 0 || !!retry || !spellingComplete"
            @click="advance()"
          >
            下一个<Icon name="arrow-right" />
          </button></div
      ></template>
      <WrittenPractice
        v-else-if="mode === 'listening' || mode === 'cloze'"
        :mode="mode"
        :question="cloze?.question || ''"
        :input="turn?.input || ''"
        :phase="turn?.phase || 'running'"
        :active="interactionsReady && !loading && !!question && saving === 0 && !retry"
        :cue-key="`${session.id}:${session.index}:${mode}`"
        :loading-audio="ctx.audioState.value.phase === 'loading'"
        :hint="!!turn?.hint"
        :answer="current.word"
        :complete="spellingComplete"
        :can-previous="session.index > 0"
        @update="updateAnswer"
        @submit="submitAnswer"
        @play="playListening"
        @hint="hintSpelling"
        @next="advance()"
        @previous="previous"
      />
      <p v-if="ctx.audioState.value.phase === 'error'" class="v3-muted" role="status">
        {{ ctx.audioState.value.message }}
      </p>
      <p class="v3-practice-feedback" role="status">{{ feedback }}</p>
    </div>
    <Dialog v-if="pendingScope" title="保存当前练习进度？" @close="pendingScope = ''"
      ><p>当前范围的词序、位置与六种练习草稿可以一起保存。</p>
      <footer class="v3-dialog-actions">
        <button class="v3-secondary" @click="pendingScope = ''">继续练习</button
        ><button class="v3-secondary" @click="confirmScope(false)">不保存并切换</button
        ><button class="mg-primary" @click="confirmScope(true)">保存并切换</button>
      </footer></Dialog
    >
    <Dialog v-if="settingsOpen" title="拼写设置" @close="settingsOpen = false"
      ><label class="v3-setting-row"
        >每词重复<input
          v-model.number="draft.repeat"
          type="number"
          min="1"
          max="10" /></label
      ><label
        v-for="[id, label] in [
          ['autoPronounce', '拼写完成后发音'],
          ['soundFeedback', '打字与答题音效'],
          ['autoNext', '自动下一个'],
          ['ignoreCase', '忽略大小写'],
          ['hideWord', '隐藏单词'],
          ['hideMeaning', '隐藏释义'],
          ['hideSentence', '隐藏句子'],
        ] as const"
        :key="id"
        class="v3-check-row"
        ><input v-model="(draft as any)[id]" type="checkbox" />{{ label }}</label
      >
      <footer class="v3-dialog-actions">
        <button class="v3-secondary" @click="settingsOpen = false">取消</button
        ><button class="mg-primary" @click="saveSettings">保存拼写设置</button>
      </footer></Dialog
    >
    <Dialog v-if="showWords" title="本轮练习范围" @close="showWords = false"
      ><p>{{ snapshot.length }} 词 · 当前第 {{ (session?.index || 0) + 1 }} 词</p>
      <div class="v3-target-list">
        <p v-for="i in snapshot.slice(0, 200)" :key="i.key">
          {{ i.word }} <small>{{ i.meaning }}</small>
        </p>
      </div></Dialog
    >
    <Dialog v-if="showCard && current" title="练习词卡" @close="showCard = false"
      ><WordCard :item="current"
    /></Dialog>
  </section>
</template>
