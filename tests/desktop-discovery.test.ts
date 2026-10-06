import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { DesktopDiscovery, IndexedDiscoveryStore } from "../lib/desktop-discovery.ts";
import type { DiscoveryMemory, DiscoveryStore } from "../lib/desktop-discovery.ts";
import type { LmcpClient } from "../lib/connector/client.ts";
import type { ConnectionStatus } from "../lib/connector/types.ts";
import type { ConnectionView } from "../lib/desktop-connection.ts";
const ID = "11111111-1111-4111-8111-111111111111";
function setup(notification: "enabled" | "denied" | "unavailable" = "enabled") {
  let saved: DiscoveryMemory | null = null,
    fail = false;
  let control: ConnectionStatus = {
    desktopInstanceId: ID,
    displayName: "词遇桌面端",
    connectionState: "unpaired",
    invitationState: "none",
    invitation: null,
  };
  let connection: ConnectionView = {
    mode: "independent",
    status: "independent",
    message: "",
    unknownOperations: 0,
    disconnectUnconfirmed: false,
  };
  const calls: string[] = [];
  const store: DiscoveryStore = {
    async load() {
      return saved;
    },
    async save(value) {
      saved = structuredClone(value);
    },
  };
  const client = {
    close() {
      calls.push("close");
    },
    async requestConnection(action: string) {
      calls.push(action);
      control = {
        ...control,
        invitationState: action === "cancel" ? "cancelled" : "pending",
        invitation:
          action === "cancel"
            ? null
            : {
                invitationId: ID,
                invitationToken: "i".repeat(43),
                expiresAt: new Date(Date.now() + 120000).toISOString(),
                requestedBy: "plugin",
              },
      };
      return control;
    },
  } as unknown as LmcpClient;
  const discovery = new DesktopDiscovery({
    store,
    async createClient() {
      calls.push("create");
      return client;
    },
    async query() {
      calls.push("query");
      if (fail) throw new Error("host unavailable");
      return control;
    },
    async connection() {
      return connection;
    },
    async notify() {
      calls.push("notify");
      return notification;
    },
    async showConfirmation() {
      calls.push("popup");
    },
    changed() {},
    async confirm(invitation) {
      assert.equal(invitation.invitationToken, "i".repeat(43));
      calls.push("confirm");
      connection = { ...connection, mode: "desktop", status: "connected" };
    },
    async desktopDisconnected() {
      calls.push("end");
      connection = {
        ...connection,
        mode: "independent",
        status: "independent",
      };
    },
  });
  return {
    discovery,
    calls,
    state: () => saved,
    control: (value: Partial<ConnectionStatus>) => (control = { ...control, ...value }),
    connection: (value: Partial<ConnectionView>) =>
      (connection = { ...connection, ...value }),
    fail: (value: boolean) => (fail = value),
  };
}
test("纯发现只通知一次，不弹窗、不配对、不读取业务；视图没有秘密", async () => {
  const s = setup();
  await s.discovery.poll();
  await s.discovery.poll();
  assert.equal(s.calls.filter((x) => x === "notify").length, 1);
  assert.equal(s.calls.includes("popup"), false);
  assert.equal(s.calls.includes("confirm"), false);
  assert.equal((await s.discovery.view()).available, true);
  assert.equal(JSON.stringify(s.state()).includes("invitationToken"), false);
});
test("插件一键发起仍必须真实确认；取消不封存，重复轮询不刷窗口", async () => {
  const s = setup();
  const view = await s.discovery.request();
  assert.equal(view.invitation?.invitationId, ID);
  assert.equal(s.calls.at(-1), "popup");
  assert.equal(JSON.stringify(view).includes("invitationToken"), false);
  assert.equal(s.calls.includes("confirm"), false);
  await s.discovery.poll();
  assert.equal(s.calls.filter((x) => x === "popup").length, 1);
  await s.discovery.cancel(ID);
  assert.equal((await s.discovery.view()).connection.mode, "independent");
});
test("Desktop 用户发起邀请打开一次确认窗，点击确认才建立 Desktop 归属", async () => {
  const s = setup();
  s.control({
    invitationState: "pending",
    invitation: {
      invitationId: ID,
      invitationToken: "i".repeat(43),
      requestedBy: "desktop",
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    },
  });
  await s.discovery.poll();
  await s.discovery.poll();
  assert.equal(s.calls.filter((x) => x === "popup").length, 1);
  assert.equal(s.calls.includes("confirm"), false);
  await s.discovery.confirm(ID);
  assert.equal((await s.discovery.view()).connection.status, "connected");
  await assert.rejects(s.discovery.cancel(ID), /确认|断开/);
});
test("拒绝通知保留真实设置可连接入口，不反复通知；显式断开不自动重连", async () => {
  const s = setup("denied");
  await s.discovery.poll();
  assert.equal((await s.discovery.view()).notification, "denied");
  await s.discovery.suppress();
  s.fail(true);
  await s.discovery.poll();
  s.fail(false);
  await s.discovery.poll();
  assert.equal(s.calls.filter((x) => x === "notify").length, 1);
  assert.equal(s.calls.includes("confirm"), false);
  await s.discovery.request();
  assert.equal(s.calls.includes("popup"), true);
});
test("临时失联和撤权保持 A 封存，只有可信明确 disconnected 结束归属", async () => {
  const s = setup();
  s.connection({ mode: "desktop", status: "reconnecting" });
  s.fail(true);
  await s.discovery.poll();
  assert.equal(s.calls.includes("end"), false);
  s.fail(false);
  s.control({ connectionState: "revoked" });
  await s.discovery.poll();
  assert.equal(s.calls.includes("end"), false);
  s.control({ connectionState: "disconnected" });
  await s.discovery.poll();
  assert.equal(s.calls.filter((x) => x === "end").length, 1);
});
test("离线时明确断开仍抑制原桌面恢复通知，不影响其他桌面或用户主动连接", async () => {
  const s = setup();
  await s.discovery.poll();
  s.fail(true);
  await s.discovery.poll();
  assert.equal((await s.discovery.view()).available, false);
  await s.discovery.suppress();
  assert.equal(s.state()?.suppressedDesktop, ID);
  s.fail(false);
  await s.discovery.poll();
  assert.equal(s.calls.filter((x) => x === "notify").length, 1);
  await s.discovery.request();
  assert.equal(s.calls.filter((x) => x === "popup").length, 1);
  s.control({ desktopInstanceId: "22222222-2222-4222-8222-222222222222" });
  await s.discovery.poll();
  assert.equal(s.calls.filter((x) => x === "notify").length, 2);
});
test("IndexedDiscoveryStore 真实事务只存安全通知元数据", async () => {
  const first = new IndexedDiscoveryStore(),
    value = {
      notifiedKey: "instance:1",
      suppressedDesktop: ID,
      lastDesktopId: ID,
      generation: 1,
      wasAvailable: true,
    };
  await first.save(value);
  assert.deepEqual(await new IndexedDiscoveryStore().load(), value);
});
