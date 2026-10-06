export type Identity = {
  libraryId: string;
  profileId: string;
  databaseGeneration: string;
  authorizationEpoch: number;
};
export type Auth = {
  clientId: string;
  credential: string;
  identity: Identity;
  scopes: string[];
};
export type Rules = {
  schemaVersion: 1;
  revision: string;
  language: "en";
  length: { min: number; max: number } | null;
  allowedPos: string[] | null;
  allowedFamiliarity: string[] | null;
  excludedLexemes: string[];
  posMode: "dictionary-possible";
  unknownPolicy: "review" | "exclude";
  normalizationVersion: "en-lexeme-1";
};
export type Target = { kind: "library" } | { kind: "book"; bookId: string };
export type IndexItem = {
  wordId: string;
  word: string;
  normalized: string;
  status: "new" | "learning" | "review" | "mastered";
  encounterCount: number;
  wordRevision: string;
};
export type IndexCache = {
  identity: Identity;
  revision: string;
  items: IndexItem[];
  expiresAt: number;
  updatedAt: number;
};
export type Dictionary = {
  entryId?: string;
  word: string;
  meaning: string;
  phonetic: string;
  possiblePos: string[];
  source: "ECDICT" | "leximeet-dictionary";
  version: string;
} | null;
export type CaptureItem = {
  eventId: string;
  surface: string;
  selectedWordId?: string;
  originalSentence: string;
  savedExcerpt: string;
  occurrenceRanges: { start: number; end: number }[];
  excerptRanges: { start: number; end: number }[];
  annotation: { note: string };
  source: { type: "browser"; title: string; url: string };
  occurredAt: string;
  timeZone: string;
  // 服务端签发的短命未知词性决定；不参与内容指纹，不能改写 eventId。
  posReviewDecisionId?: string;
};
export type Draft = CaptureItem & {
  // 原点选仅保留 SHA-256，不把未脱敏正文放进持久草稿。
  pickFingerprint?: string;
  capturePolicy?: import("./capture-policy.ts").CapturePolicy;
  // 连接模式草稿绑定原 owner；稳定词条由 Desktop 提供。
  desktopWord?: import("./connector/types.ts").WordRef;
  ownerTicket?: string;
  dictionary?: Dictionary;
  occurrenceId: string;
};
export type CaptureSession = {
  sessionId: string;
  desktopRevision: string;
  lexiconRevision: string;
  effectiveRules: Rules;
  effectiveHash: string;
  expiresAt: string;
};
export type CaptureResult = {
  eventId: string;
  status: "saved" | "duplicate" | "rejected" | "undone";
  wordId?: string;
  encounterId?: string;
  error?: { code: string; message: string; retryable: boolean };
};
export type Outbox = {
  batchId: string;
  sessionId: string;
  target: Target;
  items: CaptureItem[];
  identity: Identity;
  clientId: string;
  createdAt: string;
  // Desktop 全批确认时刻；缺失时清理资格回退到 createdAt。
  confirmedAt?: string;
  // 只属于本机队列的人工确认记录，绑定不可变事件；绝不作为 wire 上的已审核布尔。
  posReviewEventIds?: string[];
  posReviewRequired?: boolean;
  status: "pending" | "partial" | "confirmed" | "isolated";
  results?: CaptureResult[];
  error?: string;
};
export type WordCard = {
  identity: Identity;
  word: {
    id: string;
    word: string;
    meaning: string;
    phonetic: string;
    note: string;
    status: string;
    definitionStatus: string;
  };
  books: { id: string; name: string }[];
  encounters: {
    id: string;
    context: string;
    originalSentence?: string;
    savedExcerpt?: string;
    annotation?: { note: string };
    sourceTitle: string;
    sourceUrl: string;
    occurredAt: string;
  }[];
  nextCursor: string | null;
  wordRevision: string;
  cachePolicy: { maxAgeMs: number };
};
export type Occurrence = {
  id: string;
  surface: string;
  normalized: string;
  wordId?: string;
  status?: string;
  meaning?: string;
  origin?: "target" | "manual" | "both" | "other";
  dictionary?: Dictionary;
  // 仅采集：未知词性需人工确认，不等于已放行。
  needsPosReview?: boolean;
  start: number;
  end: number;
  sentence: string;
  sentenceStart: number;
};
export type PageState = {
  tabId: number;
  documentId: string;
  generation: string;
  title: string;
  url: string;
  phase: "idle" | "analyzing" | "encounter" | "capture";
  // 结果所属模式独立于生命周期；结束采集后不能把候选误投影为个人遇见。
  resultMode?: "encounter" | "capture";
  occurrences: Occurrence[];
  selectedId: string | null;
  drafts: Draft[];
  partial: boolean;
  message: string;
  session?: CaptureSession;
  target: Target;
  browserRules: Rules;
  draftIdentity?: Identity;
};
export type Settings = {
  theme: "system" | "light" | "dark";
  browserRules: Rules;
};
export type UiState = {
  connection: {
    status: string;
    error: string;
    identity?: Identity;
    scopes: string[];
  };
  index: {
    count: number;
    revision?: string;
    updatedAt?: number;
    valid: boolean;
    syncing?: { received: number; complete: boolean };
  };
  page: PageState | null;
  settings: Settings;
  books: { id: string; name: string }[];
  defaultBookId: string | null;
  outbox: Outbox[];
  rules?: Rules;
};
