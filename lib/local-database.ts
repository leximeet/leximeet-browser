import {
  beginIndependentWrite,
  independentWriteFailure,
  freezeIndependentOwnership,
  resumeIndependentOwnership,
  readIndependentOwnership,
  type IndependentOwnership,
} from "./local-ownership.ts";
import {
  initializeLearning,
  initialLearningState,
  LearningRepository,
} from "./learning-repository.ts";
import { validWorkspacePreferences } from "./workspace-model.ts";
import { PRACTICE_MODES, validPracticeSession } from "./practice-session.ts";
import { publicWord } from "./pure.ts";
import {
  MAX_ACTIVE_WORDS,
  PERSONAL_FORMAT,
  PERSONAL_DB_VERSION,
  defaultLocalSettings,
  normalizedWord,
  validPlanDay,
  validPlanTimeZone,
  validateCapture,
  type BookMeta,
  type CaptureInput,
  type LocalEncounter,
  type LocalSettings,
  type Notebook,
  type StudyPlan,
  type PracticeAttempt,
  type ReviewFact,
  type UserWord,
} from "./local-model.ts";
import { validSettings } from "./local-settings.ts";
import { FSRS_ALGORITHM } from "./fsrs.ts";
import {
  defaultCapturePolicy,
  validCapturePolicy,
  prepareSafeCapture,
  captureContextKey,
  capturePayloadKey,
  type CapturePolicy,
} from "./capture-policy.ts";

const STORES = [
  "meta",
  "words",
  "encounters",
  "reviews",
  "practice",
  "notebooks",
] as const;
type Store = (typeof STORES)[number];

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

// 列表选中的版本与只读词典短义；所有批量变更一次提交。
export type PersonalWordSelection = {
  word: string;
  entryId: string | null;
  dictionaryHint: string;
  expectedRevision: number | null;
};
export type PersonalWordChange =
  | { kind: "recycle" }
  | { kind: "add-to-notebooks"; notebookIds: string[] }
  | { kind: "edit"; note: string; notebookIds: string[] };

// 偏好和断点的读写都校验当前格式；尚未保存时正常返回 undefined。
function validWorkspaceMeta(key: "workspace" | "checkpoints", value: unknown): boolean {
  if (key === "workspace") return validWorkspacePreferences(value);
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 200 &&
    Object.entries(value).every(
      ([scope, session]) =>
        !["__proto__", "constructor", "prototype"].includes(scope) &&
        validPracticeSession(session) &&
        session.scope === scope,
    )
  );
}

// 当前规划严格校验；不承接预发布个人词本目标、旧词典或旧大配额。
function validStudyPlan(value: unknown): value is StudyPlan {
  const plan = value as StudyPlan;
  return (
    !!plan &&
    typeof plan === "object" &&
    !Array.isArray(plan) &&
    Object.keys(plan).every((key) =>
      [
        "revision",
        "id",
        "sourceKind",
        "sourceId",
        "sourceVersion",
        "dailyNew",
        "dailyReview",
        "startedOn",
        "timeZone",
        "savedAt",
        "paused",
      ].includes(key),
    ) &&
    typeof plan.id === "string" &&
    !!plan.id &&
    typeof plan.sourceId === "string" &&
    !!plan.sourceId &&
    ["catalog", "dictionary"].includes(plan.sourceKind) &&
    plan.sourceVersion === "0.0.3" &&
    Number.isInteger(plan.dailyNew) &&
    plan.dailyNew >= 1 &&
    plan.dailyNew <= 50 &&
    Number.isInteger(plan.dailyReview) &&
    plan.dailyReview >= 0 &&
    plan.dailyReview <= 500 &&
    typeof plan.startedOn === "string" &&
    validPlanDay(plan.startedOn) &&
    typeof plan.timeZone === "string" &&
    validPlanTimeZone(plan.timeZone) &&
    typeof plan.savedAt === "string" &&
    Number.isFinite(Date.parse(plan.savedAt)) &&
    typeof plan.paused === "boolean" &&
    (plan.revision === undefined ||
      (Number.isSafeInteger(plan.revision) && plan.revision >= 1))
  );
}

// 独立资料使用新数据库，绝不把旧伴侣 outbox 或配对凭据静默转换为个人词条。
export class LocalLibrary {
  private opening?: Promise<IDBDatabase>;
  private readonly name: string;
  private readonly clock: () => Date;

  readonly learning: LearningRepository;

  constructor(name = "leximeet-personal-v1", clock: () => Date = () => new Date()) {
    this.name = name;
    this.clock = clock;
    this.learning = new LearningRepository(() => this.database(), clock);
  }

