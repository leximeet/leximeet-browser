import { localSnapshot } from "./helpers/local-snapshot.ts";
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalLibrary } from "../lib/local-database.ts";
import {
  defaultWorkspacePreferences,
  validWorkspacePreferences,
} from "../lib/workspace-model.ts";
import {
  createPracticeSession,
  nextPracticeWord,
  setPracticeMode,
  typeCharacter,
  settleSpelling,
  currentTurn,
  restorePracticeSession,
  validPracticeSession,
  spellingSentence,
  chooseMeaning,
} from "../lib/practice-session.ts";
import { DictionaryCache, CORE_DELTA } from "../lib/dictionary-cache.ts";
import { installCoreText } from "../lib/dictionary-installer.ts";
import { pronunciationUrl, createPronunciationPlayer } from "../lib/pronunciation.ts";
import type { CatalogMember, CoreEntry } from "../lib/lexicon.ts";
import { learningLibrary } from "../lib/learning-workspace.ts";
const createLibrary = () => new LocalLibrary("workspace-" + crypto.randomUUID());
const member = (word: string): CatalogMember => ({
  entryId: crypto.randomUUID(),
  word,
  meaning: "真实词义",
  position: 1,
  senseIds: [],
  matchMethod: "dictionary",
});
test("目标与手动采集去重，目标学习元信息不自动变成采集，换目标保留个人事实", async () => {
  const db = createLibrary(),
    target = [member("resilient"), member("attention")];
  const w = await db.addWord("resilient", null, false, target[0]!.entryId);
  let list = learningLibrary(target, await db.listWords(), [], [], []);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.collected, false);
  assert.equal((await db.encounters()).length, 0);
  await db.addWord("Resilient");
  await db.addWord("telemetry");
  list = learningLibrary(target, await db.listWords(), [], [], []);
  assert.equal(list.length, 3);
  assert.ok(list.find((i) => i.key === "resilient")?.collected);
  assert.equal(
    learningLibrary([member("system")], await db.listWords(), [], [], []).length,
    3,
  );
  assert.equal((await db.word(w.id))!.id, w.id);
});
test("屈折形式保留精确表面词和 Range，同一词条追加多个语境", async () => {
  const db = createLibrary();
  for (const surface of ["learners", "learner"]) {
    const sentence = `Two ${surface} return.`;
    await db.capture({
      eventId: crypto.randomUUID(),
      surface,
      originalSentence: sentence,
      savedExcerpt: sentence,
      occurrenceRanges: [{ start: 4, end: 4 + surface.length }],
      excerptRanges: [{ start: 4, end: 4 + surface.length }],
      annotation: { note: "" },
      source: { title: "阅读", url: "https://example.org/" },
      occurredAt: new Date().toISOString(),
      timeZone: "UTC",
      dictionary: {
        word: "learner",
        entryId: crypto.randomUUID(),
        meaning: "学习者",
        phonetic: "",
      },
    });
  }
  assert.equal((await db.listWords()).length, 1);
  assert.equal((await db.encounters()).length, 2);
  assert.deepEqual(
    new Set((await db.encounters()).map((e) => e.surface)),
    new Set(["learners", "learner"]),
  );
});
test("三种模式各自定位；逐字草稿、错误复位、隐藏与整份断点恢复", () => {
  let s = createPracticeSession(
    ["attention", "system", "resilient"],
    "target",
    "meaning-choice",
    defaultWorkspacePreferences().practice,
  );
  s = nextPracticeWord(nextPracticeWord(s));
  s = chooseMeaning(s, "correct", "correct");
  s = setPracticeMode(s, "copy");
  s = typeCharacter(s, "attention", "a");
  s = typeCharacter(s, "attention", "t");
  assert.equal(s.index, 0);
  s = setPracticeMode(s, "recall");
  assert.equal(currentTurn(s).position, 0);
  s = setPracticeMode(s, "copy");
  assert.equal(currentTurn(s).position, 2);
  assert.equal(typeCharacter(s, "attention", "韧"), s);
  s = typeCharacter(s, "attention", "z");
  assert.equal(currentTurn(s).phase, "error");
  s = settleSpelling(s);
  assert.equal(currentTurn(s).position, 0);
  const restored = restorePracticeSession(JSON.parse(JSON.stringify(s)), new Set(s.ids));
  assert.deepEqual(restored, s);
  assert.equal(
    restorePracticeSession(
      { ...s, turns: { copy: { ...currentTurn(s), position: 100 } } },
      new Set(s.ids),
    ),
    null,
  );
  assert.equal(spellingSentence("A resilient learner.", "resilient"), "A _____ learner.");
});
test("工作区和三模式断点持久化，禁止凭据混入公开设置", async () => {
  const db = createLibrary(),
    p = defaultWorkspacePreferences(),
    s = createPracticeSession(["system"], "library", "copy", p.practice);
  await db.saveWorkspaceMeta("workspace", p);
  await db.saveWorkspaceMeta("checkpoints", { library: s });
  const backup = await localSnapshot(db);
  assert.deepEqual(backup.workspace, p);
  assert.deepEqual(backup.checkpoints, { library: s });
  assert.deepEqual(await db.workspaceMeta("checkpoints"), { library: s });
  await assert.rejects(
    db.saveWorkspaceMeta("workspace", { ...p, token: "secret" }),
    /格式无效/,
  );
  assert.equal(validWorkspacePreferences({ ...p, token: "secret" }), false);
  assert.equal(validPracticeSession({ ...s, credential: "secret" }), false);
});
test("Core 半包永不生效，损坏原始包在落盘前拒绝，切换回 Lite 不改个人资料", async () => {
  const c = new DictionaryCache("cache-" + crypto.randomUUID());
  assert.equal((await c.state()).active, "lite-text");
  await assert.rejects(c.activate("core-text"));
  await assert.rejects(
    installCoreText(new Blob(["wrong"]), new Set(), () => {}, c),
    /请选择/,
  );
  await assert.rejects(
    installCoreText(new Blob([new Uint8Array(CORE_DELTA.bytes)]), new Set(), () => {}, c),
    /哈希不符/,
  );
  assert.equal((await c.state()).coreInstalled, false);
  await c.close();
});
test("有道英美口音只发送词头，自定义地址拒绝凭据与私网", () => {
  const p = defaultWorkspacePreferences().pronunciation;
  const url = new URL(pronunciationUrl("resilient", p));
  assert.equal(url.hostname, "dict.youdao.com");
  assert.equal(url.searchParams.get("audio"), "resilient");
  assert.equal(url.searchParams.get("type"), "2");
  assert.equal(
    new URL(pronunciationUrl("resilient", { ...p, accent: "uk" })).searchParams.get(
      "type",
    ),
    "1",
  );
  for (const customUrl of [
    "http://example.org/{word}",
    "https://user:secret@example.org/{word}",
    "https://127.0.0.1/{word}",
  ])
    assert.throws(() =>
      pronunciationUrl("system", { ...p, provider: "custom", customUrl }),
    );
});
test("发音播放器只认真实 playing，换词取消旧播放与加载失败提示", async () => {
  class FakeAudio extends EventTarget {
    src = "";
    playbackRate = 1;
    preload = "";
    hidden = false;
    paused = false;
    removed = false;
    play() {
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute() {
      this.src = "";
    }
    load() {}
    remove() {
      this.removed = true;
    }
  }
  const sounds: FakeAudio[] = [],
    states: any[] = [];
  const player = createPronunciationPlayer(
    () => {
      const a = new FakeAudio();
      sounds.push(a);
      return a as any;
    },
    (s) => states.push(s),
    20,
  );
  await player.play("system", defaultWorkspacePreferences().pronunciation);
  assert.equal(states.at(-1).phase, "loading");
  sounds[0]!.dispatchEvent(new Event("playing"));
  assert.equal(states.at(-1).phase, "playing");
  await player.play("attention", defaultWorkspacePreferences().pronunciation);
  assert.ok(sounds[0]!.paused && sounds[0]!.removed);
  sounds[0]!.dispatchEvent(new Event("ended"));
  assert.equal(states.at(-1).word, "attention");
  sounds[1]!.dispatchEvent(new Event("error"));
  assert.equal(states.at(-1).phase, "error");
  await player.play("system", defaultWorkspacePreferences().pronunciation);
  sounds[2]!.dispatchEvent(new Event("playing"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(states.at(-1).phase, "error");
  assert.equal(states.at(-1).message, "发音播放超时");
  assert.ok(sounds[2]!.paused && sounds[2]!.removed);
  await player.play("attention", defaultWorkspacePreferences().pronunciation);
  sounds[3]!.dispatchEvent(new Event("playing"));
  sounds[3]!.dispatchEvent(new Event("ended"));
  assert.equal(states.at(-1).phase, "ended");
  player.stop();
  assert.equal(states.at(-1).phase, "idle");
});

// 当前格式关闭选择必须正常恢复；缺失字段的预发布设置不能静默补齐。
test("当前练习默认发音与音效开启，关闭选择可恢复，缺失和未知字段拒绝", () => {
  const fresh = defaultWorkspacePreferences();
  assert.equal(fresh.practice.autoPronounce, true);
  assert.equal(fresh.practice.soundFeedback, true);
  const saved = structuredClone(fresh);
  saved.practice.soundFeedback = false;
  saved.practice.autoPronounce = false;
  assert.equal(validWorkspacePreferences(saved), true);
  const incomplete = structuredClone(saved) as any;
  delete incomplete.practice.soundFeedback;
  assert.equal(validWorkspacePreferences(incomplete), false);
  const session = createPracticeSession(["system"], "library", "copy", saved.practice);
  assert.equal(validPracticeSession(session), true);
  assert.equal(
    restorePracticeSession(session, new Set(session.ids))?.preferences.autoPronounce,
    false,
  );
  assert.equal(
    restorePracticeSession(session, new Set(session.ids))?.preferences.soundFeedback,
    false,
  );
  assert.equal(
    validPracticeSession({ ...session, preferences: incomplete.practice }),
    false,
  );
  assert.equal(
    validWorkspacePreferences({
      ...fresh,
      practice: { ...fresh.practice, soundFeedback: "yes" },
    }),
    false,
  );
  assert.equal(
    validPracticeSession({
      ...session,
      preferences: { ...session.preferences, soundFeedback: "yes" },
    }),
    false,
  );
});

test("当前偏好与断点的读取严格校验，缺字段不补齐，关闭选择跨实例保留", async () => {
  const name = `current-preferences-${crypto.randomUUID()}`,
    db = new LocalLibrary(name);
  const preferences = defaultWorkspacePreferences();
  preferences.practice.soundFeedback = false;
  preferences.practice.autoPronounce = false;
  const session = createPracticeSession(
    ["system"],
    "library",
    "copy",
    preferences.practice,
  );
  await db.saveWorkspaceMeta("workspace", preferences);
  await db.saveWorkspaceMeta("checkpoints", { library: session });
  const reopened = new LocalLibrary(name);
  assert.deepEqual(await reopened.workspaceMeta("workspace"), preferences);
  assert.deepEqual(await reopened.workspaceMeta("checkpoints"), {
    library: session,
  });
  const incomplete = structuredClone(preferences) as any;
  delete incomplete.practice.soundFeedback;
  const brokenSession = { ...session, preferences: incomplete.practice };
  await assert.rejects(db.saveWorkspaceMeta("workspace", incomplete), /格式无效/);
  await assert.rejects(
    db.saveWorkspaceMeta("checkpoints", { library: brokenSession }),
    /格式无效/,
  );
  const handle = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(name);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = handle.transaction("meta", "readwrite"),
      meta = tx.objectStore("meta");
    meta.put(incomplete, "workspace");
    meta.put({ library: brokenSession }, "checkpoints");
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
  await assert.rejects(db.workspaceMeta("workspace"), /原数据未修改/);
  await assert.rejects(db.workspaceMeta("checkpoints"), /原数据未修改/);
  const read = (key: string) =>
    new Promise((resolve, reject) => {
      const request = handle.transaction("meta", "readonly").objectStore("meta").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  assert.deepEqual(await read("workspace"), incomplete);
  assert.deepEqual(await read("checkpoints"), { library: brokenSession });
  handle.close();
});
