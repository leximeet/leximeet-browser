import type { LexiconProvider, LexiconEntry } from "./lexicon.ts";
import type { LibraryItem } from "./workspace-model.ts";
import type { PracticeMode } from "./practice-session.ts";
import { meaningChoices, clozeQuestion } from "./practice-session.ts";
import type { LearningRepository, FrozenQuestion } from "./learning-repository.ts";

const DISTRACTORS = [
  "ability",
  "accept",
  "action",
  "attention",
  "benefit",
  "change",
  "coherent",
  "data",
  "efficient",
  "environment",
  "evidence",
  "network",
  "perspective",
  "resilient",
  "resource",
  "system",
  "work",
  "subtle",
];
// 题目由可信词典和个人资料生成；前端只提交答案，不提交正确与否、分数或排程。
export class LearningService {
  private pool: Promise<LexiconEntry[]> | null = null;
  readonly repository: LearningRepository;
  private readonly lexicon: LexiconProvider;
  constructor(repository: LearningRepository, lexicon: LexiconProvider) {
    this.repository = repository;
    this.lexicon = lexicon;
  }
  async prepare(
    sessionId: string,
    item: LibraryItem,
    mode: PracticeMode,
    ignoreCase: boolean,
    contexts: string[] = [],
    index = 0,
  ): Promise<FrozenQuestion> {
    const identity =
      item.personal?.entryId ||
      (!item.personal ? item.entryId : null) ||
      item.personal?.id ||
      item.key;
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([sessionId, identity, mode])),
    );
    const attemptId =
      "question:" +
      Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
    const old = await this.repository.question(attemptId);
    if (old) return old;
    const entries = await this.lexicon.lookupAll(item.word);
    const requested = item.personal?.entryId || (!item.personal ? item.entryId : null);
    const entry = requested ? entries.find((e) => e.entryId === requested) : entries[0];
    if (requested && !entry && !item.personal)
      throw new Error("当前词典找不到原词条；请恢复原词典后继续");
    // 切回 Lite 不丢 Core 个人词的学习经历；缺资源时仍可按已保存词形练习，选义不造题。
    this.pool ??= Promise.all(DISTRACTORS.map((w) => this.lexicon.lookup(w))).then((es) =>
      es.filter((e): e is LexiconEntry => !!e),
    );
    const options =
      mode === "meaning-choice" && entry
        ? meaningChoices(entry, await this.pool, index)
        : [];
    const example = clozeQuestion(item.word, [
      ...contexts,
      ...(entry?.senses.flatMap((s) => s.examples).map((e) => e.text) || []),
    ]);
    return this.repository.freeze({
      attemptId,
      wordId: item.personal?.id || null,
      entryId: requested || entry?.entryId || null,
      word: item.word,
      meaning: item.meaning,
      phonetic: entry?.phonetic || "",
      mode,
      ignoreCase,
      options: options.map(({ id, text }) => ({ id, text })),
      correctChoiceId: options.find((c) => c.correct)?.id || null,
      sentence: example?.sentence || null,
    });
  }
}