  private database(): Promise<IDBDatabase> {
    this.opening ??= new Promise((resolve, reject) => {
      const opening = indexedDB.open(this.name, PERSONAL_DB_VERSION);
      let openingFailure: Error | undefined;
      opening.onupgradeneeded = (event) => {
        // 首次发布只创建当前模型；拒绝旧候选时不改表结构或任何原行。
        if (event.oldVersion !== 0) {
          openingFailure = new Error("本地资料版本不受支持，原数据未修改");
          opening.transaction!.abort();
          return;
        }
        const db = opening.result;
        const now = new Date().toISOString();
        const meta = db.createObjectStore("meta");
        const words = db.createObjectStore("words", { keyPath: "id" });
        words.createIndex("normalized", "normalized", { unique: true });
        const encounters = db.createObjectStore("encounters", {
          keyPath: "id",
        });
        encounters.createIndex("wordId", "wordId");
        const reviews = db.createObjectStore("reviews", { keyPath: "id" });
        reviews.createIndex("wordId", "wordId");
        const practice = db.createObjectStore("practice", { keyPath: "id" });
        practice.createIndex("wordId", "wordId");
        const book: BookMeta = {
          format: PERSONAL_FORMAT,
          bookUid: crypto.randomUUID(),
          deviceId: crypto.randomUUID(),
          name: "浏览器插件词库",
          createdAt: now,
        };
        meta.put(book, "book");
        meta.put(defaultLocalSettings(), "settings");
        meta.put(initialLearningState(), "learning");
        const notebooks = db.createObjectStore("notebooks", { keyPath: "id" });
        const first: Notebook = {
          id: crypto.randomUUID(),
          name: "阅读摘录",
          color: "teal",
          position: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          revision: 1,
        };
        notebooks.put(first);
      };
      opening.onsuccess = async () => {
        const db = opening.result;
        db.onversionchange = () => {
          db.close();
          this.opening = undefined;
        };
        if (
          db.objectStoreNames.length !== STORES.length ||
          STORES.some((store) => !db.objectStoreNames.contains(store))
        ) {
          db.close();
          this.opening = undefined;
          reject(new Error("本地资料格式不完整，请先备份后处理"));
          return;
        }
        try {
          const tx = db.transaction("meta", "readonly");
          const book = await request<BookMeta | undefined>(
            tx.objectStore("meta").get("book"),
          );
          if (book?.format !== PERSONAL_FORMAT || book.name !== "浏览器插件词库")
            throw new Error("本地资料版本不受支持，原数据未修改");
          await initializeLearning(db);
          resolve(db);
        } catch (error) {
          db.close();
          this.opening = undefined;
          reject(error);
        }
      };
      opening.onerror = () => {
        this.opening = undefined;
        reject(openingFailure || opening.error || new Error("无法打开本地词本"));
      };
      opening.onblocked = () =>
        reject(new Error("本地词本正被其他窗口升级，请关闭旧窗口后重试"));
    });
    return this.opening;
  }

  // 连接控制只操作归属记录；原词条、事实、偏好在封存期间保持原值。
  async independentOwnership(): Promise<IndependentOwnership> {
    return readIndependentOwnership(await this.database());
  }

  async freezeIndependent(): Promise<IndependentOwnership> {
    return freezeIndependentOwnership(await this.database());
  }

  async resumeIndependent(archiveId: string): Promise<IndependentOwnership> {
    return resumeIndependentOwnership(await this.database(), archiveId);
  }

