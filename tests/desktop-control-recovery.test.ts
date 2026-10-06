import test from "node:test";
import assert from "node:assert/strict";
import fixtures from "../lib/connector/contracts/contracts.json" with { type: "json" };
import { LmcpClient } from "../lib/connector/client.ts";
import { NativeMessagingTransport } from "../lib/connector/transport.ts";
import { LmcpError } from "../lib/connector/types.ts";
import type {
  ConnectionStatus,
  PairingCredential,
  RequestFrame,
  ResponseFrame,
} from "../lib/connector/types.ts";
import type { NativePort } from "../lib/connector/transport.ts";
import { DesktopDiscovery } from "../lib/desktop-discovery.ts";
import type { ConnectionView } from "../lib/desktop-connection.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-03T00:00:00.000Z");
function response(method: string): ResponseFrame {
  return structuredClone(
    fixtures.find((item) => item.name === `${method}-response`)!.value,
  ) as ResponseFrame;
}

/** 模型沿 Core 的 origin/client→当前端口规则工作；使用真实协议客户端和原生信封，
 * 不把业务通道关闭误当作可信 disconnected，也不直接返回预设的 STALE 序列。 */
function setup(
  options: {
    independent?: boolean;
    disconnectFirstPort?: boolean;
    startupPause?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const credential = structuredClone(
    (response("pair") as any).result.pairingCredential,
  ) as PairingCredential;
  const frames: RequestFrame[] = [];
  let observedPort: string | null = null;
  let desktopId = ID;
  let connectionState: ConnectionStatus["connectionState"] = "connected";
  let controlError: string | null = null;
  let hostUnavailable = false;
  let connectionAttempts = 0;
  let disconnectFirstPort = options.disconnectFirstPort === true;
  let notifications = 0;
  let ended = 0;
  let view: ConnectionView = {
    mode: options.independent ? "independent" : "desktop",
    status: options.independent ? "independent" : "reconnecting",
    message: "独立资料仍封存",
    unknownOperations: 0,
    disconnectUnconfirmed: false,
  };
  const client = () =>
    new LmcpClient({
      clientInstanceId: ID,
      now: () => NOW,
      transport: new NativeMessagingTransport({
        connectNative() {
          connectionAttempts++;
          if (hostUnavailable) throw new Error("宿主来源尚未登记或Core尚未就绪");
          const listeners: ((value: unknown) => void)[] = [];
          const closed: (() => void)[] = [];
          let connectionId = "";
          const port: NativePort = {
            onMessage: { addListener: (listener) => listeners.push(listener) },
            onDisconnect: { addListener: (listener) => closed.push(listener) },
            disconnect() {
              if (observedPort === connectionId) observedPort = null;
              for (const listener of closed) listener();
            },
            postMessage(raw) {
              const frame = raw as RequestFrame;
              frames.push(structuredClone(frame));
              connectionId = frame.connectionId;
              if (disconnectFirstPort && frame.method === "hello") {
                disconnectFirstPort = false;
                queueMicrotask(() => port.disconnect());
                return;
              }
              const value = response(frame.method);
              value.requestId = frame.requestId;
              value.connectionId = frame.connectionId;
              if (frame.method === "hello" && value.ok) {
                assert.equal((frame.params as any).clientInstanceId, ID);
                observedPort = frame.connectionId;
                Object.assign(value.result as Record<string, unknown>, {
                  connectionId: frame.connectionId,
                  desktopInstanceId: desktopId,
                  maxFrameBytes: 262144,
                });
              }
              if (frame.method === "getConnectionStatus") {
                assert.deepEqual((frame.params as any).pairingCredential, credential);
                const error =
                  controlError ??
                  (observedPort !== frame.connectionId ? "STALE_CONNECTION" : null);
                if (error) {
                  const failure = {
                    apiVersion: value.apiVersion,
                    requestId: value.requestId,
                    connectionId: value.connectionId,
                    method: value.method,
                    ok: false,
                    error: { code: error, message: error, retryable: true },
                  };
                  queueMicrotask(() =>
                    listeners.forEach((listener) => listener(failure)),
                  );
                  return;
                }
                if (value.ok)
                  Object.assign(value.result as Record<string, unknown>, {
                    desktopInstanceId: desktopId,
                    connectionState,
                    invitationState: "accepted",
                    invitation: null,
                  });
              }
              queueMicrotask(() => listeners.forEach((listener) => listener(value)));
            },
          };
          return port;
        },
      }),
    });
  const control = client();
  const business = client();
  const discovery = new DesktopDiscovery({
    store: {
      async load() {
        return null;
      },
      async save() {},
    },
    async createClient() {
      return control;
    },
    async query(current, invitationId) {
      // 与真实 queryControl 相同：重新握手仍必须属于原配对 Desktop。
      const hello = await current.hello();
      if (hello.desktopInstanceId !== credential.desktopInstanceId)
        throw new LmcpError("OWNER_MISMATCH", "不能改投另一桌面");
      return current.getConnectionStatus(credential, invitationId);
    },
    async connection() {
      return view;
    },
    async notify() {
      notifications++;
      return "enabled";
    },
    async showConfirmation() {
      throw new Error("恢复不应弹出新配对确认");
    },
    async confirm() {
      throw new Error("恢复不应静默重新配对");
    },
    async desktopDisconnected(status) {
      assert.equal(status.connectionState, "disconnected");
      assert.equal(status.desktopInstanceId, credential.desktopInstanceId);
      ended++;
      view = { ...view, mode: "independent", status: "independent" };
    },
    changed() {},
    startupPause: options.startupPause,
  });
  return {
    discovery,
    control,
    business,
    frames,
    ended: () => ended,
    setState: (value: typeof connectionState) => (connectionState = value),
    fail: (value: string) => (controlError = value),
    blockHost: (value: boolean) => (hostUnavailable = value),
    attempts: () => connectionAttempts,
    notifications: () => notifications,
    changeDesktop: () => (desktopId = OTHER),
    close() {
      control.close();
      business.close();
    },
  };
}

test("业务端口覆盖控制发现后关闭，同轮重握手取得可信断开，恢复原 A", async () => {
  const s = setup();
  try {
    await s.discovery.poll();
    const controlPort = s.control.connectionId;
    await s.business.pair({ invitationId: ID, invitationToken: "i".repeat(43) }, ID);
    assert.notEqual(s.business.connectionId, controlPort);
    s.setState("disconnected");
    s.business.close();
    const start = s.frames.length;
    await s.discovery.poll();
    assert.deepEqual(
      s.frames.slice(start).map((frame) => frame.method),
      ["getConnectionStatus", "hello", "getConnectionStatus"],
    );
    assert.ok(s.frames.slice(start).every((frame) => frame.connectionId === controlPort));
    assert.equal(s.ended(), 1);
    assert.equal((await s.discovery.view()).connection.mode, "independent");
  } finally {
    s.close();
  }
});

test("业务端口仅替换发现而未明确断开，重握手保持 Desktop 归属与 A 封存", async () => {
  const s = setup();
  try {
    await s.discovery.poll();
    await s.business.hello();
    await s.discovery.poll();
    assert.equal(s.ended(), 0);
    assert.equal((await s.discovery.view()).available, true);
    assert.equal((await s.discovery.view()).connection.mode, "desktop");
    assert.equal(s.frames.filter((frame) => frame.method === "pair").length, 0);
  } finally {
    s.close();
  }
});

test("重复 STALE 最多重握手一次，不循环重试、不解除 A 封存", async () => {
  const s = setup();
  try {
    await s.discovery.poll();
    s.fail("STALE_CONNECTION");
    const start = s.frames.length;
    await s.discovery.poll();
    assert.deepEqual(
      s.frames.slice(start).map((frame) => frame.method),
      ["getConnectionStatus", "hello", "getConnectionStatus"],
    );
    assert.equal((await s.discovery.view()).available, false);
    assert.equal(s.ended(), 0);
  } finally {
    s.close();
  }
});

test("非 STALE 错误不重新握手，撤权不冒充 Desktop 明确断开", async () => {
  const s = setup();
  try {
    await s.discovery.poll();
    s.fail("PAIRING_REVOKED");
    const start = s.frames.length;
    await s.discovery.poll();
    assert.deepEqual(
      s.frames.slice(start).map((frame) => frame.method),
      ["getConnectionStatus"],
    );
    assert.equal(s.ended(), 0);
    assert.equal((await s.discovery.view()).connection.mode, "desktop");
  } finally {
    s.close();
  }
});

test("STALE 后发现另一 Desktop 时仍拒绝改投，不能据其状态恢复 A", async () => {
  const s = setup();
  try {
    await s.discovery.poll();
    await s.business.hello();
    s.changeDesktop();
    s.setState("disconnected");
    const start = s.frames.length;
    await s.discovery.poll();
    assert.deepEqual(
      s.frames.slice(start).map((frame) => frame.method),
      ["getConnectionStatus", "hello"],
    );
    assert.equal((await s.discovery.view()).available, false);
    assert.equal(s.ended(), 0);
  } finally {
    s.close();
  }
});

test("首次宿主登记未就绪，一秒补探测后真实hello并通知；并发start只执行一次", async () => {
  const pauses: number[] = [];
  const s = setup({
    independent: true,
    async startupPause(milliseconds) {
      pauses.push(milliseconds);
      s.blockHost(false);
    },
  });
  try {
    s.blockHost(true);
    await Promise.all([s.discovery.start(), s.discovery.start()]);
    assert.deepEqual(pauses, [1000]);
    assert.equal(s.attempts(), 2);
    assert.deepEqual(
      s.frames.map((frame) => frame.method),
      ["hello", "getConnectionStatus"],
    );
    assert.equal((await s.discovery.view()).available, true);
    assert.equal(s.notifications(), 1);
    assert.equal(s.ended(), 0);
  } finally {
    s.close();
  }
});

test("首次原生端口在hello回执前断开，一次新端口探测恢复通知且不写业务", async () => {
  const pauses: number[] = [];
  const s = setup({
    independent: true,
    disconnectFirstPort: true,
    async startupPause(ms) {
      pauses.push(ms);
    },
  });
  try {
    await s.discovery.start();
    assert.deepEqual(pauses, [1000]);
    assert.equal(s.attempts(), 2);
    assert.deepEqual(
      s.frames.map((frame) => frame.method),
      ["hello", "hello", "getConnectionStatus"],
    );
    assert.notEqual(s.frames[0]!.connectionId, s.frames[1]!.connectionId);
    assert.equal((await s.discovery.view()).available, true);
    assert.equal(s.notifications(), 1);
  } finally {
    s.close();
  }
});

test("Core冷启动超过首次补探测时不循环，之后原alarm读控制仍能发现", async () => {
  const pauses: number[] = [];
  const s = setup({
    independent: true,
    async startupPause(ms) {
      pauses.push(ms);
    },
  });
  try {
    s.blockHost(true);
    await s.discovery.start();
    await s.discovery.start();
    assert.deepEqual(pauses, [1000]);
    assert.equal(s.attempts(), 2);
    assert.equal((await s.discovery.view()).available, false);
    assert.equal(s.notifications(), 0);
    s.blockHost(false);
    // 对应后续原30秒alarm，仅调用正常poll，没有改动长期检测节奏或操作系统时间。
    await s.discovery.poll();
    assert.equal(s.attempts(), 3);
    assert.equal((await s.discovery.view()).available, true);
    assert.equal(s.notifications(), 1);
  } finally {
    s.close();
  }
});

test("启动协议或授权拒绝不补探测，不配对、不解除资料封存", async () => {
  const s = setup({
    async startupPause() {
      throw new Error("不应等待或重试");
    },
  });
  try {
    s.fail("PAIRING_REVOKED");
    await s.discovery.start();
    assert.equal(s.attempts(), 1);
    assert.equal(s.notifications(), 0);
    assert.equal(s.ended(), 0);
    assert.equal((await s.discovery.view()).connection.mode, "desktop");
  } finally {
    s.close();
  }
});

test("一秒等待期间用户已检查成功，不再重复握手或通知", async () => {
  let resume!: () => void;
  let waiting!: () => void;
  const atPause = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const s = setup({
    independent: true,
    async startupPause() {
      waiting();
      await pause;
    },
  });
  try {
    s.blockHost(true);
    const starting = s.discovery.start();
    await atPause;
    s.blockHost(false);
    await s.discovery.poll();
    resume();
    await starting;
    assert.equal(s.attempts(), 2);
    assert.equal(s.notifications(), 1);
    assert.equal((await s.discovery.view()).available, true);
  } finally {
    resume();
    s.close();
  }
});
