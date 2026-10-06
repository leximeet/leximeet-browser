import { validCaptureReceipt } from "./connector/capture-receipt.ts";
import { isDefinitiveWriteRejection, LmcpClient } from "./connector/client.ts";
import { LmcpError, ownerKey, sameWord } from "./connector/types.ts";
import type {
  PairingCredential,
  ConnectionInvitation,
  ConnectionStatus,
  RecordEncounterParams,
  RecordEncounterResult,
  WorkspaceResult,
} from "./connector/types.ts";

export type ConnectionView = {
  mode: "independent" | "desktop";
  status: "independent" | "connecting" | "connected" | "reconnecting" | "error";
  message: string;
  dictionaryEdition?: WorkspaceResult["dictionaryEdition"];
  account?: WorkspaceResult["account"];
  unknownOperations: number;
  disconnectUnconfirmed: boolean;
};
type Operation = {
  owner: string;
  params: RecordEncounterParams;
  status: "unknown" | "applied" | "rejected";
  result?: RecordEncounterResult;
};
export type ConnectionRecord = {
  format: "leximeet.connection/2";
  clientInstanceId: string;
  desired: "independent" | "desktop";
  credential: PairingCredential | null;
  archiveId: string | null;
  operations: Operation[];
  disconnectUnconfirmed: boolean;
  pendingPair: PendingPair | null;
};
export type PendingPair = ConnectionInvitation & {
  desktopInstanceId: string;
  displayName: string;
};
export interface ConnectionStore {
  load(): Promise<ConnectionRecord | null>;
  save(record: ConnectionRecord): Promise<void>;
}
export interface IndependentOwnership {
  freezeIndependent(): Promise<{ archiveId: string | null }>;
  resumeIndependent(archiveId: string): Promise<unknown>;
}
const clone = <T>(value: T): T => structuredClone(value);
// 当前 wire 载荷是 JSON 值；递归按键序比较，避免对象字段顺序改变幂等意图。
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function newRecord(): ConnectionRecord {
  return {
    format: "leximeet.connection/2",
    clientInstanceId: crypto.randomUUID(),
    desired: "independent",
    credential: null,
    archiveId: null,
    operations: [],
    disconnectUnconfirmed: false,
    pendingPair: null,
  };
}
// 连接凭据属于扩展源的独立控制库；不放入 storage.local、网页消息或原独立业务资料。
export class IndexedConnectionStore implements ConnectionStore {
  private database?: Promise<IDBDatabase>;
  private name: string;
  constructor(name = "leximeet-connection-v2") {
    this.name = name;
  }
  private db() {
    return (this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("control");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }
  async load(): Promise<ConnectionRecord | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction("control").objectStore("control").get("connection");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }
  async save(value: ConnectionRecord): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("control", "readwrite");
      tx.objectStore("control").put(clone(value), "connection");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("无法保存本机连接状态"));
    });
  }
}