  // 通用元信息仅允许这两个公开业务键，凭据和词典缓存不可写入个人备份。
  async workspaceMeta<T>(key: "workspace" | "checkpoints"): Promise<T | undefined> {
    const db = await this.database();
    const value = await request<T | undefined>(
      db.transaction("meta").objectStore("meta").get(key),
    );
    if (value !== undefined && !validWorkspaceMeta(key, value))
      throw new Error(
        key === "workspace"
          ? "工作区设置格式无效，原数据未修改"
          : "练习断点格式无效，原数据未修改",
      );
    return value;
  }
  async saveWorkspaceMeta(
    key: "workspace" | "checkpoints",
    value: unknown,
  ): Promise<void> {
    if (key !== "workspace" && key !== "checkpoints")
      throw new Error("不支持的公开设置键");
    if (!validWorkspaceMeta(key, value))
      throw new Error(key === "workspace" ? "工作区设置格式无效" : "练习断点格式无效");
    const plain = JSON.parse(JSON.stringify(value));
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = beginIndependentWrite(db, "meta");
      tx.objectStore("meta").put(plain, key);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(independentWriteFailure(tx, new Error("设置保存失败")));
    });
  }

  async book(): Promise<BookMeta> {
    const db = await this.database();
    return request<BookMeta>(
      db.transaction("meta", "readonly").objectStore("meta").get("book"),
    );
  }

  async settings(): Promise<LocalSettings> {
    const db = await this.database();
    const saved = await request<LocalSettings>(
      db.transaction("meta", "readonly").objectStore("meta").get("settings"),
    );
    if (!validSettings(saved)) throw new Error("本机设置格式无效，原数据未修改");
    return saved;
  }

  async updateSettings(patch: Partial<LocalSettings>): Promise<LocalSettings> {
    const db = await this.database();
    return new Promise<LocalSettings>((resolve, reject) => {
      const tx = beginIndependentWrite(db, "meta");
      const meta = tx.objectStore("meta");
      const current = meta.get("settings");
      let next: LocalSettings | undefined;
      let failure: Error | undefined;
      current.onsuccess = () => {
        if (!validSettings(current.result)) {
          failure = new Error("本机设置格式无效，原数据未修改");
          tx.abort();
          return;
        }
        next = { ...current.result, ...patch };
        if (!validSettings(next)) {
          failure = new Error("设置值超出允许范围");
          tx.abort();
          return;
        }
        meta.put(next, "settings");
      };
      tx.oncomplete = () => (next ? resolve(next) : reject(new Error("设置未保存")));
      tx.onabort = tx.onerror = () =>
        reject(failure || independentWriteFailure(tx, new Error("设置保存失败")));
    });
  }

  async listWords(includeDeleted = false): Promise<UserWord[]> {
    const db = await this.database();
    const rows = await request<UserWord[]>(
      db.transaction("words", "readonly").objectStore("words").getAll(),
    );
    return rows
      .filter((word) => includeDeleted || !word.deletedAt)
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.normalized.localeCompare(b.normalized),
      );
  }

  async word(id: string): Promise<UserWord | undefined> {
    const db = await this.database();
    return request<UserWord | undefined>(
      db.transaction("words", "readonly").objectStore("words").get(id),
    );
  }

  async byNormalized(word: string): Promise<UserWord | undefined> {
    const db = await this.database();
    return request<UserWord | undefined>(
      db
        .transaction("words", "readonly")
        .objectStore("words")
        .index("normalized")
        .get(normalizedWord(word)),
    );
  }

  async listNotebooks(includeDeleted = false): Promise<Notebook[]> {
    const db = await this.database();
    const rows = await request<Notebook[]>(
      db.transaction("notebooks", "readonly").objectStore("notebooks").getAll(),
    );
    return rows
      .filter((item) => includeDeleted || !item.deletedAt)
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  }

  async createNotebook(rawName: string): Promise<Notebook> {
    const name = rawName.trim();
    if (!name || name.length > 80) throw new Error("单词本名称需为 1–80 字");
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = beginIndependentWrite(db, "notebooks");
      const store = tx.objectStore("notebooks");
      let result: Notebook | undefined;
      let failure: Error | undefined;
      const all = store.getAll();
      all.onsuccess = () => {
        const rows = all.result as Notebook[];
        if (rows.some((item) => !item.deletedAt && item.name === name)) {
          failure = new Error("已有同名单词本");
          tx.abort();
          return;
        }
        const now = new Date().toISOString();
        result = {
          id: crypto.randomUUID(),
          name,
          color: "teal",
          position: Math.max(-1, ...rows.map((item) => item.position)) + 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          revision: 1,
        };
        store.add(result);
      };
      tx.oncomplete = () => (result ? resolve(result) : reject(new Error("创建失败")));
      tx.onabort = tx.onerror = () =>
        reject(failure || independentWriteFailure(tx, new Error("创建单词本失败")));
    });
  }

  async updateNotebook(
    id: string,
    expectedRevision: number,
    patch: { name?: string; deleted?: boolean; position?: number },
  ): Promise<Notebook> {
    const name = patch.name?.trim();
    if (name !== undefined && (!name || name.length > 80))
      throw new Error("单词本名称需为 1–80 字");
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = beginIndependentWrite(db, "notebooks");
      const store = tx.objectStore("notebooks");
      let result: Notebook | undefined;
      let failure: Error | undefined;
      const all = store.getAll();
      all.onsuccess = () => {
        const rows = all.result as Notebook[];
        const current = rows.find((item) => item.id === id);
        if (!current) failure = new Error("单词本不存在");
        else if (current.revision !== expectedRevision)
          failure = new Error("单词本已在另一窗口修改");
        else if (
          name &&
          rows.some((item) => item.id !== id && !item.deletedAt && item.name === name)
        )
          failure = new Error("已有同名单词本");
        if (failure) {
          tx.abort();
          return;
        }
        result = {
          ...current!,
          name: name ?? current!.name,
          deletedAt:
            patch.deleted === undefined
              ? current!.deletedAt
              : patch.deleted
                ? new Date().toISOString()
                : null,
          position: patch.position ?? current!.position,
          updatedAt: new Date().toISOString(),
          revision: current!.revision + 1,
        };
        store.put(result);
      };
      tx.oncomplete = () =>
        result ? resolve(result) : reject(new Error("单词本未保存"));
      tx.onabort = tx.onerror = () =>
        reject(failure || independentWriteFailure(tx, new Error("单词本修改失败")));
    });
  }

  async setWordNotebooks(
    id: string,
    expectedRevision: number,
    notebookIds: string[],
  ): Promise<UserWord> {
    const ids = [...new Set(notebookIds)];
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = beginIndependentWrite(db, ["words", "notebooks"]);
      let result: UserWord | undefined;
      let failure: Error | undefined;
      const words = tx.objectStore("words");
      Promise.all([
        request<UserWord | undefined>(words.get(id)),
        request<Notebook[]>(tx.objectStore("notebooks").getAll()),
      ])
        .then(([word, notebooks]) => {
          if (!word || word.deletedAt) throw new Error("词条不存在或已回收");
          if (word.revision !== expectedRevision) throw new Error("词条已在另一窗口修改");
          if (
            ids.some(
              (item) =>
                !notebooks.some(
                  (notebook) => notebook.id === item && !notebook.deletedAt,
                ),
            )
          )
            throw new Error("不能加入不存在或已回收的单词本");
          result = {
            ...word,
            notebookIds: ids,
            updatedAt: new Date().toISOString(),
            revision: word.revision + 1,
          };
          words.put(result);
        })
        .catch((cause) => {
          failure = independentWriteFailure(tx, cause as Error);
          try {
            tx.abort();
          } catch {
            // 归属检查可能已中止整个事务。
          }
        });
      tx.oncomplete = () => (result ? resolve(result) : reject(new Error("关联未保存")));
      tx.onabort = tx.onerror = () =>
        reject(failure || independentWriteFailure(tx, new Error("单词本关联失败")));
    });
  }

  async plan(): Promise<StudyPlan | null> {
    const db = await this.database();
    const plan = await request<StudyPlan | undefined>(
      db.transaction("meta", "readonly").objectStore("meta").get("studyPlan"),
    );
    if (plan !== undefined && !validStudyPlan(plan))
      throw new Error("学习规划格式无效，原数据未修改");
    return plan ?? null;
  }

  async savePlan(plan: StudyPlan | null, expectedRevision?: number): Promise<void> {
    if (plan && !validStudyPlan(plan))
      throw new Error(
        "学习规划内容无效：新学 1–50 词，复习 0–500 词，来源为当前词书或词典",
      );
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = beginIndependentWrite(db, "meta");
      let failure: Error | undefined;
      const meta = tx.objectStore("meta"),
        current = meta.get("studyPlan");
      current.onsuccess = () => {
        const old = current.result as StudyPlan | undefined;
        if (old !== undefined && !validStudyPlan(old)) {
          failure = new Error("学习规划格式无效，原数据未修改");
          tx.abort();
          return;
        }
        if (expectedRevision !== undefined && (old?.revision ?? 0) !== expectedRevision) {
          failure = new Error("学习规划已在另一窗口变化，请刷新后重试");
          tx.abort();
          return;
        }
        if (plan) meta.put({ ...plan, revision: (old?.revision ?? 0) + 1 }, "studyPlan");
        else meta.delete("studyPlan");
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(failure || independentWriteFailure(tx, new Error("学习规划保存失败")));
    });
  }

  // 唯一词头和遇见事件在同一事务中落盘；重复事件直接返回原词条。
  // 同版本升级只增加独立偏好项；读取默认值不写库，也不改发布资料格式。
  async capturePolicy(): Promise<CapturePolicy> {
    const db = await this.database();
    const value = await request(
      db.transaction("meta", "readonly").objectStore("meta").get("capture-policy"),
    );
    if (value === undefined) return defaultCapturePolicy();
    if (!validCapturePolicy(value)) throw new Error("采集设置格式无效，原资料未修改");
    return value;
  }
  async updateCapturePolicy(patch: Partial<CapturePolicy>): Promise<CapturePolicy> {
    const db = await this.database();
    return this.captureTransaction(db, ["meta"], async (tx) => {
      const meta = tx.objectStore("meta"),
        saved = await request(meta.get("capture-policy"));
      const current = saved === undefined ? defaultCapturePolicy() : saved;
      if (!validCapturePolicy(current)) throw new Error("采集设置格式无效，原资料未修改");
      const next = { ...current, ...patch };
      if (!validCapturePolicy(next)) throw new Error("采集设置超出允许范围");
      meta.put(next, "capture-policy");
      return next;
    });
  }
  private async captureTransaction<T>(
    db: IDBDatabase,
    stores: string[],
    run: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const tx = beginIndependentWrite(db, stores);
    let failure: unknown;
    const complete = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          failure || independentWriteFailure(tx, new Error("采集事务失败，原资料未修改")),
        );
    });
    try {
      const result = await run(tx);
      await complete;
      return result;
    } catch (error) {
      failure = independentWriteFailure(tx, error as Error);
      try {
        tx.abort();
      } catch {}
      await complete.catch(() => {});
      throw failure;
    }
  }
  async capture(raw: CaptureInput): Promise<{
    word: UserWord;
    duplicate: boolean;
    captureStatus: "created" | "duplicate-context";
    capturePolicy: CapturePolicy;
    encounterId: string;
  }> {
    // 只持久化指纹，不留下另一份敏感原文；同一事件的原始载荷不能随设置变化而变更。
    const validated = validateCapture(raw);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(capturePayloadKey(raw)),
    );
    const fingerprint = Array.from(new Uint8Array(digest), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
    const db = await this.database(),
      book = await this.book();
    return this.captureTransaction(
      db,
      ["meta", "words", "encounters", "notebooks"],
      async (tx) => {
        const meta = tx.objectStore("meta"),
          words = tx.objectStore("words"),
          encounters = tx.objectStore("encounters");
        const receiptKey = "capture-event/" + validated.eventId;
        const receipt = await request(meta.get(receiptKey));
        if (receipt) {
          if (receipt.fingerprint !== fingerprint)
            throw new Error("相同遇见事件 ID 的内容不一致");
          const word = await request<UserWord>(words.get(receipt.wordId));
          if (!word) throw new Error("遇见事件与词条不一致");
          return {
            word,
            duplicate: true,
            captureStatus: receipt.captureStatus,
            capturePolicy: receipt.capturePolicy,
            encounterId: receipt.encounterId,
          };
        }
        const savedPolicy = await request(meta.get("capture-policy"));
        const policy = savedPolicy === undefined ? defaultCapturePolicy() : savedPolicy;
        if (!validCapturePolicy(policy))
          throw new Error("采集设置格式无效，原资料未修改");
        const input = validateCapture(prepareSafeCapture(validated, policy));
        const canonical =
            input.dictionary?.word && publicWord(input.dictionary.word)
              ? input.dictionary.word
              : input.surface,
          key = normalizedWord(canonical);
        const notebooks = await request<Notebook[]>(tx.objectStore("notebooks").getAll());
        const notebookId =
          input.notebookId ??
          notebooks.filter((n) => !n.deletedAt).sort((a, b) => a.position - b.position)[0]
            ?.id;
        if (notebookId && !notebooks.some((n) => n.id === notebookId && !n.deletedAt))
          throw new Error("单词本不可用，请重新选择");
        const prior = await request<LocalEncounter | undefined>(
          encounters.get(input.eventId),
        );
        if (prior) {
          // 上次发布的同版本事实照常可读；不转换/重写任何旧行。
          const fields = [
            "surface",
            "originalSentence",
            "savedExcerpt",
            "occurrenceRanges",
            "excerptRanges",
            "annotation",
            "source",
            "occurredAt",
            "timeZone",
          ] as const;
          if (
            fields.some(
              (field) => JSON.stringify(prior[field]) !== JSON.stringify(input[field]),
            )
          )
            throw new Error("相同遇见事件 ID 的内容不一致");
          const word = await request<UserWord>(words.get(prior.wordId));
          if (!word || word.normalized !== key) throw new Error("遇见事件与词条不一致");
          return {
            word,
            duplicate: true,
            captureStatus: "created" as const,
            capturePolicy: policy,
            encounterId: prior.id,
          };
        }
        const existing = await request<UserWord | undefined>(
          words.index("normalized").get(key),
        );
        const now = this.clock(),
          nowText = now.toISOString();
        const previous =
          existing && policy.duplicateWindowDays > 0
            ? (
                await request<LocalEncounter[]>(
                  encounters.index("wordId").getAll(existing.id),
                )
              )
                .filter(
                  (e) =>
                    !e.undoneAt &&
                    Date.parse(e.occurredAt) >=
                      now.getTime() - policy.duplicateWindowDays * 86400000 &&
                    Date.parse(e.occurredAt) <= now.getTime() &&
                    captureContextKey(e.savedExcerpt) ===
                      captureContextKey(input.savedExcerpt),
                )
                .sort(
                  (a, b) =>
                    b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
                )[0]
            : undefined;
        if (previous && existing) {
          meta.put(
            {
              fingerprint,
              wordId: existing.id,
              encounterId: previous.id,
              captureStatus: "duplicate-context",
              capturePolicy: policy,
            },
            receiptKey,
          );
          return {
            word: existing,
            duplicate: true,
            captureStatus: "duplicate-context" as const,
            capturePolicy: policy,
            encounterId: previous.id,
          };
        }
        if (
          !existing &&
          (await request<UserWord[]>(words.getAll())).filter(
            (w) => !w.deletedAt && w.collected !== false,
          ).length >= MAX_ACTIVE_WORDS
        )
          throw new Error("我的词本已达到 1 万个活动词条上限");
        const word: UserWord = existing
          ? {
              ...existing,
              notebookIds: [
                ...new Set([
                  ...existing.notebookIds,
                  ...(notebookId ? [notebookId] : []),
                ]),
              ],
              collected: true,
              deletedAt: null,
              updatedAt: nowText,
              revision: existing.revision + 1,
            }
          : {
              id: crypto.randomUUID(),
              bookUid: book.bookUid,
              word: canonical,
              collected: true,
              entryId: input.dictionary?.entryId || null,
              normalized: key,
              note: "",
              dictionaryHint: input.dictionary?.meaning || "",
              phoneticHint: input.dictionary?.phonetic || "",
              createdAt: nowText,
              updatedAt: nowText,
              deletedAt: null,
              revision: 1,
              notebookIds: notebookId ? [notebookId] : [],
            };
        const encounter: LocalEncounter = {
          id: input.eventId,
          wordId: word.id,
          surface: input.surface,
          originalSentence: input.originalSentence,
          savedExcerpt: input.savedExcerpt,
          occurrenceRanges: input.occurrenceRanges,
          excerptRanges: input.excerptRanges,
          annotation: input.annotation,
          source: input.source,
          occurredAt: input.occurredAt,
          timeZone: input.timeZone,
          undoneAt: null,
        };
        words.put(word);
        encounters.put(encounter);
        meta.put(
          {
            fingerprint,
            wordId: word.id,
            encounterId: encounter.id,
            captureStatus: "created",
            capturePolicy: policy,
          },
          receiptKey,
        );
        return {
          word,
          duplicate: false,
          captureStatus: "created" as const,
          capturePolicy: policy,
          encounterId: encounter.id,
        };
      },
    );
  }

  // 手工加词只建立个人词条；没有真实网页原句时绝不伪造 Encounter。
  async addWord(
    surface: string,
    dictionary?: CaptureInput["dictionary"],
    collected = true,
    entryId: string | null = null,
  ): Promise<UserWord> {
    const word = surface.trim();
    const key = normalizedWord(word);
    const db = await this.database();
    const book = await this.book();
    const defaultNotebookId = (await this.listNotebooks())[0]?.id;
    return new Promise((resolve, reject) => {
      const tx = beginIndependentWrite(db, "words");
      const store = tx.objectStore("words");
      const lookup = store.index("normalized").get(key);
      let result: UserWord | undefined;
      let failure: Error | undefined;
      lookup.onsuccess = () => {
        const existing = lookup.result as UserWord | undefined;
        const promoting = !!existing && collected && existing.collected === false;
        if (existing && !existing.deletedAt && !promoting) {
          result = existing;
          return;
        }
        // 手工明确加入可恢复/收录同一词；ensurePersonal(false)不把资源词变成收藏。
        const willCollect = collected || (!!existing && existing.collected !== false);
        const save = () => {
          const now = new Date().toISOString();
          result = existing
            ? {
                ...existing,
                collected: collected ? true : existing.collected,
                deletedAt: null,
                updatedAt: now,
                revision: existing.revision + 1,
              }
            : {
                id: crypto.randomUUID(),
                bookUid: book.bookUid,
                word,
                normalized: key,
                note: "",
                dictionaryHint: dictionary?.meaning || "",
                phoneticHint: dictionary?.phonetic || "",
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
                revision: 1,
                collected,
                entryId,
                notebookIds: collected && defaultNotebookId ? [defaultNotebookId] : [],
              };
          store.put(result);
        };
        const all = store.getAll();
        all.onsuccess = () => {
          if (
            willCollect &&
            (all.result as UserWord[]).filter(
              (item) => !item.deletedAt && item.collected !== false,
            ).length >= MAX_ACTIVE_WORDS
          ) {
            failure = new Error("我的词本已达到 1 万个活动词条上限");
            tx.abort();
            return;
          }
          save();
        };
      };
      tx.oncomplete = () => (result ? resolve(result) : reject(new Error("词条未保存")));
      tx.onabort = tx.onerror = () =>
        reject(failure || independentWriteFailure(tx, new Error("本地保存失败")));
    });
  }

  // 只保存个人笔记和单词本关联；不允许改写公共词义或直接标记熟悉度。
  async editWord(
    id: string,
    expectedRevision: number,
    patch: Partial<Pick<UserWord, "note" | "notebookIds">>,
  ): Promise<UserWord> {
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some((key) => !["note", "notebookIds"].includes(key)) ||
      (patch.note !== undefined && typeof patch.note !== "string") ||
      (patch.notebookIds !== undefined &&
        (!Array.isArray(patch.notebookIds) ||
          patch.notebookIds.some((id) => typeof id !== "string" || !id)))
    )
      throw new Error("个人内容仅支持笔记与单词本");
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = beginIndependentWrite(
        db,
        patch.notebookIds === undefined ? ["words"] : ["words", "notebooks"],
      );
      const store = tx.objectStore("words");
      let result: UserWord | undefined;
      let failure: Error | undefined;
      const abort = (cause: Error) => {
        failure = cause;
        tx.abort();
      };
      store.get(id).onsuccess = (event) => {
        const current = (event.target as IDBRequest<UserWord | undefined>).result;
        if (!current || current.deletedAt) return abort(new Error("词条不存在或已回收"));
        if (current.revision !== expectedRevision)
          return abort(new Error("词条已在另一窗口修改，请保留草稿并刷新"));
        const save = (notebookIds = current.notebookIds) => {
          result = {
            ...current,
            note: patch.note?.slice(0, 4000) ?? current.note,
            notebookIds,
            collected: patch.notebookIds?.length ? true : current.collected,
            updatedAt: new Date().toISOString(),
            revision: current.revision + 1,
          };
          store.put(result);
        };
        if (patch.notebookIds === undefined) return save();
        const ids = [...new Set(patch.notebookIds)];
        tx.objectStore("notebooks").getAll().onsuccess = (books) => {
          const notebooks = (books.target as IDBRequest<Notebook[]>).result;
          if (ids.some((item) => !notebooks.some((b) => b.id === item && !b.deletedAt)))
            return abort(new Error("不能加入不存在或已回收的单词本"));
          save(ids);
        };
      };
      tx.oncomplete = () => (result ? resolve(result) : reject(new Error("编辑未保存")));
      tx.onabort = tx.onerror = () =>
        reject(
          failure || independentWriteFailure(tx, new Error("编辑失败，原资料未修改")),
        );
    });
  }

  /**
   * 资源词物化、笔记/多本关联或回收在一个事务内完成。
   * 逐项先校验版本与单词本，整批成功才写入；封存期间同样拒绝业务写入。
   */
  async updatePersonalWords(
    selections: PersonalWordSelection[],
    change: PersonalWordChange,
  ): Promise<UserWord[]> {
    if (!selections.length || selections.length > MAX_ACTIVE_WORDS)
      throw new Error("请选择 1–10000 个单词");
    if (
      change.kind === "edit" &&
      (selections.length !== 1 ||
        typeof change.note !== "string" ||
        change.note.length > 4000)
    )
      throw new Error("笔记编辑需要一个词条，笔记最多 4000 字");
    if (!["recycle", "add-to-notebooks", "edit"].includes(change.kind))
      throw new Error("不支持的个人词条操作");
    const entries = selections.map((s) => {
      const key = normalizedWord(s.word);
      if (
        typeof s.dictionaryHint !== "string" ||
        s.dictionaryHint.length > 4000 ||
        (s.entryId !== null && (typeof s.entryId !== "string" || !s.entryId)) ||
        (s.expectedRevision !== null &&
          (!Number.isSafeInteger(s.expectedRevision) || s.expectedRevision < 1))
      )
        throw new Error("选中词条格式无效");
      return { ...s, key };
    });
    if (new Set(entries.map((e) => e.key)).size !== entries.length)
      throw new Error("不能重复选择同一个单词");
    const ids = change.kind === "recycle" ? [] : [...new Set(change.notebookIds)];
    if (change.kind === "add-to-notebooks" && !ids.length)
      throw new Error("请选择至少一个单词本");
    const db = await this.database();
    return this.captureTransaction(db, ["meta", "words", "notebooks"], async (tx) => {
      const store = tx.objectStore("words");
      const [all, notebooks, book] = await Promise.all([
        request<UserWord[]>(store.getAll()),
        request<Notebook[]>(tx.objectStore("notebooks").getAll()),
        request<BookMeta>(tx.objectStore("meta").get("book")),
      ]);
      if (ids.some((id) => !notebooks.some((b) => b.id === id && !b.deletedAt)))
        throw new Error("不能加入不存在或已回收的单词本");
      const byKey = new Map(all.map((w) => [w.normalized, w]));
      const at = this.clock().toISOString();
      const result = entries.map((e): UserWord => {
        const current = byKey.get(e.key);
        if (current?.deletedAt) throw new Error("词条已回收，请刷新列表后重新选择");
        if ((current?.revision ?? null) !== e.expectedRevision)
          throw new Error("词条已在另一窗口修改，请保留选择并刷新");
        const word: UserWord = current || {
          id: crypto.randomUUID(),
          bookUid: book.bookUid,
          word: e.word.trim(),
          normalized: e.key,
          entryId: e.entryId,
          note: "",
          dictionaryHint: e.dictionaryHint,
          phoneticHint: "",
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
          revision: 0,
          notebookIds: [],
          collected: false,
        };
        return {
          ...word,
          note: change.kind === "edit" ? change.note : word.note,
          notebookIds:
            change.kind === "add-to-notebooks"
              ? [...new Set([...word.notebookIds, ...ids])]
              : change.kind === "edit"
                ? ids
                : word.notebookIds,
          collected: change.kind !== "recycle" && ids.length ? true : word.collected,
          deletedAt: change.kind === "recycle" ? at : null,
          updatedAt: at,
          revision: word.revision + 1,
        };
      });
      const changed = new Map(result.map((w) => [w.normalized, w]));
      const activeCount = [
        ...all.filter((w) => !changed.has(w.normalized)),
        ...result,
      ].filter((w) => !w.deletedAt && w.collected !== false).length;
      if (activeCount > MAX_ACTIVE_WORDS)
        throw new Error("我的词本已达到 1 万个活动词条上限");
      for (const word of result) store.put(word);
      return result;
    });
  }

  async setDeleted(id: string, deleted: boolean): Promise<UserWord> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = beginIndependentWrite(db, "words");
      const store = tx.objectStore("words");
      const get = store.get(id);
      let result: UserWord | undefined;
      let failure: Error | undefined;
      get.onsuccess = () => {
        const word = get.result as UserWord | undefined;
        if (!word) {
          tx.abort();
          return;
        }
        const restoring = !deleted && !!word.deletedAt;
        // 只将真正恢复回收词的操作视为主动保留；重复恢复活动词不改变收录状态。
        if (!deleted && !restoring) {
          result = word;
          return;
        }
        const save = () => {
          result = {
            ...word,
            collected: restoring ? true : word.collected,
            deletedAt: deleted ? new Date().toISOString() : null,
            updatedAt: new Date().toISOString(),
            revision: word.revision + 1,
          };
          store.put(result);
        };
        if (deleted) return save();
        const all = store.getAll();
        all.onsuccess = () => {
          if (
            (all.result as UserWord[]).filter(
              (item) => !item.deletedAt && item.collected !== false,
            ).length >= MAX_ACTIVE_WORDS
          ) {
            failure = new Error("我的词本已达到 1 万个活动词条上限");
            tx.abort();
            return;
          }
          save();
        };
      };
      tx.oncomplete = () => (result ? resolve(result) : reject(new Error("词条不存在")));
      tx.onabort = tx.onerror = () =>
        reject(failure || independentWriteFailure(tx, new Error("回收或恢复失败")));
    });
  }

  async encounters(wordId?: string): Promise<LocalEncounter[]> {
    const db = await this.database();
    const store = db.transaction("encounters", "readonly").objectStore("encounters");
    const rows = await request<LocalEncounter[]>(
      wordId ? store.index("wordId").getAll(wordId) : store.getAll(),
    );
    return rows.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  async reviews(wordId?: string): Promise<ReviewFact[]> {
    const db = await this.database();
    const store = db.transaction("reviews", "readonly").objectStore("reviews");
    const rows = await request<ReviewFact[]>(
      wordId ? store.index("wordId").getAll(wordId) : store.getAll(),
    );
    return rows.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async addReview(fact: ReviewFact): Promise<void> {
    if (
      !fact.id ||
      !fact.wordId ||
      !["again", "hard", "good", "easy"].includes(fact.rating) ||
      !Number.isFinite(Date.parse(fact.createdAt)) ||
      fact.undoneAt !== null ||
      fact.algorithmVersion !== FSRS_ALGORITHM
    )
      throw new Error("复习事实无效");
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = beginIndependentWrite(db, ["words", "reviews"]);
      const found = tx.objectStore("words").get(fact.wordId);
      let failure: Error | undefined;
      found.onsuccess = () => {
        if (!found.result || (found.result as UserWord).deletedAt) {
          failure = new Error("只能复习当前词本中的活动词条");
          tx.abort();
          return;
        }
        tx.objectStore("reviews").add(fact);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(failure || independentWriteFailure(tx, new Error("复习事实保存失败")));
    });
  }

  async undoReview(id: string): Promise<void> {
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = beginIndependentWrite(db, "reviews"),
        store = tx.objectStore("reviews");
      let failure: Error | undefined;
      const get = store.get(id);
      get.onsuccess = () => {
        const fact = get.result as ReviewFact | undefined;
        if (!fact) {
          failure = new Error("复习记录不存在");
          tx.abort();
          return;
        }
        if (!fact.undoneAt) store.put({ ...fact, undoneAt: new Date().toISOString() });
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(failure || independentWriteFailure(tx, new Error("复习撤回失败")));
    });
  }

  async addPractice(attempt: PracticeAttempt): Promise<void> {
    if (
      !attempt.id ||
      (!attempt.wordId && !attempt.entryId) ||
      !PRACTICE_MODES.includes(attempt.mode as (typeof PRACTICE_MODES)[number]) ||
      typeof attempt.answer !== "string" ||
      attempt.answer.length > 120 ||
      typeof attempt.correct !== "boolean" ||
      !Number.isFinite(attempt.durationMs) ||
      attempt.durationMs < 0 ||
      !Number.isFinite(Date.parse(attempt.createdAt))
    )
      throw new Error("练习事实无效");
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = beginIndependentWrite(db, ["words", "practice"]);
      const found = tx.objectStore("words").get(attempt.wordId || "");
      let failure: Error | undefined;
      found.onsuccess = () => {
        if (attempt.wordId && (!found.result || (found.result as UserWord).deletedAt)) {
          failure = new Error("只能练习当前词本中的活动词条");
          tx.abort();
          return;
        }
        tx.objectStore("practice").add(attempt);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(failure || independentWriteFailure(tx, new Error("练习事实保存失败")));
    });
  }

  async practice(wordId?: string): Promise<PracticeAttempt[]> {
    const db = await this.database();
    const store = db.transaction("practice", "readonly").objectStore("practice");
    return request<PracticeAttempt[]>(
      wordId ? store.index("wordId").getAll(wordId) : store.getAll(),
    );
  }
}

export const localLibrary = new LocalLibrary();
