import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
import {
  PRACTICE_MODES,
  createPracticeSession,
  setPracticeMode,
  currentTurn,
  updateWrittenAnswer,
  submitWrittenAnswer,
  settleSpelling,
  selectPracticeWord,
  answerListWord,
  revealListWord,
  listRecall,
  clozeQuestion,
  maskHeadword,
  restorePracticeSession,
  validPracticeSession,
  chooseMeaning,
  typeCharacter,
  nextPracticeWord,
  previousPracticeWord,
  practiceCompletedCount,
  practiceWordCompleted,
  retainPracticeWords,
} from "../lib/practice-session.ts";
import { defaultWorkspacePreferences } from "../lib/workspace-model.ts";
import { LocalLibrary } from "../lib/local-database.ts";
const session = () =>
  createPracticeSession(
    ["system", "attention", "resilient"],
    "library",
    "meaning-choice",
    defaultWorkspacePreferences().practice,
  );
const confirmCompletion = (s: ReturnType<typeof session>, key = s.ids[s.index]!) => ({
  ...s,
  results: [...s.results, { key, mode: s.mode, correct: true, completed: true }],
});

test("六方式独立游标，听音与填空不同位置的输入各自保留，持久化后恢复", () => {
  let s = selectPracticeWord(session(), 2);
  const old = structuredClone(s);
  assert.deepEqual(restorePracticeSession(old, new Set(s.ids)), old);
  s = updateWrittenAnswer(
    selectPracticeWord(setPracticeMode(s, "listening"), 1),
    "atten",
  );
  s = updateWrittenAnswer(setPracticeMode(s, "cloze"), "sys");
  for (const mode of PRACTICE_MODES) {
    s = setPracticeMode(s, mode);
    assert.equal(s.index, mode === "meaning-choice" ? 2 : mode === "listening" ? 1 : 0);
    if (mode === "listening") assert.equal(currentTurn(s).input, "atten");
    if (mode === "cloze") assert.equal(currentTurn(s).input, "sys");
  }
  assert.deepEqual(
    restorePracticeSession(JSON.parse(JSON.stringify(s)), new Set(s.ids)),
    s,
  );
  assert.equal(
    validPracticeSession({
      ...s,
      turns: { cloze: { ...currentTurn(s), input: "x".repeat(121) } },
    }),
    false,
  );
});

test("整词确认可订正，大小写配置生效，重复 Enter 不追加成功或错误次数", () => {
  let s = setPracticeMode(session(), "listening");
  s = submitWrittenAnswer(updateWrittenAnswer(s, "wrong"), "system");
  assert.equal(currentTurn(s).correct, false);
  assert.equal(currentTurn(s).input, "wrong");
  assert.equal(submitWrittenAnswer(s, "system"), s);
  assert.equal(updateWrittenAnswer(s, "wrong"), s);
  s = submitWrittenAnswer(updateWrittenAnswer(s, " SYSTEM "), "system");
  assert.equal(currentTurn(s).phase, "success");
  assert.equal(currentTurn(s).round, 1);
  assert.equal(submitWrittenAnswer(s, "system"), s);
  s = { ...s, preferences: { ...s.preferences, repeat: 2 } };
  s = settleSpelling(s);
  assert.equal(currentTurn(s).input, "");
  assert.equal(currentTurn(s).phase, "running");
  s = { ...s, preferences: { ...s.preferences, ignoreCase: false } };
  s = submitWrittenAnswer(updateWrittenAnswer(s, "System"), "system");
  assert.equal(currentTurn(s).correct, false);
  assert.equal(currentTurn(s).round, 1);
});

test("列表遮挡/揭示和反馈可恢复；选择其他词保存逐词草稿，重复反馈无效", () => {
  let s = setPracticeMode(session(), "word-list");
  s = revealListWord(s, "system");
  s = answerListWord(s, "system", "unfamiliar");
  assert.equal(answerListWord(s, "system", "familiar"), s);
  s = selectPracticeWord(s, 2);
  s = updateWrittenAnswer(selectPracticeWord(setPracticeMode(s, "cloze"), 2), "resi");
  s = selectPracticeWord(s, 1);
  assert.deepEqual(currentTurn(s).input, undefined);
  s = selectPracticeWord(s, 2);
  assert.equal(currentTurn(s).input, "resi");
  assert.deepEqual(listRecall(s, "system"), {
    answer: "unfamiliar",
    revealed: true,
  });
  assert.deepEqual(restorePracticeSession(s, new Set(s.ids)), s);
  assert.equal(
    validPracticeSession({
      ...s,
      listRecall: { missing: { answer: null, revealed: true } },
    }),
    false,
  );
});

