import { assertFrame, encodedFrameBytes, LMCP_CONTRACT } from "./protocol.ts";
import { LmcpError } from "./types.ts";
import type { HostRequest, HostResponse, RequestFrame, ResponseFrame } from "./types.ts";

export interface LmcpTransport {
  readonly connectionId: string | null;
  connect(): string;
  setMaxFrameBytes(bytes: number): void;
  request(frame: RequestFrame, timeoutMs?: number): Promise<ResponseFrame>;
  close(reason?: LmcpError): void;
  onDisconnect: ((error: LmcpError) => void) | null;
  onHostRequest: ((request: HostRequest) => Promise<HostResponse>) | null;
}
export type NativePort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};
export type NativeRuntime = {
  connectNative(name: string): NativePort;
  readonly lastError?: { message?: string };
};
type Pending = {
  frame: RequestFrame;
  resolve(response: ResponseFrame): void;
  reject(error: LmcpError): void;
  timer: ReturnType<typeof setTimeout>;
};

// 生产仅通过 Chrome Native Port；注入 runtime 是模型测试边界，不切换生产传输。
export class NativeMessagingTransport implements LmcpTransport {
  onDisconnect: ((error: LmcpError) => void) | null = null;
  onHostRequest: ((request: HostRequest) => Promise<HostResponse>) | null = null;
  private runtime: NativeRuntime;
  private port: NativePort | null = null;
  private id: string | null = null;
  private maxBytes = LMCP_CONTRACT.maxFrameBytes;
  private pending = new Map<string, Pending>();
  constructor(runtime?: NativeRuntime) {
    const available =
      runtime ?? (globalThis as { chrome?: { runtime?: NativeRuntime } }).chrome?.runtime;
    if (!available)
      throw new LmcpError("HOST_UNAVAILABLE", "当前环境不支持浏览器原生连接");
    this.runtime = available;
  }
  get connectionId() {
    return this.id;
  }
  connect(): string {
    if (this.port && this.id) return this.id;
    let port: NativePort;
    try {
      port = this.runtime.connectNative(LMCP_CONTRACT.nativeHost);
    } catch {
      throw new LmcpError(
        "HOST_UNAVAILABLE",
        "无法连接词遇原生宿主，请安装 Desktop 浏览器连接组件",
        { retryable: true },
      );
    }
    const id = crypto.randomUUID();
    this.port = port;
    this.id = id;
    this.maxBytes = LMCP_CONTRACT.maxFrameBytes;
    port.onMessage.addListener((message) => {
      if (this.port !== port || this.id !== id) return;
      try {
        if (encodedFrameBytes(message) > this.maxBytes)
          throw new LmcpError("MESSAGE_TOO_LARGE", "Desktop 返回的消息超过合同上限");
        if (
          message &&
          typeof message === "object" &&
          "kind" in message &&
          message.kind === "host-request"
        ) {
          assertFrame("HostRequest", message);
          const request = message as HostRequest;
          if (request.connectionId !== id)
            throw new LmcpError(
              "CONNECTION_MISMATCH",
              "Desktop 返回了其他连接的宿主命令",
            );
          void this.handleHost(port, id, request);
          return;
        }
        assertFrame("Response", message);
        const response = message as ResponseFrame;
        if (response.connectionId !== id)
          throw new LmcpError("CONNECTION_MISMATCH", "Desktop 返回了其他连接的消息");
        const waiting = this.pending.get(response.requestId);
        // 已超时或已结算的迟到响应不触发业务，也不取消其他请求。
        if (!waiting) return;
        if (response.method !== waiting.frame.method)
          throw new LmcpError("METHOD_MISMATCH", "Desktop 回执方法与请求不一致");
        this.pending.delete(response.requestId);
        clearTimeout(waiting.timer);
        waiting.resolve(response);
      } catch (error) {
        this.close(
          error instanceof LmcpError
            ? new LmcpError(error.code, error.message, { resultUnknown: true })
            : new LmcpError("INVALID_FRAME", "Desktop 返回了无效消息", {
                resultUnknown: true,
              }),
        );
      }
    });
    port.onDisconnect.addListener(() => {
      // 即使是旧端口也消费 lastError；它不能影响新连接的在途请求。
      const reason = this.runtime.lastError?.message;
      if (this.port !== port || this.id !== id) return;
      this.close(
        new LmcpError(
          "DISCONNECTED",
          reason
            ? "Desktop 原生连接已断开，请检查宿主安装或桌面运行状态"
            : "Desktop 连接已断开",
          { retryable: true, resultUnknown: true },
        ),
      );
    });
    return id;
  }
  setMaxFrameBytes(bytes: number): void {
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > LMCP_CONTRACT.maxFrameBytes)
      throw new LmcpError("INVALID_FRAME", "Desktop 消息上限无效");
    this.maxBytes = bytes;
  }
  request(frame: RequestFrame, timeoutMs = 15_000): Promise<ResponseFrame> {
    try {
      assertFrame("Request", frame);
      if (!this.port || this.id !== frame.connectionId)
        throw new LmcpError("DISCONNECTED", "当前连接已失效", {
          retryable: true,
        });
      if (encodedFrameBytes(frame) > this.maxBytes)
        throw new LmcpError("MESSAGE_TOO_LARGE", "请求超过 256 KiB，请减少本次采集内容");
      if (this.pending.has(frame.requestId))
        throw new LmcpError("REQUEST_ID_REUSED", "本连接请求编号已在使用");
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.requestId);
        reject(
          new LmcpError("TIMEOUT", "Desktop 响应超时；采集可能已提交，请查询原操作回执", {
            retryable: true,
            resultUnknown: true,
          }),
        );
      }, timeoutMs);
      this.pending.set(frame.requestId, { frame, resolve, reject, timer });
      try {
        this.port!.postMessage(frame);
      } catch {
        this.pending.delete(frame.requestId);
        clearTimeout(timer);
        reject(
          new LmcpError("DISCONNECTED", "Desktop 消息发送失败，连接结果待确认", {
            retryable: true,
            resultUnknown: true,
          }),
        );
        this.close(
          new LmcpError("DISCONNECTED", "Desktop 原生连接已断开", {
            retryable: true,
            resultUnknown: true,
          }),
        );
      }
    });
  }
  close(
    reason = new LmcpError("DISCONNECTED", "连接已关闭", {
      resultUnknown: true,
    }),
  ): void {
    const port = this.port;
    this.port = null;
    this.id = null;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(reason);
    }
    this.pending.clear();
    try {
      port?.disconnect();
    } catch {
      // 通道已失效；仍须清除本机授权与在途等待。
    }
    if (port) this.onDisconnect?.(reason);
  }
  private async handleHost(port: NativePort, id: string, request: HostRequest) {
    const base = {
      kind: "host-response" as const,
      apiMajor: 1 as const,
      connectionId: id,
      requestId: request.requestId,
      invocationId: request.invocationId,
      method: request.method,
    };
    let response: HostResponse;
    try {
      if (!this.onHostRequest)
        throw new LmcpError("CAPABILITY_UNAVAILABLE", "插件未登记该宿主能力");
      response = await this.onHostRequest(request);
      assertFrame("HostResponse", response);
      if (
        response.connectionId !== id ||
        response.requestId !== request.requestId ||
        response.invocationId !== request.invocationId ||
        response.method !== request.method
      )
        throw new LmcpError("INVALID_FRAME", "插件宿主回执身份无效");
    } catch (error) {
      const failure =
        error instanceof LmcpError
          ? error
          : new LmcpError("HOST_UNAVAILABLE", "插件宿主操作未完成");
      response = {
        ...base,
        ok: false,
        error: {
          code: failure.code,
          message: failure.message.slice(0, 300),
          retryable: failure.retryable,
        },
      };
    }
    // 旧异步动作不能经新 Native Port 回复，更不能污染新的 owner。
    if (this.port !== port || this.id !== id) return;
    if (encodedFrameBytes(response) > this.maxBytes)
      response = {
        ...base,
        ok: false,
        error: {
          code: "RESPONSE_TOO_LARGE",
          message: "插件宿主回执超过消息上限",
          retryable: false,
        },
      };
    try {
      port.postMessage(response);
    } catch {
      this.close(
        new LmcpError("DISCONNECTED", "插件宿主回执发送失败", {
          resultUnknown: true,
        }),
      );
    }
  }
}
