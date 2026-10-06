import type { LmcpClient } from "./connector/client.ts";
import type { ConnectionStatus } from "./connector/types.ts";
import { LmcpError } from "./connector/types.ts";
import type { ConnectionView, PendingPair } from "./desktop-connection.ts";

// 此视图可进 UI；秘密票据始终只在后台，绝不放 URL、通知或 storage.local。
export type DiscoveryView = {
  available: boolean;
  desktop: { desktopInstanceId: string; displayName: string } | null;
  invitation: {
    invitationId: string;
    requestedBy: "desktop" | "plugin";
    expiresAt: string;
  } | null;
  notification: "enabled" | "denied" | "unavailable";
  message: string;
  connection: ConnectionView;
};
export type DiscoveryMemory = {
  notifiedKey: string;
  suppressedDesktop: string;
  lastDesktopId: string;
  generation: number;
  wasAvailable: boolean;
};
export interface DiscoveryStore {
  load(): Promise<DiscoveryMemory | null>;
  save(value: DiscoveryMemory): Promise<void>;
}
// 只保存通知去重元数据，没有原独立资料、邀请令牌或配对凭据。
export class IndexedDiscoveryStore implements DiscoveryStore {
  private db?: Promise<IDBDatabase>;
  private database() {
    return (this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("leximeet-discovery-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("metadata");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }
  async load(): Promise<DiscoveryMemory | null> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction("metadata")
        .objectStore("metadata")
        .get("notifications");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }
  async save(value: DiscoveryMemory) {
    const db = await this.database();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("metadata", "readwrite");
      tx.objectStore("metadata").put(structuredClone(value), "notifications");
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
}
type Ports = {
  store: DiscoveryStore;
  createClient(): Promise<LmcpClient>;
  query(client: LmcpClient, invitationId?: string): Promise<ConnectionStatus>;
  connection(): Promise<ConnectionView>;
  confirm(invitation: PendingPair): Promise<void>;
  desktopDisconnected(status: ConnectionStatus): Promise<void>;
  notify(displayName: string): Promise<DiscoveryView["notification"]>;
  showConfirmation(): Promise<void>;
  changed(): void;
  startupPause?(milliseconds: number): Promise<void>;
};
// 安全控制面：纯发现不读工作区、不拉起 Desktop、不配对。真实用户确认后才委托归属切换。
export class DesktopDiscovery {
  private client: LmcpClient | null = null;
  private status: ConnectionStatus | null = null;
  private notification: DiscoveryView["notification"] = "unavailable";
  private message = "";
  private memory: DiscoveryMemory = {
    notifiedKey: "",
    suppressedDesktop: "",
    lastDesktopId: "",
    generation: 0,
    wasAvailable: false,
  };
  private initialized?: Promise<void>;
  private started?: Promise<void>;
  private polling?: Promise<void>;
  private failureCode: string | null = null;
  private confirming = false;
  private shownInvitation = "";
  private ports: Ports;
  constructor(ports: Ports) {
    this.ports = ports;
  }
  private ready() {
    return (this.initialized ??= this.ports.store.load().then((value) => {
      if (value) this.memory = value;
    }));
  }
  async view(): Promise<DiscoveryView> {
    await this.ready();
    const value = this.status;
    return {
      available: value !== null,
      desktop: value
        ? {
            desktopInstanceId: value.desktopInstanceId,
            displayName: value.displayName,
          }
        : null,
      invitation: value?.invitation
        ? {
            invitationId: value.invitation.invitationId,
            requestedBy: value.invitation.requestedBy,
            expiresAt: value.invitation.expiresAt,
          }
        : null,
      notification: this.notification,
      message: this.message,
      connection: await this.ports.connection(),
    };
  }
  private async install(value: ConnectionStatus) {
    this.failureCode = null;
    this.status = value;
    this.message = "";
    if (!this.memory.wasAvailable) this.memory.generation++;
    this.memory.wasAvailable = true;
    this.memory.lastDesktopId = value.desktopInstanceId;
    const connection = await this.ports.connection();
    if (connection.mode === "desktop" && value.connectionState === "disconnected") {
      await this.suppress();
      await this.ports.desktopDisconnected(value);
    }
    const key = `${value.desktopInstanceId}:${this.memory.generation}`;
    if (
      connection.mode === "independent" &&
      this.memory.suppressedDesktop !== value.desktopInstanceId &&
      this.memory.notifiedKey !== key
    ) {
      // 去重先落盘；权限被拒也不刷屏，设置仍提供真实可连接状态。
      this.memory.notifiedKey = key;
      await this.ports.store.save(this.memory);
      this.notification = await this.ports.notify(value.displayName);
    }
    await this.ports.store.save(this.memory);
    if (
      connection.mode === "independent" &&
      value.invitationState === "pending" &&
      value.invitation?.requestedBy === "desktop"
    )
      await this.openConfirmation();
    this.ports.changed();
  }
  async poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      await this.ready();
      try {
        this.client ??= await this.ports.createClient();
        const client = this.client;
        const invitationId = this.status?.invitation?.invitationId;
        let value: ConnectionStatus;
        try {
          value = await this.ports.query(client, invitationId);
        } catch (error) {
          if (!(error instanceof LmcpError) || error.code !== "STALE_CONNECTION")
            throw error;
          // 控制端口与业务端口共用安装身份，后一次 hello 会替换 Core 的发现记录。
          // 明确 STALE 已由协议客户端清除 hello 缓存：同轮只重新发现一次，沿用原
          // 归属/凭据/邀请查询控制状态，不重放配对或采集，也不等待下一次30秒 alarm。
          await client.hello();
          value = await this.ports.query(client, invitationId);
        }
        await this.install(value);
      } catch (error) {
        this.failureCode = error instanceof LmcpError ? error.code : null;
        this.client?.close();
        this.client = null;
        this.status = null;
        this.memory.wasAvailable = false;
        this.message = error instanceof Error ? error.message : "桌面暂时不可用";
        await this.ports.store.save(this.memory);
        this.ports.changed();
      }
    })();
    try {
      await this.polling;
    } finally {
      this.polling = undefined;
    }
  }
  /** 活跃连接使用五秒控制检测。Desktop 主动断开会同时关闭原生端口，
   * 此时 available=false 只说明通道失效，不能停止查证已保存的断开状态。
   * 未连接且未发现 Desktop 时仍交给原三十秒 alarm，避免不断启动宿主。 */
  async pollWhenActive(): Promise<void> {
    await this.ready();
    if (this.status || (await this.ports.connection()).mode === "desktop")
      await this.poll();
  }
  /** Worker 初始化可能早于宿主来源登记；仅首次传输未就绪补探测一次。
   * 两次都失败后继续由原30秒alarm检测，不拉起 Desktop、不请求邀请或恢复本地写入。 */
  start(): Promise<void> {
    return (this.started ??= (async () => {
      await this.poll();
      if (!this.startupTransportUnavailable()) return;
      await (
        this.ports.startupPause ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
      )(1000);
      // 等待期间可能已有用户检查或alarm成功，不能关闭其通道或重复通知。
      if (this.startupTransportUnavailable()) await this.poll();
    })());
  }
  private startupTransportUnavailable() {
    return (
      this.status === null &&
      (this.failureCode === "HOST_UNAVAILABLE" || this.failureCode === "DISCONNECTED")
    );
  }
  async request() {
    await this.poll();
    if (!this.client || !this.status)
      throw new Error(this.message || "未发现运行中的桌面端，请先打开桌面应用");
    if ((await this.ports.connection()).mode !== "independent")
      throw new Error("请先结束当前桌面连接");
    await this.install(await this.client.requestConnection());
    if (!this.status.invitation) throw new Error("桌面未返回有效连接邀请");
    this.shownInvitation = "";
    await this.openConfirmation();
    return this.view();
  }
  private async openConfirmation() {
    const id = this.status?.invitation?.invitationId;
    if (!id || this.shownInvitation === id || this.confirming) return;
    this.shownInvitation = id;
    try {
      await this.ports.showConfirmation();
    } catch (error) {
      this.shownInvitation = "";
      throw error;
    }
  }
  async confirm(id: string) {
    if (this.confirming) throw new Error("连接正在确认");
    await this.poll();
    const value = this.status,
      invitation = value?.invitation;
    if (
      !value ||
      !invitation ||
      invitation.invitationId !== id ||
      value.invitationState !== "pending"
    )
      throw new Error("邀请已取消或过期，请重新发起");
    this.confirming = true;
    try {
      await this.ports.confirm({
        ...invitation,
        desktopInstanceId: value.desktopInstanceId,
        displayName: value.displayName,
      });
      this.message = "已连接桌面端";
      this.status = {
        ...value,
        invitation: null,
        invitationState: "accepted",
        connectionState: "connected",
      };
    } catch (error) {
      this.message = (error as Error).message;
      throw error;
    } finally {
      this.confirming = false;
      this.ports.changed();
    }
    return this.view();
  }
  async cancel(id: string) {
    if (this.confirming || (await this.ports.connection()).mode === "desktop")
      throw new Error("连接结果正在确认，请在连接设置中明确断开");
    await this.poll();
    if (!this.client || !this.status)
      throw new Error("桌面暂不可用，不能确认取消；邀请会按原期限失效");
    await this.install(await this.client.requestConnection("cancel", id));
    this.shownInvitation = "";
    this.ports.changed();
    return this.view();
  }
  async suppress() {
    await this.ready();
    // 临时离线已清除状态，但用户明确断开仍须抑制原桌面再次上线时的通知。
    // 这里只记安全实例 ID；用户仍可以从设置主动发起新邀请。
    this.memory.suppressedDesktop =
      this.status?.desktopInstanceId ?? this.memory.lastDesktopId;
    await this.ports.store.save(this.memory);
  }
}
