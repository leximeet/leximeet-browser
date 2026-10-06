import { validCaptureReceipt } from "./capture-receipt.ts";
import {
  assertApiCompatibility,
  assertCaptureSemantics,
  assertFrame,
  assertHelloCompatibility,
  LMCP_CONTRACT,
  LMCP_HOST_METHODS,
  LMCP_METHODS,
  validValue,
} from "./protocol.ts";
import { NativeMessagingTransport } from "./transport.ts";
import type { LmcpTransport } from "./transport.ts";
import { LmcpError, ownerKey, sameWord } from "./types.ts";
import type {
  Authorization,
  ConnectionInvitation,
  ConnectionStatus,
  HelloResult,
  HostGrant,
  HostRequest,
  HostResponse,
  MatchResult,
  NotebookRecord,
  OperationResult,
  PageResult,
  PairingCredential,
  PairingOwner,
  PairResult,
  PublicEntryResult,
  RecordEncounterParams,
  RecordEncounterResult,
  SessionState,
  WordRef,
  WordSummary,
  WorkspaceResult,
} from "./types.ts";

const REQUIRED_SCOPES = ["library:read", "capture:write", "navigation:open"];
const WRITE_METHODS = new Set(["recordEncounter", "openInDesktop"]);
const BUSINESS_REJECTIONS = new Set([
  "INVALID_ARGUMENT",
  "INVALID_OCCURRENCE_RANGE",
  "INVALID_SOURCE_URL",
  "ENTITY_NOT_FOUND",
  "ENTITY_DELETED",
  "SENSITIVE_SELECTION",
  "RESOURCE_UNAVAILABLE",
  "IDEMPOTENCY_KEY_REUSED",
  "EVENT_ID_REUSED",
  "PAYLOAD_TOO_LARGE",
]);
/**
 * 只有明确的业务拒绝才能结束原采集意图。会话失效、限流、宿主故障和未知新错误
 * 都不能证明事务未提交；即使 error.retryable=false，也必须保留原 mutationId 查询回执。
 * 响应可扩展的 resultUnknown=true 优先于错误码，不能被业务分类覆盖。
 */
