// LMCP 1.0.0 的 wire DTO；稳定词条身份由 Desktop 返回，不能用词头替代。
export type PairingOwner = {
  pairingId: string;
  desktopInstanceId: string;
  clientInstanceId: string;
  workspaceId: string;
  generation: string;
  authorizationEpoch: string;
};
export type PairingCredential = PairingOwner & { pairingToken: string };
export type Authorization = {
  sessionId: string;
  sessionToken: string;
  workspaceId: string;
  generation: string;
  authorizationEpoch: string;
};
export type SessionState = {
  authorization: Authorization;
  expiresAt: string;
  readLeaseUntil: string;
  scopes: string[];
  pairingId: string;
  owner: PairingOwner;
};
export type PairResult = SessionState & {
  pairingCredential: PairingCredential;
};
export type HelloResult = {
  apiVersion: string;
  desktopInstanceId: string;
  methods: string[];
  maxFrameBytes: number;
  capabilities: string[];
  connectionId: string;
  contractVersion: string;
  contractDigest: string;
  displayName: string;
};
// 秘密邀请只在可信后台持久保存，UI 只能取得不含 token 的安全投影。
export type ConnectionInvitation = {
  invitationId: string;
  invitationToken: string;
  requestedBy: "desktop" | "plugin";
  expiresAt: string;
};
export type ConnectionStatus = {
  desktopInstanceId: string;
  displayName: string;
  connectionState: "unpaired" | "connected" | "disconnected" | "revoked";
  invitationState: "none" | "pending" | "accepted" | "cancelled" | "expired";
  invitation: ConnectionInvitation | null;
};
export type WordRef =
  | {
      kind: "dictionary";
      entryId: string;
      release: string;
      entrySchema: "leximeet.entry.v2";
    }
  | { kind: "custom"; customId: string; headword: string; language: "en" };
export type WordSummary = {
  word: WordRef;
  headword: string | null;
  collected: boolean;
  inTarget: boolean;
  resourceStatus: "available" | "missing" | "unsupported";
  personal: { note: string } | null;
  learning: {
    status: "new" | "learning" | "review" | "mastered";
    score: number;
    asOf: string;
  };
  refreshAfterMs: number;
};
export type MatchResult = {
  results: {
    inputIndex: number;
    matches: {
      word: WordRef;
      headword: string;
      inTarget: boolean;
      collected: boolean;
      learningStatus: WordSummary["learning"]["status"];
      score: number;
    }[];
    complete: boolean;
  }[];
  workspaceRevision: string;
  asOf: string;
  refreshAfterMs: number;
};
export type WorkspaceResult = {
  capturePolicy?: import("../capture-policy.ts").CapturePolicy;
  owner: PairingOwner;
  revision: string;
  dictionaryRelease: string;
  dictionaryEdition: "lite-text" | "core-text" | "full-text";
  account:
    | { status: "unavailable" | "signed-out"; source: "desktop" }
    | {
        status: "signed-in";
        source: "desktop";
        account: { id: string; displayName: string };
      };
  cloudSync: "disabled" | "ready" | "syncing" | "error";
  readLeaseUntil: string;
};
export type TextRange = { start: number; end: number };
export type EncounterInput = {
  word: WordRef;
  surface: string;
  originalSentence: string;
  savedExcerpt: string;
  occurrenceRanges: TextRange[];
  excerptRanges: TextRange[];
  annotation: { note: string };
  source: { kind: "web" | "manual"; title: string; url: string | null };
  collectionIntent: "collect";
};
export type RecordEncounterParams = {
  eventId: string;
  data: EncounterInput;
  notebookId: string | null;
  mutationId: string;
};
export type EncounterRecord = {
  entityType: "encounter";
  entityId: string;
  revision: string;
  deletedAt: null;
  data: Omit<EncounterInput, "source" | "collectionIntent"> & {
    source: {
      kind: "web" | "manual" | "clipboard";
      title: string;
      url: string | null;
    };
    timeZone: string;
    occurredAt: string;
    origin: { deviceId: string; clientKind: "desktop" | "browser" };
    collectionIntent: "collect" | "context-only";
  };
};
export type RecordEncounterResult = {
  captureStatus?: "created" | "duplicate-context";
  capturePolicy?: import("../capture-policy.ts").CapturePolicy;
  entity: EncounterRecord;
  workspaceRevision: string;
};
export type NotebookRecord = {
  entityType: "notebook";
  entityId: string;
  revision: string;
  deletedAt: string | null;
  data: { name: string; color: string; position: number };
};
export type PageResult<T> = {
  items: T[];
  nextCursor: string | null;
  complete: boolean;
  revision: string;
};
export type PublicEntryResult = {
  release: string;
  entry: Record<string, unknown>;
};
export type RemoteError = {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};
export type OperationResult =
  | { mutationId: string; status: "unknown" }
  | {
      mutationId: string;
      status: "pending";
      method: "recordEncounter" | "openInDesktop";
    }
  | {
      mutationId: string;
      status: "rejected";
      method: "recordEncounter" | "openInDesktop";
      error: RemoteError;
    }
  | {
      mutationId: string;
      status: "applied";
      method: "recordEncounter";
      result: RecordEncounterResult;
    }
  | {
      mutationId: string;
      status: "applied";
      method: "openInDesktop";
      result: { opened: boolean };
    };
export type HostGrant = {
  grantId: string;
  grantToken: string;
  expiresAt: string;
  capabilities: string[];
  owner: PairingOwner;
  extensionId: string;
};
export type HostRequest = {
  apiMajor: 1;
  kind: "host-request";
  connectionId: string;
  requestId: string;
  invocationId: string;
  method: string;
  grantId: string;
  grantToken: string;
  workspace: { workspaceId: string; generation: string };
  deadlineAt: string;
  params: Record<string, unknown>;
};
export type RequestFrame = {
  apiMajor: 1;
  requestId: string;
  connectionId: string;
  method: string;
  params: unknown;
  authorization?: Authorization;
};
export type ResponseFrame = {
  apiVersion: string;
  requestId: string;
  connectionId: string;
  method: string;
} & ({ ok: true; result: unknown } | { ok: false; error: RemoteError });
export type HostResponse = Omit<
  HostRequest,
  "grantId" | "grantToken" | "workspace" | "deadlineAt" | "params" | "kind"
> & { kind: "host-response" } & (
    | { ok: true; result: unknown }
    | { ok: false; error: RemoteError }
  );

export class LmcpError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  // 传输断开或超时不能解释为事务未提交；恢复时先查询原 mutationId。
  readonly resultUnknown: boolean;
  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number;
      resultUnknown?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "LmcpError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.resultUnknown = options.resultUnknown ?? false;
  }
}
export function ownerKey(owner: PairingOwner): string {
  return [
    owner.pairingId,
    owner.desktopInstanceId,
    owner.clientInstanceId,
    owner.workspaceId,
    owner.generation,
    owner.authorizationEpoch,
  ].join(":");
}
export function sameWord(a: WordRef, b: WordRef): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "dictionary" && b.kind === "dictionary"
      ? a.entryId === b.entryId &&
        a.release === b.release &&
        a.entrySchema === b.entrySchema
      : a.kind === "custom" && b.kind === "custom" && a.customId === b.customId)
  );
}