test("填空只使用包含完整目标词的真实语境，全部匹配都遮挡，无关或子串例句不出题", () => {
  const sample = "A cat watches another Cat, not a concatenate operation.";
  assert.deepEqual(clozeQuestion("cat", ["No relevant word.", sample]), {
    sentence: sample,
    question: "A _____ watches another _____, not a concatenate operation.",
  });
  assert.equal(clozeQuestion("cat", ["concatenate", "écat", "cat2", "_cat"]), null);
  assert.equal(
    maskHeadword("C++ is useful; C++ works.", "C++"),
    "_____ is useful; _____ works.",
  );
  assert.equal(
    maskHeadword("Word: mother-in-law; motherhood.", "mother-in-law"),
    "Word: _____; motherhood.",
  );
  assert.equal(clozeQuestion("system", ["", "unrelated sentence"]), null);
});

test("六方式记录均能持久化，新增练习不改变词条、学习评价、规划或完成额度", async () => {
  const db = new LocalLibrary("practice-six-" + crypto.randomUUID());
  const word = await db.addWord("resilient");
  for (const mode of PRACTICE_MODES) {
    await db.addPractice({
      id: crypto.randomUUID(),
      wordId: word.id,
      entryId: null,
      mode,
      answer: mode === "word-list" ? "familiar" : "resilient",
      correct: true,
      durationMs: 120,
      createdAt: new Date().toISOString(),
    });
  }
  assert.equal((await db.practice()).length, 6);
  assert.deepEqual(await db.word(word.id), word);
  assert.deepEqual(await db.reviews(), []);
  assert.equal(await db.plan(), null);
  const bad = {
    id: crypto.randomUUID(),
    wordId: word.id,
    entryId: null,
    mode: "unknown" as any,
    answer: "resilient",
    correct: true,
    durationMs: 1,
    createdAt: new Date().toISOString(),
  };
  await assert.rejects(db.addPractice(bad), /练习事实无效/);
});

test("逐词各模式草稿和首次反馈保留，换词再返回不允许重复选择结算", () => {
  let s = chooseMeaning(session(), "right", "right");
  s = setPracticeMode(s, "copy");
  s = typeCharacter(typeCharacter(s, "system", "s"), "system", "y");
  s = updateWrittenAnswer(setPracticeMode(s, "listening"), "sys");
  s = updateWrittenAnswer(setPracticeMode(s, "cloze"), "syst");
  s = nextPracticeWord(s);
  assert.equal(s.index, 1);
  assert.equal(currentTurn(s).input, undefined);
  s = updateWrittenAnswer(s, "atten");
  s = selectPracticeWord(s, 0);
  assert.equal(currentTurn(s).input, "syst");
  s = setPracticeMode(s, "listening");
  assert.equal(currentTurn(s).input, "sys");
  s = setPracticeMode(s, "copy");
  assert.equal(currentTurn(s).position, 2);
  s = setPracticeMode(s, "meaning-choice");
  assert.equal(currentTurn(s).answer, "right");
  assert.equal(chooseMeaning(s, "wrong", "right"), s);
  s = selectPracticeWord(s, 1);
  assert.equal(
    currentTurn(selectPracticeWord(setPracticeMode(s, "cloze"), 1)).input,
    "atten",
  );
  const restored = restorePracticeSession(JSON.parse(JSON.stringify(s)), new Set(s.ids))!;
  assert.deepEqual(restored, s);
  assert.equal(
    currentTurn(setPracticeMode(selectPracticeWord(restored, 0), "copy")).position,
    2,
  );
  assert.equal(validPracticeSession({ ...s, wordTurns: { missing: {} } }), false);
  assert.equal(
    validPracticeSession({
      ...s,
      wordTurns: { system: { copy: { ...currentTurn(s), position: 7 } } },
    }),
    false,
  );
});

test("最后一个词作答即完成进度，返回上一个只重看，模式位置和完成数互不覆盖", () => {
  let s = createPracticeSession(["system", "attention"], "library", "copy", {
    ...defaultWorkspacePreferences().practice,
    repeat: 1,
  });
  for (const char of "system") s = typeCharacter(s, "system", char);
  assert.equal(practiceCompletedCount(s), 0); // 尚未收到事务回执。
  s = confirmCompletion(s);
  assert.equal(practiceCompletedCount(s), 1);
  s = nextPracticeWord(s);
  for (const char of "attention") s = typeCharacter(s, "attention", char);
  s = confirmCompletion(s);
  assert.equal(practiceCompletedCount(s), 2);
  const copy = structuredClone(s);
  s = setPracticeMode(s, "listening");
  assert.equal(s.index, 0);
  assert.equal(practiceCompletedCount(s), 0);
  s = nextPracticeWord(s);
  s = updateWrittenAnswer(s, "att");
  s = setPracticeMode(s, "word-list");
  for (const key of s.ids) s = confirmCompletion(answerListWord(s, key, "familiar"), key);
  assert.equal(practiceCompletedCount(s), 2);
  s = setPracticeMode(s, "copy");
  assert.equal(s.index, copy.index);
  assert.equal(practiceCompletedCount(s), 2);
  s = nextPracticeWord(s);
  assert.equal(s.index, 2);
  s = previousPracticeWord(s);
  assert.equal(currentTurn(s).phase, "success");
  assert.equal(typeCharacter(s, "attention", "a"), s);
  s = previousPracticeWord(s);
  assert.equal(currentTurn(s).phase, "success");
  s = setPracticeMode(s, "listening");
  assert.equal(s.index, 1);
  assert.equal(currentTurn(s).input, "att");
  assert.equal(practiceCompletedCount(s), 0);
  assert.deepEqual(
    restorePracticeSession(JSON.parse(JSON.stringify(s)), new Set(s.ids)),
    s,
  );
  for (const indices of [
    { ...s.indices, listening: -1 },
    { ...s.indices, copy: 3 },
    { ...s.indices, alien: 0 },
    { ...s.indices, listening: 0 },
  ])
    assert.equal(validPracticeSession({ ...s, indices }), false);
});