// 数据归属只有显式连接/断开可改变。断线和任何超时都不能自动切回独立库。
export class DesktopConnection {
  private record = newRecord();
  private client: LmcpClient | null = null;
  private workspace: WorkspaceResult | null = null;
  private status: ConnectionView["status"] = "independent";
  private message = "";
  private epoch = 0;
  private initialized?: Promise<void>;
  private transition?: Promise<void>;
  private reconnecting?: Promise<void>;
  private renewing?: Promise<void>;
  private workspaceRefresh?: {
    client: LmcpClient;
    epoch: number;
    ticket: string;
    promise: Promise<void>;
  };
  private nextReconnectAt = 0;
  private saving: Promise<void> = Promise.resolve();
  private inFlight = new Map<
    string,
    { payload: string; promise: Promise<RecordEncounterResult> }
  >();
  private options: {
    store: ConnectionStore;
    library: IndependentOwnership;
    createClient?: (onDisconnect: (error: LmcpError) => void) => LmcpClient;
    changed?: () => void | Promise<void>;
  };
  constructor(options: DesktopConnection["options"]) {
    this.options = options;
  }
  private notify() {
    void this.options.changed?.();
  }
  private persist(
    patch: Partial<ConnectionRecord> = {},
    check?: () => void,
  ): Promise<void> {
    const staged = clone(patch);
    // 失败仍返回当前调用方；下一次写入可重新执行，不能永久卡在 rejected 队列。
    const attempt = this.saving
      .catch(() => {})
      .then(async () => {
        // 排队执行时读取最新账本，避免切换期间的迟到回执被旧快照覆盖。
        check?.();
        const value = clone({ ...this.record, ...staged });
        await this.options.store.save(value);
        // 归属字段只在事务真正完成后安装，存储失败不会误切到另一个资料来源。
        Object.assign(this.record, staged);
      });
    this.saving = attempt;
    return attempt;
  }
  async ready(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      const saved = await this.options.store.load();
      if (saved) {
        if (
          saved.format !== "leximeet.connection/2" ||
          !["desktop", "independent"].includes(saved.desired) ||
          !Array.isArray(saved.operations) ||
          !(
            saved.pendingPair === null ||
            (saved.pendingPair && typeof saved.pendingPair.invitationToken === "string")
          )
        )
          throw new Error("连接归属记录无效，已停止切换资料");
        this.record = saved;
      } else await this.persist();
      if (this.record.desired === "desktop") {
        this.status = "reconnecting";
        const archive = await this.options.library.freezeIndependent();
        // 封存已经发生，内存须保留真实标识；控制库失败后仍能显式恢复。
        this.record.archiveId = archive.archiveId;
        await this.persist();
        void this.reconnect().catch(() => {});
      } else if (this.record.archiveId) {
        await this.options.library.resumeIndependent(this.record.archiveId);
        await this.persist({ archiveId: null });
      }
    })().catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }
  async view(): Promise<ConnectionView> {
    await this.ready();
    return {
      mode: this.record.desired,
      status: this.status,
      message: this.message,
      ...(this.workspace && this.readContext()
        ? {
            dictionaryEdition: this.workspace.dictionaryEdition,
            account: clone(this.workspace.account),
          }
        : {}),
      unknownOperations: this.record.operations.filter((op) => op.status === "unknown")
        .length,
      disconnectUnconfirmed: this.record.disconnectUnconfirmed,
    };
  }
  get connectedMode() {
    return this.record.desired === "desktop";
  }
  // 业务异步结果和页面草稿绑定归属，切换后旧结果只能进入原操作回执，不能投影到新模式。
  ticket(): string {
    return `${this.record.desired}:${this.record.desired === "desktop" && this.record.credential ? ownerKey(this.record.credential) : this.record.clientInstanceId}`;
  }
  assertTicket(ticket: string) {
    if (ticket !== this.ticket()) throw new Error("资料归属已变化，请重新开始网页操作");
  }
  // 供后台投影读取租期与修订；不返回凭据或原 owner 的私人上下文。
  readContext(): { revision: string; readLeaseUntil: string } | null {
    const session = this.client?.session;
    if (
      this.transition ||
      this.status !== "connected" ||
      !this.connectedMode ||
      !this.client?.connected ||
      !session ||
      !this.workspace ||
      Date.parse(session.expiresAt) <= Date.now() ||
      Date.parse(session.readLeaseUntil) <= Date.now()
    )
      return null;
    return {
      revision: this.workspace.revision,
      readLeaseUntil: session.readLeaseUntil,
    };
  }
  private unavailable(message: string) {
    const changed =
      this.status !== "reconnecting" ||
      this.workspace !== null ||
      this.message !== message;
    this.status = "reconnecting";
    this.workspace = null;
    this.message = message;
    if (changed) this.notify();
  }
  private makeClient() {
    const epoch = this.epoch;
    let client: LmcpClient;
    const disconnected = () => {
      if (epoch !== this.epoch || this.client !== client || !this.connectedMode) return;
      this.unavailable("桌面暂时不可用；采集暂停，独立资料仍封存。");
    };
    client =
      this.options.createClient?.(disconnected) ??
      new LmcpClient({
        onDisconnect: disconnected,
        clientInstanceId: this.record.clientInstanceId,
      });
    return client;
  }
  // 安全探测使用同一安装身份，不读取 A，也不取得业务会话。
  async createControlClient(): Promise<LmcpClient> {
    await this.ready();
    return this.makeClient();
  }
  async queryControl(
    client: LmcpClient,
    invitationId?: string,
  ): Promise<ConnectionStatus> {
    await this.ready();
    const hello = await client.hello();
    if (
      this.connectedMode &&
      this.record.credential &&
      hello.desktopInstanceId !== this.record.credential.desktopInstanceId
    )
      throw new LmcpError("OWNER_MISMATCH", "当前桌面不是原资料归属，独立资料仍封存");
    return client.getConnectionStatus(
      this.connectedMode ? (this.record.credential ?? undefined) : undefined,
      invitationId ?? this.record.pendingPair?.invitationId,
    );
  }
  // 只在可信控制状态明确证明 Desktop 主动断开后恢复 A；失联或 revoked 不触发。
  async acceptDesktopDisconnect(status: ConnectionStatus): Promise<boolean> {
    await this.ready();
    if (
      !this.connectedMode ||
      !this.record.credential ||
      status.connectionState !== "disconnected" ||
      status.desktopInstanceId !== this.record.credential.desktopInstanceId
    )
      return false;
    await this.disconnect(true);
    return true;
  }
  async connect(invitation: PendingPair): Promise<void> {
    await this.ready();
    if (this.transition) throw new Error("连接切换正在进行");
    if (this.connectedMode) throw new Error("请先断开当前桌面连接");
    if (
      !invitation?.invitationId ||
      !invitation.invitationToken ||
      !invitation.desktopInstanceId
    )
      throw new Error("连接邀请已失效，请重新发起");
    this.transition = (async () => {
      this.epoch++;
      this.status = "connecting";
      this.message = "";
      this.notify();
      const client = this.makeClient();
      this.client = client;
      try {
        // 真实用户确认后先记意图并封存 A。未知 pair 必须沿用同一秘密票据恢复。
        await this.persist({
          desired: "desktop",
          pendingPair: clone(invitation),
          credential: null,
          disconnectUnconfirmed: false,
        });
        const archive = await this.options.library.freezeIndependent();
        this.record.archiveId = archive.archiveId;
        await this.persist();
        await this.completePair(client, this.epoch);
        this.status = "connected";
        this.message = "";
      } catch (error) {
        if (
          this.record.pendingPair &&
          error instanceof LmcpError &&
          ["INVITATION_CANCELLED", "INVITATION_EXPIRED", "CONNECTION_ENDED"].includes(
            error.code,
          )
        ) {
          // Core 明确未接受邀请才可解除准备状态；网络错误不得恢复本地写入。
          await this.persist({ desired: "independent", pendingPair: null });
          if (this.record.archiveId)
            await this.options.library.resumeIndependent(this.record.archiveId);
          await this.persist({ archiveId: null });
          client.close();
          this.client = null;
          this.status = "independent";
          this.message = "连接邀请已结束，已恢复独立使用。";
        } else if (this.connectedMode) {
          client.close();
          this.workspace = null;
          this.status = "reconnecting";
          this.message = this.record.pendingPair
            ? "连接结果尚未确认，独立资料已封存；正在查证原邀请。"
            : "已切换到桌面资料，等待恢复连接。";
        } else {
          this.status = "independent";
          this.message = "未能连接，请检查桌面已启动、本机通道已注册，再重新发起邀请。";
          client.close();
          this.client = null;
        }
        throw new Error(this.message);
      } finally {
        this.notify();
      }
    })();
    try {
      await this.transition;
    } finally {
      this.transition = undefined;
    }
  }
  private async completePair(client: LmcpClient, epoch: number) {
    const invitation = this.record.pendingPair;
    if (!invitation) throw new Error("原连接邀请缺失");
    const hello = await client.hello();
    if (hello.desktopInstanceId !== invitation.desktopInstanceId)
      throw new LmcpError("OWNER_MISMATCH", "原邀请属于另一桌面，不能静默改投资料");
    const result = await client.pair(invitation, this.record.clientInstanceId);
    const check = () => {
      if (epoch !== this.epoch || !this.connectedMode || this.client !== client)
        throw new Error("原连接已结束");
    };
    check();
    await this.persist(
      { credential: result.pairingCredential, pendingPair: null },
      check,
    );
    const workspace = await client.getWorkspace();
    check();
    this.workspace = workspace;
  }
  async reconnect(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    if (!this.connectedMode) return;
    if (this.transition) throw new Error("连接切换正在进行");
    if (Date.now() < this.nextReconnectAt)
      throw new Error(this.message || "桌面连接正在恢复，请稍后重试");
    this.reconnecting = (async () => {
      if (!this.record.credential && !this.record.pendingPair)
        throw new Error("原配对凭据缺失；请显式断开后重新配对");
      const epoch = this.epoch;
      this.client?.close();
      const client = this.makeClient();
      this.client = client;
      try {
        // 先完成可能被中断的封存，再向同 owner 恢复；绝不开放另一份独立资料。
        if (!this.record.archiveId) {
          const archive = await this.options.library.freezeIndependent();
          if (epoch !== this.epoch || !this.connectedMode) throw new Error("连接已切换");
          this.record.archiveId = archive.archiveId;
        }
        await this.persist();
        if (this.record.pendingPair) await this.completePair(client, epoch);
        else await client.resume(this.record.credential!);
        const workspace = await client.getWorkspace();
        if (epoch !== this.epoch || !this.connectedMode || this.client !== client)
          throw new Error("连接已切换");
        this.workspace = workspace;
        this.status = "connected";
        this.message = "";
        this.nextReconnectAt = 0;
        this.notify();
      } catch (error) {
        client.close();
        if (epoch !== this.epoch || !this.connectedMode || this.client !== client)
          throw new Error("原连接已结束");
        if (
          this.record.pendingPair &&
          error instanceof LmcpError &&
          ["INVITATION_CANCELLED", "INVITATION_EXPIRED", "CONNECTION_ENDED"].includes(
            error.code,
          )
        ) {
          await this.persist({ desired: "independent", pendingPair: null });
          if (this.record.archiveId)
            await this.options.library.resumeIndependent(this.record.archiveId);
          await this.persist({ archiveId: null });
          this.workspace = null;
          this.client = null;
          this.status = "independent";
          this.message = "原邀请已明确结束，已恢复独立使用。";
          this.notify();
          return;
        }
        this.nextReconnectAt = Date.now() + 2000;
        this.unavailable("桌面暂时不可用；采集暂停，独立资料仍封存。");
        throw new Error(this.message);
      }
    })();
    try {
      await this.reconnecting;
    } finally {
      this.reconnecting = undefined;
    }
  }
  private assertCurrent(client: LmcpClient, epoch: number, ticket: string) {
    this.assertTicket(ticket);
    if (
      this.transition ||
      epoch !== this.epoch ||
      this.client !== client ||
      !this.connectedMode ||
      !client.connected ||
      this.status !== "connected"
    )
      throw new Error("连接已切换");
  }
  // 读取租期续期只取工作区，不频繁换会话；同一 owner 的并发请求共用一次读取。
  private async refreshWorkspace(
    client: LmcpClient,
    epoch: number,
    ticket: string,
  ): Promise<void> {
    const current = this.workspaceRefresh;
    if (
      current?.client === client &&
      current.epoch === epoch &&
      current.ticket === ticket
    )
      return current.promise;
    const refresh = {
      client,
      epoch,
      ticket,
      promise: Promise.resolve(),
    };
    refresh.promise = (async () => {
      const workspace = await client.getWorkspace();
      this.assertCurrent(client, epoch, ticket);
      if (
        !client.session ||
        Date.parse(client.session.expiresAt) <= Date.now() ||
        Date.parse(client.session.readLeaseUntil) <= Date.now()
      )
        throw new Error("桌面读取租期未恢复，已停止使用缓存资料");
      // 在途旧响应不得覆盖另一份较新的工作区修订及元数据。
      if (this.workspace && BigInt(workspace.revision) < BigInt(this.workspace.revision))
        return;
      // 仅租期续期不广播业务状态，避免侧栏轮询触发新的轮询。
      const changed =
        canonical({ ...this.workspace, readLeaseUntil: null }) !==
        canonical({ ...workspace, readLeaseUntil: null });
      this.workspace = clone(workspace);
      if (changed) this.notify();
    })();
    this.workspaceRefresh = refresh;
    try {
      await refresh.promise;
    } finally {
      if (this.workspaceRefresh === refresh) this.workspaceRefresh = undefined;
    }
  }
  async active(): Promise<LmcpClient> {
    await this.ready();
    if (this.transition) throw new Error("连接切换正在进行");
    if (!this.connectedMode) throw new Error("当前是浏览器独立模式");
    if (!this.client?.connected || this.status !== "connected") await this.reconnect();
    const client = this.client,
      epoch = this.epoch,
      ticket = this.ticket();
    if (!client?.connected || this.status !== "connected")
      throw new Error("桌面连接未恢复，无法读写桌面资料");
    try {
      if (Date.parse(client.session!.expiresAt) - Date.now() < 60_000) {
        if (!this.renewing) {
          const renewal = client.renew().then(() => {});
          this.renewing = renewal;
          void renewal
            .finally(() => {
              if (this.renewing === renewal) this.renewing = undefined;
            })
            .catch(() => {});
        }
        await this.renewing;
      }
      this.assertCurrent(client, epoch, ticket);
      const refresh = this.workspaceRefresh;
      if (
        (refresh?.client === client &&
          refresh.epoch === epoch &&
          refresh.ticket === ticket) ||
        Date.parse(client.session!.readLeaseUntil) - Date.now() < 5_000
      )
        await this.refreshWorkspace(client, epoch, ticket);
      this.assertCurrent(client, epoch, ticket);
      return client;
    } catch (error) {
      if (epoch === this.epoch && this.client === client && this.connectedMode) {
        client.close();
        this.nextReconnectAt = Date.now() + 2000;
        this.unavailable("桌面暂时不可用；采集暂停，独立资料仍封存。");
      }
      throw error;
    }
  }
  async heartbeat(): Promise<void> {
    await this.ready();
    if (!this.connectedMode || this.transition) return;
    const ticket = this.ticket(),
      epoch = this.epoch;
    let client: LmcpClient | null = null;
    try {
      client = await this.active();
      const changed = await client.getChanges(this.workspace!.revision);
      this.assertCurrent(client, epoch, ticket);
      if (!this.workspace) throw new Error("桌面工作区不可用");
      if (changed.changed) {
        // 修订变化也可能包含词库、账号与连接信息，必须重取完整工作区。
        await this.refreshWorkspace(client, epoch, ticket);
        this.assertCurrent(client, epoch, ticket);
        if (
          this.workspace &&
          BigInt(this.workspace.revision) < BigInt(changed.revision)
        ) {
          // 共用的在途读取可能早于本次变更；明确再取一次，仍不能使用旧修订。
          await this.refreshWorkspace(client, epoch, ticket);
          this.assertCurrent(client, epoch, ticket);
        }
        if (!this.workspace || BigInt(this.workspace.revision) < BigInt(changed.revision))
          throw new Error("桌面工作区修订尚未刷新，已停止使用旧资料");
      } else if (BigInt(changed.revision) >= BigInt(this.workspace.revision)) {
        this.workspace.revision = changed.revision;
        this.workspace.readLeaseUntil = changed.readLeaseUntil;
      }
    } catch (error) {
      if (
        epoch === this.epoch &&
        ticket === this.ticket() &&
        this.connectedMode &&
        (!client || this.client === client)
      ) {
        this.client?.close();
        this.nextReconnectAt = Date.now() + 2000;
        this.unavailable("桌面暂时不可用；采集暂停，独立资料仍封存。");
      }
      throw error;
    }
  }
  async disconnect(confirmedByDesktop = false): Promise<void> {
    await this.ready();
    if (this.transition) throw new Error("连接切换正在进行");
    if (!this.connectedMode && !this.record.archiveId) return;
    this.transition = (async () => {
      this.epoch++;
      let confirmed = !this.record.disconnectUnconfirmed,
        resumed = !this.record.archiveId;
      if (this.connectedMode) {
        confirmed = confirmedByDesktop;
        try {
          if (!confirmedByDesktop)
            confirmed = (await this.client?.disconnect())?.confirmed ?? false;
          else this.client?.close();
        } catch {
          this.client?.close();
        }
      }
      this.client = null;
      this.workspace = null;
      this.renewing = undefined;
      this.workspaceRefresh = undefined;
      this.nextReconnectAt = 0;
      try {
        // 断开意图先落盘；失败时仍保留 Desktop 归属及封存，不提前呈现独立 A。
        await this.persist({
          desired: "independent",
          pendingPair: null,
          disconnectUnconfirmed: !confirmed,
        });
        if (this.record.archiveId) {
          await this.options.library.resumeIndependent(this.record.archiveId);
          resumed = true;
        }
        await this.persist({ archiveId: null });
        this.status = "independent";
        this.message = confirmed ? "" : "已恢复独立使用；桌面断开回执尚未确认。";
        this.notify();
      } catch (error) {
        if (this.connectedMode)
          this.unavailable("断开意图尚未保存；独立资料仍封存，请重试断开。");
        else {
          this.status = "error";
          this.message = resumed
            ? "独立资料已恢复，本机连接记录尚未完成，请重试断开。"
            : "已选择独立使用，资料恢复尚未完成，请重试断开。";
          this.notify();
        }
        throw error;
      }
    })();
    try {
      await this.transition;
    } finally {
      this.transition = undefined;
    }
  }
  // 先落盘原 mutationId，再调用。未知结果先查询，不能换 ID 重发或保存到本地。
  captureSubmitted(eventId: string, ticket: string): boolean {
    this.assertTicket(ticket);
    return this.record.operations.some((op) => op.params.eventId === eventId);
  }
  async capture(
    params: RecordEncounterParams,
    ticket: string,
  ): Promise<RecordEncounterResult> {
    this.assertTicket(ticket);
    params = clone(params); // 提交意图冻结，调用方之后编辑草稿不能改写在途请求。
    const key = `${ticket}:${params.mutationId}`,
      payload = canonical(params);
    const running = this.inFlight.get(key);
    if (running) {
      if (running.payload !== payload)
        throw new Error("原采集正在提交，不能复用同一事件修改内容");
      return running.promise;
    }
    const operation = this.captureOnce(params, ticket);
    this.inFlight.set(key, { payload, promise: operation });
    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }
  private async captureOnce(
    params: RecordEncounterParams,
    ticket: string,
  ): Promise<RecordEncounterResult> {
    const client = await this.active();
    this.assertTicket(ticket);
    const owner = ownerKey(this.record.credential!);
    let op = this.record.operations.find(
      (value) => value.owner === owner && value.params.mutationId === params.mutationId,
    );
    if (op && canonical(op.params) !== canonical(params))
      throw new Error("原采集已提交，不能更改内容后复用事件");
    if (op?.status === "applied") {
      await this.persist();
      this.assertTicket(ticket);
      return clone(op.result!);
    }
    if (op?.status === "rejected") {
      await this.persist();
      throw new Error("桌面已拒绝这次采集，请重新选择单词");
    }
    if (op) {
      const receipt = await client.getOperation(params.mutationId);
      this.assertTicket(ticket);
      if (receipt.status === "applied" && receipt.method === "recordEncounter") {
        if (!validCaptureReceipt(params, receipt.result))
          throw new Error("采集回执身份或内容不一致");
        op.status = "applied";
        op.result = receipt.result;
        await this.persist();
        this.assertTicket(ticket);
        return clone(receipt.result);
      }
      if (receipt.status !== "unknown" && receipt.method !== "recordEncounter")
        throw new Error("原操作回执方法不一致");
      if (receipt.status === "rejected") {
        op.status = "rejected";
        await this.persist();
        throw new Error("桌面已拒绝这次采集");
      }
      if (receipt.status === "pending") throw new Error("这次采集仍在处理，请稍后查询");
      // unknown 不换意图；用户重试只发送完全相同的原载荷/原 mutationId。
    }
    if (
      !op &&
      this.record.operations.filter((value) => value.status === "unknown").length >= 512
    )
      throw new Error("待确认采集过多，请先恢复桌面连接");
    if (!op) {
      op = { owner, params: clone(params), status: "unknown" };
      this.record.operations.push(op);
    }
    // 原 unknown 也可能来自上次失败的落盘，所有实际发送都重新确认意图已持久化。
    await this.persist();
    try {
      this.assertTicket(ticket);
      const result = await client.recordEncounter(params);
      op.status = "applied";
      op.result = result;
      await this.persist();
      this.assertTicket(ticket);
      this.notify();
      return clone(result);
    } catch (error) {
      if (error instanceof LmcpError && isDefinitiveWriteRejection(error)) {
        op.status = "rejected";
        await this.persist();
      }
      throw new Error(
        op.status === "rejected"
          ? "桌面未接受本次采集，请检查词条和词本后重试"
          : "采集结果尚未确认，已保留原事件；不会另存到浏览器",
      );
    }
  }
}