export function isDefinitiveWriteRejection(error: {
  code: string;
  retryable?: boolean;
  resultUnknown?: unknown;
}): boolean {
  return (
    error.resultUnknown !== true &&
    error.retryable !== true &&
    BUSINESS_REJECTIONS.has(error.code)
  );
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function authorization(value: Authorization): Authorization {
  // 响应允许增加可选字段；严格请求只发送合同授权字段，避免回传新的私人上下文。
  return {
    sessionId: value.sessionId,
    sessionToken: value.sessionToken,
    workspaceId: value.workspaceId,
    generation: value.generation,
    authorizationEpoch: value.authorizationEpoch,
  };
}
type HostHandler = (request: HostRequest, owner: PairingOwner) => Promise<unknown>;
export type LmcpClientOptions = {
  transport?: LmcpTransport;
  now?: () => number;
  onDisconnect?: (error: LmcpError) => void;
  clientInstanceId?: string;
  displayName?: string;
};

// 本机协议客户端不写个人事实、不保存凭据；后台模式控制层负责持久化和归属切换。
export class LmcpClient {
  private transport: LmcpTransport;
  private now: () => number;
  private helloState: HelloResult | null = null;
  private helloPending: Promise<HelloResult> | null = null;
  private sessionState: SessionState | null = null;
  private grant: HostGrant | null = null;
  private epoch = 0;
  private hostHandler: HostHandler | null = null;
  private clientInstanceId: string;
  private displayName: string;
  constructor(options: LmcpClientOptions = {}) {
    this.transport = options.transport ?? new NativeMessagingTransport();
    this.now = options.now ?? Date.now;
    this.clientInstanceId = options.clientInstanceId ?? crypto.randomUUID();
    this.displayName = options.displayName ?? "词遇浏览器";
    this.transport.onDisconnect = (error) => {
      this.epoch++;
      this.sessionState = null;
      this.helloState = null;
      this.helloPending = null;
      this.grant = null;
      options.onDisconnect?.(error);
    };
    this.transport.onHostRequest = (request) => this.handleHost(request);
  }
  get connectionId() {
    return this.transport.connectionId;
  }
  get session(): SessionState | null {
    return this.sessionState ? copy(this.sessionState) : null;
  }
  get capabilities(): readonly string[] {
    return this.helloState ? [...this.helloState.capabilities] : [];
  }
  get connected(): boolean {
    return Boolean(
      this.sessionState &&
        this.connectionId &&
        Date.parse(this.sessionState.expiresAt) > this.now(),
    );
  }
  async hello(): Promise<HelloResult> {
    if (this.helloState && this.connectionId) return copy(this.helloState);
    if (this.helloPending) return this.helloPending;
    const connectionId = this.transport.connect(),
      epoch = this.epoch;
    const pending = this.invoke<HelloResult>("hello", {
      apiMajor: LMCP_CONTRACT.apiMajor,
      minApiVersion: LMCP_CONTRACT.apiVersion,
      connectionId,
      clientKind: "browser",
      contractVersion: LMCP_CONTRACT.version,
      contractDigest: LMCP_CONTRACT.digest,
      requiredCapabilities: [...LMCP_CONTRACT.requiredCapabilities],
      clientInstanceId: this.clientInstanceId,
      displayName: this.displayName,
    })
      .then((hello) => {
        this.assertCurrent(connectionId, epoch);
        if (hello.connectionId !== connectionId)
          throw new LmcpError(
            "CONNECTION_MISMATCH",
            "Desktop 协商结果不属于当前原生通道",
          );
        assertHelloCompatibility(hello);
        this.transport.setMaxFrameBytes(hello.maxFrameBytes);
        this.helloState = copy(hello);
        return copy(hello);
      })
      .catch((error) => {
        if (this.connectionId === connectionId)
          this.close(
            error instanceof LmcpError
              ? error
              : new LmcpError("INVALID_FRAME", "Desktop 连接协商失败"),
          );
        throw error;
      })
      .finally(() => {
        if (this.helloPending === pending) this.helloPending = null;
      });
    this.helloPending = pending;
    return pending;
  }
  async pair(
    invitation: Pick<ConnectionInvitation, "invitationId" | "invitationToken">,
    clientInstanceId: string,
  ): Promise<PairResult> {
    await this.hello();
    const result = await this.invoke<PairResult>("pair", {
      invitationId: invitation.invitationId,
      invitationToken: invitation.invitationToken,
      clientInstanceId,
    });
    this.validateSession(result, {
      clientInstanceId,
      desktopInstanceId: this.helloState!.desktopInstanceId,
    });
    if (ownerKey(result.pairingCredential) !== ownerKey(result.owner))
      throw new LmcpError("OWNER_MISMATCH", "配对凭据与授权资料不一致");
    this.installSession(result);
    return copy(result);
  }
  async requestConnection(
    action: "request" | "cancel" = "request",
    invitationId?: string,
  ): Promise<ConnectionStatus> {
    await this.hello();
    const result = await this.invoke<ConnectionStatus>("requestConnection", {
      clientInstanceId: this.clientInstanceId,
      action,
      ...(action === "cancel" ? { invitationId } : {}),
    });
    this.validateControl(result);
    return copy(result);
  }
  async getConnectionStatus(
    pairingCredential?: PairingCredential,
    invitationId?: string,
  ): Promise<ConnectionStatus> {
    await this.hello();
    const result = await this.invoke<ConnectionStatus>("getConnectionStatus", {
      clientInstanceId: this.clientInstanceId,
      ...(pairingCredential ? { pairingCredential: copy(pairingCredential) } : {}),
      ...(invitationId ? { invitationId } : {}),
    });
    this.validateControl(result);
    return copy(result);
  }
  private validateControl(value: ConnectionStatus) {
    if (value.desktopInstanceId !== this.helloState?.desktopInstanceId)
      throw new LmcpError("OWNER_MISMATCH", "桌面控制状态来自其他实例");
  }
  async resume(credential: PairingCredential): Promise<SessionState> {
    if (!validValue("PairingCredential", credential))
      throw new LmcpError("INVALID_CREDENTIAL", "本机配对凭据无效，请重新配对");
    credential = copy(credential);
    const hello = await this.hello();
    if (credential.desktopInstanceId !== hello.desktopInstanceId)
      throw new LmcpError("OWNER_MISMATCH", "当前 Desktop 与原配对不同，不自动改投采集");
    const result = await this.invoke<SessionState>("resumeSession", copy(credential));
    this.validateSession(result, credential);
    this.installSession(result);
    return copy(result);
  }
  async renew(): Promise<SessionState> {
    const expected = this.requireSession();
    const result = await this.request<SessionState>("renewSession", {});
    this.validateSession(result, expected.owner);
    this.sessionState = copy(result);
    return copy(result);
  }
  // 不自动重试任何业务写入；调用方持久保留 mutationId，通过 getOperation 恢复。
  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const session = this.requireSession(),
      spec = LMCP_METHODS.find((item) => item.method === method);
    if (!spec || !spec.auth)
      throw new LmcpError("METHOD_UNAVAILABLE", "该方法不能通过已授权业务入口调用");
    if (
      !this.helloState?.methods.includes(method) ||
      !this.helloState.capabilities.includes(spec.capability)
    )
      throw new LmcpError("CAPABILITY_UNAVAILABLE", "Desktop 未启用该功能");
    if (spec.scope && !session.scopes.includes(spec.scope))
      throw new LmcpError("FORBIDDEN", "当前配对未授权该功能");
    const expectedOwner = ownerKey(session.owner),
      result = await this.invoke<T>(method, params, authorization(session.authorization));
    if (!this.sessionState || ownerKey(this.sessionState.owner) !== expectedOwner)
      throw new LmcpError("OWNER_MISMATCH", "资料归属已变化，旧响应已隔离");
    return result;
  }
  async getWorkspace(): Promise<WorkspaceResult> {
    const result = await this.request<WorkspaceResult>("getWorkspace");
    if (ownerKey(result.owner) !== ownerKey(this.requireSession().owner))
      throw new LmcpError("OWNER_MISMATCH", "Desktop 工作区与当前配对不一致");
    this.validateLease(result.readLeaseUntil, this.requireSession().expiresAt);
    this.sessionState!.readLeaseUntil = result.readLeaseUntil;
    return result;
  }
  async matchWords(
    params: { kind: "tokens"; tokens: string[] } | { kind: "ids"; words: WordRef[] },
  ): Promise<MatchResult> {
    params = copy(params);
    const result = await this.request<MatchResult>("matchWords", params);
    const count = params.kind === "tokens" ? params.tokens.length : params.words.length;
    const indexes = new Set(result.results.map((item) => item.inputIndex));
    if (
      result.results.length !== count ||
      indexes.size !== count ||
      result.results.some((item) => item.inputIndex >= count)
    )
      throw new LmcpError("INVALID_RESPONSE", "Desktop 词条匹配未完整对应输入");
    if (
      params.kind === "ids" &&
      result.results.some((item) =>
        item.matches.some(
          (match) => !sameWord(match.word, params.words[item.inputIndex]!),
        ),
      )
    )
      throw new LmcpError("WORD_MISMATCH", "Desktop 词条匹配身份与请求不一致");
    return result;
  }
  async getWord(word: WordRef): Promise<WordSummary> {
    word = copy(word);
    const result = await this.request<WordSummary>("getWord", { word });
    if (!sameWord(word, result.word))
      throw new LmcpError("WORD_MISMATCH", "Desktop 返回了其他词条的私人摘要");
    return result;
  }
  async getPublicEntry(
    word: Extract<WordRef, { kind: "dictionary" }>,
  ): Promise<PublicEntryResult> {
    word = copy(word);
    const result = await this.request<PublicEntryResult>("getPublicEntry", {
      entryId: word.entryId,
      release: word.release,
    });
    if (result.release !== word.release || result.entry.entry_id !== word.entryId)
      throw new LmcpError("WORD_MISMATCH", "Desktop 公共词条身份与请求不一致");
    return result;
  }
  async recordEncounter(params: RecordEncounterParams): Promise<RecordEncounterResult> {
    params = copy(params);
    const result = await this.request<RecordEncounterResult>("recordEncounter", params);
    if (!validCaptureReceipt(params, result))
      throw new LmcpError("RECEIPT_MISMATCH", "Desktop 采集回执与原事件不一致", {
        resultUnknown: true,
      });
    return result;
  }
  async getOperation(mutationId: string): Promise<OperationResult> {
    const result = await this.request<OperationResult>("getOperation", {
      mutationId,
    });
    if (result.mutationId !== mutationId)
      throw new LmcpError("RECEIPT_MISMATCH", "Desktop 返回了其他操作的回执", {
        resultUnknown: true,
      });
    return result;
  }
  async getChanges(
    sinceRevision: string,
  ): Promise<{ revision: string; changed: boolean; readLeaseUntil: string }> {
    const result = await this.request<{
      revision: string;
      changed: boolean;
      readLeaseUntil: string;
    }>("getChanges", { sinceRevision });
    this.validateLease(result.readLeaseUntil, this.requireSession().expiresAt);
    this.sessionState!.readLeaseUntil = result.readLeaseUntil;
    return result;
  }
  listNotebooks(
    params: { cursor?: string | null; limit?: number } = {},
  ): Promise<PageResult<NotebookRecord>> {
    return this.request("listNotebooks", params);
  }
  listEncounters(
    word: WordRef,
    params: {
      cursor?: string | null;
      limit?: number;
      from?: string;
      to?: string;
    } = {},
  ): Promise<PageResult<RecordEncounterResult["entity"]>> {
    return this.request("listEncounters", { ...params, word });
  }
  openInDesktop(
    target: "library" | "plan" | "settings" | "word",
    mutationId: string,
    word?: WordRef,
  ): Promise<{ opened: boolean }> {
    return this.request(
      "openInDesktop",
      target === "word" ? { target, mutationId, word } : { target, mutationId },
    );
  }
  // 登记前由后台完成模式切换和用户授权；不能为尚未实现的反向能力领取 grant。
  async registerHost(capabilities: string[]): Promise<HostGrant> {
    if (
      !this.hostHandler ||
      !capabilities.length ||
      capabilities.length > 5 ||
      capabilities.some(
        (capability) =>
          !LMCP_HOST_METHODS.some((method) => method.capability === capability),
      )
    )
      throw new LmcpError("CAPABILITY_UNAVAILABLE", "插件未实现或未授权这些宿主能力");
    const result = await this.request<HostGrant>("registerHost", {
      extensionId: "browser/1",
      capabilities,
    });
    if (
      result.extensionId !== "browser/1" ||
      ownerKey(result.owner) !== ownerKey(this.requireSession().owner) ||
      result.capabilities.some((capability) => !capabilities.includes(capability)) ||
      capabilities.some((capability) => !result.capabilities.includes(capability)) ||
      Date.parse(result.expiresAt) <= this.now() ||
      Date.parse(result.expiresAt) > this.now() + 600_000
    )
      throw new LmcpError("INVALID_GRANT", "Desktop 宿主授权身份或期限无效");
    this.grant = copy(result);
    return copy(result);
  }
  // handler 必须实现原 owner 的 invocation 回执恢复和页面权限复核；客户端只管通道授权。
  setHostHandler(handler: HostHandler | null): void {
    this.hostHandler = handler;
    if (!handler) this.grant = null;
  }
  async disconnect(): Promise<{ confirmed: boolean }> {
    let confirmed = false;
    try {
      await this.request("disconnect");
      confirmed = true;
    } catch (error) {
      if (
        !(error instanceof LmcpError) ||
        ![
          "DISCONNECTED",
          "TIMEOUT",
          "DESKTOP_NOT_RUNNING",
          "SESSION_EXPIRED",
          "UNAUTHORIZED",
          "FORBIDDEN",
        ].includes(error.code)
      )
        throw error;
    } finally {
      this.close();
    }
    return { confirmed };
  }
  async revokePairing(): Promise<void> {
    const pairingId = this.requireSession().pairingId;
    try {
      await this.request("revokePairing", { pairingId });
    } finally {
      this.close();
    }
  }
  close(error?: LmcpError): void {
    this.epoch++;
    this.sessionState = null;
    this.helloState = null;
    this.helloPending = null;
    this.grant = null;
    this.transport.close(error);
  }
  private requireSession(): SessionState {
    if (!this.sessionState || !this.connectionId || !this.helloState)
      throw new LmcpError(
        "DISCONNECTED",
        "Desktop 尚未连接；连接模式不会自动写入独立资料",
        { retryable: true },
      );
    if (Date.parse(this.sessionState.expiresAt) <= this.now())
      throw new LmcpError("SESSION_EXPIRED", "Desktop 会话已到期，请重新连接", {
        retryable: true,
      });
    return this.sessionState;
  }
  private installSession(session: SessionState) {
    this.epoch++;
    this.sessionState = copy(session);
    this.grant = null;
  }
  private validateLease(readLeaseUntil: string, expiresAt: string) {
    const lease = Date.parse(readLeaseUntil),
      expiry = Date.parse(expiresAt);
    if (lease > expiry || lease > this.now() + 30_000)
      throw new LmcpError("INVALID_SESSION", "Desktop 只读缓存租期无效");
  }
  private validateSession(session: SessionState, expected: Partial<PairingOwner>) {
    const owner = session.owner,
      auth = session.authorization;
    if (
      Object.entries(expected).some(
        ([key, value]) =>
          key !== "pairingToken" && owner[key as keyof PairingOwner] !== value,
      ) ||
      session.pairingId !== owner.pairingId ||
      auth.workspaceId !== owner.workspaceId ||
      auth.generation !== owner.generation ||
      auth.authorizationEpoch !== owner.authorizationEpoch
    )
      throw new LmcpError("OWNER_MISMATCH", "Desktop 会话与原配对资料不一致");
    const expires = Date.parse(session.expiresAt);
    if (
      expires <= this.now() ||
      expires > this.now() + 86_400_000 ||
      REQUIRED_SCOPES.some((scope) => !session.scopes.includes(scope))
    )
      throw new LmcpError("INVALID_SESSION", "Desktop 会话期限或遇见采集授权不完整");
    this.validateLease(session.readLeaseUntil, session.expiresAt);
  }
  private assertCurrent(connectionId: string, epoch: number) {
    if (this.connectionId !== connectionId || this.epoch !== epoch)
      throw new LmcpError("CONNECTION_MISMATCH", "连接已变化，旧响应已隔离", {
        resultUnknown: true,
      });
  }
  private async invoke<T>(
    method: string,
    params: unknown,
    auth?: Authorization,
  ): Promise<T> {
    const connectionId = this.connectionId;
    if (!connectionId)
      throw new LmcpError("DISCONNECTED", "Desktop 原生通道未打开", {
        retryable: true,
      });
    const epoch = this.epoch;
    const frame = {
      apiMajor: 1 as const,
      requestId: crypto.randomUUID(),
      connectionId,
      method,
      params,
      ...(auth ? { authorization: auth } : {}),
    };
    assertFrame("Request", frame);
    if (method === "recordEncounter") assertCaptureSemantics(params);
    const response = await this.transport.request(copy(frame));
    this.assertCurrent(connectionId, epoch);
    assertFrame("Response", response);
    if (
      response.requestId !== frame.requestId ||
      response.connectionId !== connectionId ||
      response.method !== method
    )
      throw new LmcpError("INVALID_RESPONSE", "Desktop 回执版本或请求身份不一致", {
        resultUnknown: true,
      });
    if (method === "hello") {
      // 第一帧按本端最低版本协商；结果与信封必须一致，不能保存两个不同的服务身份。
      assertApiCompatibility(response.apiVersion);
      if (
        response.ok &&
        (response.result as HelloResult).apiVersion !== response.apiVersion
      )
        throw new LmcpError("INVALID_RESPONSE", "Desktop 协商结果与信封版本不一致", {
          resultUnknown: true,
        });
    } else if (response.apiVersion !== this.helloState?.apiVersion) {
      // 后续帧只能来自已经协商的版本，通道中途换版本不能被当作同一次会话。
      throw new LmcpError("INVALID_RESPONSE", "Desktop 回执不属于已协商的 API 版本", {
        resultUnknown: true,
      });
    }
    if (!response.ok) {
      // ErrorRead 允许增加可选字段；读取未知结果标记，不回写或放宽冻结请求合同。
      // Core 的发现记录可能随 Worker 挂起失效，下次控制读取须重新 hello。
      if (
        response.error.code === "STALE_CONNECTION" &&
        ["requestConnection", "getConnectionStatus"].includes(method)
      )
        this.helloState = null;
      const error = response.error as typeof response.error & {
        resultUnknown?: unknown;
      };
      throw new LmcpError(response.error.code, response.error.message, {
        retryable: response.error.retryable,
        retryAfterMs: response.error.retryAfterMs,
        resultUnknown:
          error.resultUnknown === true ||
          (WRITE_METHODS.has(method) && !isDefinitiveWriteRejection(error)),
      });
    }
    return copy(response.result) as T;
  }
  private async handleHost(request: HostRequest): Promise<HostResponse> {
    const session = this.requireSession(),
      grant = this.grant,
      connectionId = this.connectionId!,
      epoch = this.epoch;
    if (
      !grant ||
      !this.hostHandler ||
      request.grantId !== grant.grantId ||
      request.grantToken !== grant.grantToken ||
      grant.expiresAt <= new Date(this.now()).toISOString() ||
      ownerKey(grant.owner) !== ownerKey(session.owner) ||
      request.workspace.workspaceId !== session.owner.workspaceId ||
      request.workspace.generation !== session.owner.generation ||
      request.connectionId !== connectionId
    )
      throw new LmcpError("FORBIDDEN", "宿主调用不属于当前有效授权");
    const method = LMCP_HOST_METHODS.find((item) => item.method === request.method);
    if (!method || (method.capability && !grant.capabilities.includes(method.capability)))
      throw new LmcpError("CAPABILITY_UNAVAILABLE", "当前宿主授权不允许该操作");
    const deadline = Date.parse(request.deadlineAt);
    if (deadline <= this.now() || deadline > this.now() + 30_000)
      throw new LmcpError("DEADLINE_EXCEEDED", "宿主调用期限无效或已过期");
    const result = await this.hostHandler(copy(request), copy(session.owner));
    this.assertCurrent(connectionId, epoch);
    if (this.grant?.grantId !== grant.grantId)
      throw new LmcpError("FORBIDDEN", "宿主授权已经变化");
    return {
      kind: "host-response",
      apiMajor: 1,
      connectionId,
      requestId: request.requestId,
      invocationId: request.invocationId,
      method: request.method,
      ok: true,
      result,
    };
  }
}