test("回收从六模式队列与草稿移除，其他位置和已完成进度按剩余词序保持", () => {
  let s = createPracticeSession(
    ["system", "attention", "resilient"],
    "library",
    "word-list",
    defaultWorkspacePreferences().practice,
  );
  s = answerListWord(s, "system", "familiar");
  s = confirmCompletion(s);
  s = selectPracticeWord(s, 2);
  s = updateWrittenAnswer(selectPracticeWord(setPracticeMode(s, "listening"), 1), "att");
  s = updateWrittenAnswer(selectPracticeWord(setPracticeMode(s, "cloze"), 2), "res");
  const kept = retainPracticeWords(s, new Set(["system", "resilient"]));
  assert.deepEqual(kept.ids, ["system", "resilient"]);
  assert.equal(kept.indices!.listening, 1);
  assert.equal(kept.indices!["word-list"], 1);
  assert.equal(kept.index, 1);
  assert.equal(currentTurn(kept).input, "res");
  assert.equal(currentTurn(setPracticeMode(kept, "listening")).input, undefined);
  assert.equal(practiceCompletedCount(setPracticeMode(kept, "word-list")), 1);
  assert.equal(kept.wordTurns?.attention, undefined);
  assert.equal(validPracticeSession(kept), true);
  assert.equal(retainPracticeWords(kept, new Set(kept.ids)), kept);
});

test("已结算题提高重复次数仍保持完成；未完成题按新次数练习，保存与返回不会重置旧题", () => {
  for (const mode of ["copy", "recall", "listening", "cloze"] as const) {
    let s = createPracticeSession(["system", "attention"], "library", mode, {
      ...defaultWorkspacePreferences().practice,
      repeat: 1,
    });
    const spell = (value: typeof s, word: string) => {
      if (mode === "copy" || mode === "recall") {
        for (const char of word) value = typeCharacter(value, word, char);
        return value;
      }
      return submitWrittenAnswer(updateWrittenAnswer(value, word), word);
    };
    s = confirmCompletion(spell(s, "system"));
    s = { ...s, preferences: { ...s.preferences, repeat: 2 } };
    assert.equal(practiceWordCompleted(s), true, mode);
    assert.equal(practiceCompletedCount(s), 1, mode);
    assert.equal(settleSpelling(s), s, mode);
    s = nextPracticeWord(s);
    s = spell(s, "attention");
    assert.equal(currentTurn(s).round, 1, mode);
    assert.equal(practiceWordCompleted(s), false, mode);
    assert.equal(practiceCompletedCount(s), 1, mode);
    s = settleSpelling(s);
    assert.equal(currentTurn(s).phase, "running", mode);
    s = confirmCompletion(spell(s, "attention"));
    assert.equal(currentTurn(s).round, 2, mode);
    assert.equal(practiceCompletedCount(s), 2, mode);
    s = previousPracticeWord(s);
    assert.equal(currentTurn(s).round, 1, mode);
    assert.equal(practiceWordCompleted(s), true, mode);
    assert.equal(settleSpelling(s), s, mode);
    const restored = restorePracticeSession(
      JSON.parse(JSON.stringify(s)),
      new Set(s.ids),
    )!;
    assert.equal(practiceCompletedCount(restored), 2, mode);
    assert.equal(settleSpelling(restored), restored, mode);
  }
});

test("跳过缺题不会伪造完成，游标到尾仍保留实际完成数量", () => {
  let s = setPracticeMode(session(), "cloze");
  s = confirmCompletion(submitWrittenAnswer(updateWrittenAnswer(s, "system"), "system"));
  s = nextPracticeWord(nextPracticeWord(nextPracticeWord(s)));
  assert.equal(s.index, s.ids.length);
  assert.equal(practiceCompletedCount(s), 1);
  assert.equal(s.ids.length - practiceCompletedCount(s), 2);
  assert.equal(practiceCompletedCount(previousPracticeWord(s)), 1);
  assert.equal(practiceCompletedCount(restorePracticeSession(s, new Set(s.ids))!), 1);
});

test("十遍临摹每一遍都能保存恢复，第六遍不会被判为无效断点", async () => {
  const db = new LocalLibrary("practice-ten-rounds-" + crypto.randomUUID());
  let s = createPracticeSession(["system"], "library", "copy", {
    ...defaultWorkspacePreferences().practice,
    repeat: 10,
  });
  for (let round = 1; round <= 10; round++) {
    for (const char of "system") s = typeCharacter(s, "system", char);
    assert.equal(currentTurn(s).round, round);
    assert.equal(validPracticeSession(s), true);
    await db.saveWorkspaceMeta("checkpoints", { library: s });
    const checkpoints = await db.workspaceMeta<Record<string, unknown>>("checkpoints");
    const saved = restorePracticeSession(checkpoints!.library, new Set(s.ids))!;
    assert.deepEqual(saved, s);
    s = settleSpelling(saved);
  }
  assert.equal(currentTurn(s).phase, "success");
  assert.equal(
    validPracticeSession({
      ...s,
      turns: { copy: { ...currentTurn(s), round: 11 } },
    }),
    false,
  );
});

test("今日断点只恢复同一学习日期和目标，新日期或目标重新建队列", () => {
  const context = { studyDay: "2026-10-03", goalKey: "plan/cet4/0.0.3" };
  let s = createPracticeSession(
    ["system"],
    "today",
    "listening",
    defaultWorkspacePreferences().practice,
    context,
  );
  s = updateWrittenAnswer(s, "sys");
  const known = new Set(s.ids);
  assert.deepEqual(restorePracticeSession(s, known, context), s);
  assert.equal(
    restorePracticeSession(s, known, { ...context, studyDay: "2026-10-04" }),
    null,
  );
  assert.equal(
    restorePracticeSession(s, known, {
      ...context,
      goalKey: "plan/ielts/0.0.3",
    }),
    null,
  );
  const missingContext = { ...s };
  delete missingContext.context;
  assert.equal(restorePracticeSession(missingContext, known, context), null);
  assert.equal(
    validPracticeSession({
      ...s,
      context: { ...context, studyDay: "2026-99-99" },
    }),
    false,
  );
  assert.equal(
    validPracticeSession({
      ...s,
      context: { ...context, studyDay: "2026-02-30" },
    }),
    false,
  );
});

test("响应式今日会话可安全校验并复制，重开/首页进入不因Proxy失效", () => {
  const context = { studyDay: "2026-10-03", goalKey: "plan/cet4/0.0.3" };
  let source = createPracticeSession(
    ["system", "resilient"],
    "today",
    "listening",
    defaultWorkspacePreferences().practice,
    context,
  );
  source = updateWrittenAnswer(source, "sys");
  source = selectPracticeWord(source, 1);
  source = updateWrittenAnswer(source, "res");
  const reactive = ref(source);
  const restored = restorePracticeSession(reactive.value, new Set(source.ids), context)!;
  assert.ok(restored);
  assert.deepEqual(restored, source);
  restored.turns.listening!.input = "changed";
  restored.wordTurns!.system!.listening!.input = "changed";
  assert.equal(currentTurn(reactive.value).input, "res");
  assert.equal(currentTurn(selectPracticeWord(reactive.value, 0)).input, "sys");
});

test("完成进度只读完整回执；最后答错、订正草稿、揭晓与重复反馈不会误减或虚增", () => {
  let s = createPracticeSession(
    Array.from({ length: 10 }, (_, i) => `word-${i}`),
    "library",
    "meaning-choice",
    defaultWorkspacePreferences().practice,
  );
  s.results = s.ids.map((key, i) => ({
    key,
    mode: s.mode,
    correct: i < 9,
    completed: true,
  }));
  s.results.push({ ...s.results[9]! });
  assert.equal(practiceCompletedCount(s), 10);
  // 回执已确认时，缺失或重置展示草稿不应让进度变成9/10。
  s.turns = {};
  s.wordTurns = {};
  assert.equal(practiceCompletedCount(s), 10);
  assert.equal(practiceWordCompleted(s, "word-9"), true);
  const restored = restorePracticeSession(JSON.parse(JSON.stringify(s)), new Set(s.ids))!;
  assert.equal(practiceCompletedCount(restored), 10);
  s = setPracticeMode(s, "recall");
  s.results.push({ key: s.ids[0]!, mode: "recall", correct: false, completed: false });
  assert.equal(practiceCompletedCount(s), 0);
  assert.equal(practiceWordCompleted(s), false);
});
