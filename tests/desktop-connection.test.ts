import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { DesktopConnection, IndexedConnectionStore } from "../lib/desktop-connection.ts";
import type {
  ConnectionRecord,
  ConnectionStore,
  IndependentOwnership,
} from "../lib/desktop-connection.ts";
import { LmcpError, ownerKey } from "../lib/connector/types.ts";
import type { LmcpClient } from "../lib/connector/client.ts";
import type {
  OperationResult,
  PairingCredential,
  RecordEncounterParams,
  RecordEncounterResult,
  WorkspaceResult,
} from "../lib/connector/types.ts";

// 这里验证后台归属与恢复模型；真实 Native Host/双项目联调另外验证。
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SECRET = "s".repeat(43),
  PAIR_SECRET = "p".repeat(43);
const copy = <T>(value: T): T => structuredClone(value);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function credential(clientInstanceId = ID): PairingCredential {
  return {
    pairingId: ID,
    desktopInstanceId: ID,
    clientInstanceId,
    workspaceId: ID,
    generation: ID,
    authorizationEpoch: "1",
    pairingToken: PAIR_SECRET,
  };
}
function invitation() {
  return {
    invitationId: ID,
    invitationToken: "i".repeat(43),
    requestedBy: "plugin" as const,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    desktopInstanceId: ID,
    displayName: "词遇桌面端",
  };
}
function capture(mutationId = crypto.randomUUID()): RecordEncounterParams {
  return {
    mutationId,
    eventId: crypto.randomUUID(),
    notebookId: null,
    data: {
      word: {
        kind: "dictionary",
        entryId: ID,
        release: "0.0.3",
        entrySchema: "leximeet.entry.v2",
      },
      surface: "system",
      originalSentence: "A system works.",
      savedExcerpt: "A system works.",
      occurrenceRanges: [{ start: 2, end: 8 }],
      excerptRanges: [{ start: 2, end: 8 }],
      annotation: { note: "" },
      source: {
        kind: "web",
        title: "Article",
        url: "https://example.invalid/article",
      },
      collectionIntent: "collect",
    },
  };
}
function result(params: RecordEncounterParams): RecordEncounterResult {
  return {
    workspaceRevision: "1",
    entity: {
      entityType: "encounter",
      entityId: params.eventId,
      revision: "1",
      deletedAt: null,
      data: {
        ...copy(params.data),
        origin: { deviceId: OTHER, clientKind: "desktop" },
        occurredAt: new Date().toISOString(),
        timeZone: "Asia/Shanghai",
      },
    },
  };
}
class MemoryStore implements ConnectionStore {
  saved: ConnectionRecord | null = null;
  saves: ConnectionRecord[] = [];
  async load() {
    return copy(this.saved);
  }
  async save(value: ConnectionRecord) {
    this.saved = copy(value);
    this.saves.push(copy(value));
  }
}
class Ownership implements IndependentOwnership {
  frozen = false;
  freezeCount = 0;
  resumeCount = 0;
  archiveId = ID;
  data = { words: ["system"], score: 12, plan: "A", drafts: ["unfinished"] };
  async freezeIndependent() {
    this.freezeCount++;
    this.frozen = true;
    return { archiveId: this.archiveId };
  }
  async resumeIndependent(archiveId: string) {
    assert.equal(archiveId, this.archiveId);
    this.resumeCount++;
    this.frozen = false;
  }
}
class ModelClient {
  connected = false;
  owner = credential();
  pairGate: ReturnType<typeof deferred<void>> | null = null;
  resumeGate: ReturnType<typeof deferred<void>> | null = null;
  pairError: Error | null = null;
  resumeError: Error | null = null;
  confirmDisconnect = true;
  expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  readLeaseUntil = new Date(Date.now() + 30_000).toISOString();
  renewError: Error | null = null;
  renewGate: ReturnType<typeof deferred<void>> | null = null;
  changeError: Error | null = null;
  changeGate: ReturnType<typeof deferred<void>> | null = null;
  afterChanges: (() => void) | null = null;
  workspaceRevision = "1";
  dictionaryEdition: WorkspaceResult["dictionaryEdition"] = "core-text";
  account: WorkspaceResult["account"] = {
    status: "unavailable",
    source: "desktop",
  };
  workspaceGate: ReturnType<typeof deferred<void>> | null = null;
  workspaceError: Error | null = null;
  workspaceLease: string | null = null;
  captureGate: ReturnType<typeof deferred<RecordEncounterResult>> | null = null;
  captureError: LmcpError | null = null;
  operation: OperationResult | null = null;
  calls: { method: string; params: unknown }[] = [];
  beforeCapture: (() => void) | null = null;
  private disconnected: (error: LmcpError) => void;
  constructor(disconnected: (error: LmcpError) => void) {
    this.disconnected = disconnected;
  }
  get session() {
    return {
      owner: this.owner,
      authorization: {
        sessionId: ID,
        sessionToken: SECRET,
        workspaceId: this.owner.workspaceId,
        generation: this.owner.generation,
        authorizationEpoch: this.owner.authorizationEpoch,
      },
      pairingId: this.owner.pairingId,
      expiresAt: this.expiresAt,
      readLeaseUntil: this.readLeaseUntil,
      scopes: ["library:read", "capture:write", "navigation:open"],
    };
  }
  async hello() {
    return { desktopInstanceId: ID, displayName: "词遇桌面端" };
  }
  async pair(invite: unknown, clientId: string) {
    this.calls.push({
      method: "pair",
      params: { invitation: invite, clientId },
    });
    if (this.pairGate) await this.pairGate.promise;
    if (this.pairError) throw this.pairError;
    this.owner = credential(clientId);
    this.connected = true;
    return { ...this.session, pairingCredential: copy(this.owner) };
  }
  async resume(value: PairingCredential) {
    this.calls.push({ method: "resume", params: copy(value) });
    if (this.resumeGate) await this.resumeGate.promise;
    if (this.resumeError) throw this.resumeError;
    this.owner = copy(value);
    this.connected = true;
    return this.session;
  }
  async getWorkspace(): Promise<WorkspaceResult> {
    this.calls.push({ method: "getWorkspace", params: {} });
    const snapshot = {
      owner: copy(this.owner),
      revision: this.workspaceRevision,
      dictionaryRelease: "0.0.3",
      dictionaryEdition: this.dictionaryEdition,
      account: copy(this.account),
      cloudSync: "disabled" as const,
    };
    if (this.workspaceGate) await this.workspaceGate.promise;
    if (this.workspaceError) throw this.workspaceError;
    // 与正式 LmcpClient 一致：工作区读取成功会更新会话的只读缓存租期。
    this.readLeaseUntil =
      this.workspaceLease ?? new Date(Date.now() + 30_000).toISOString();
    return { ...snapshot, readLeaseUntil: this.readLeaseUntil };
  }
  async renew() {
    this.calls.push({ method: "renew", params: {} });
    if (this.renewGate) await this.renewGate.promise;
    if (this.renewError) throw this.renewError;
    this.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    this.readLeaseUntil = new Date(Date.now() + 30_000).toISOString();
    return this.session;
  }
  async getChanges(sinceRevision: string) {
    this.calls.push({ method: "getChanges", params: { sinceRevision } });
    const revision = this.workspaceRevision;
    if (this.changeGate) await this.changeGate.promise;
    if (this.changeError) throw this.changeError;
    this.readLeaseUntil = new Date(Date.now() + 30_000).toISOString();
    this.afterChanges?.();
    return {
      revision,
      changed: sinceRevision !== revision,
      readLeaseUntil: this.readLeaseUntil,
    };
  }
  async recordEncounter(params: RecordEncounterParams) {
    this.calls.push({ method: "recordEncounter", params: copy(params) });
    this.beforeCapture?.();
    if (this.captureGate) return this.captureGate.promise;
    if (this.captureError) throw this.captureError;
    return result(params);
  }
  async getOperation(mutationId: string): Promise<OperationResult> {
    this.calls.push({ method: "getOperation", params: { mutationId } });
    return this.operation ? copy(this.operation) : { mutationId, status: "unknown" };
  }
  async disconnect() {
    this.connected = false;
    this.disconnected(new LmcpError("DISCONNECTED", "manual"));
    return { confirmed: this.confirmDisconnect };
  }
  close() {
    this.connected = false;
    this.disconnected(new LmcpError("DISCONNECTED", "closed"));
  }
  lose() {
    this.close();
  }
}
function setup(saved?: ConnectionRecord) {
  const store = new MemoryStore(),
    library = new Ownership(),
    clients: ModelClient[] = [];
  if (saved) store.saved = copy(saved);
  let prepare: ((client: ModelClient) => void) | null = null;
  const factory = (onDisconnect: (error: LmcpError) => void) => {
    const client = new ModelClient(onDisconnect);
    prepare?.(client);
    clients.push(client);
    return client as unknown as LmcpClient;
  };
  const connection = new DesktopConnection({
    store,
    library,
    createClient: factory,
  });
  return {
    store,
    library,
    clients,
    connection,
    factory,
    setPrepare(fn: ((client: ModelClient) => void) | null) {
      prepare = fn;
    },
  };
}

test("用户确认先封存 A；明确未接受才恢复，成功后不上传", async () => {
  const s = setup();
  await s.connection.ready();
  const original = copy(s.library.data),
    gate = deferred<void>();
  s.setPrepare((client) => {
    client.pairGate = gate;
  });
  const joining = s.connection.connect(invitation());
  await tick();
  assert.equal(s.library.frozen, true);
  assert.equal(s.library.freezeCount, 1);
  // 在途配对可查询控制视图，但不能趁资料切换采集或读取私人工作区。
  assert.equal((await s.connection.view()).mode, "desktop");
  assert.equal(s.connection.readContext(), null);
  await assert.rejects(
    s.connection.capture(capture(), s.connection.ticket()),
    /连接切换正在进行/,
  );
  assert.equal(
    s.clients[0]!.calls.some((call) => call.method === "recordEncounter"),
    false,
  );
  gate.reject(new LmcpError("INVITATION_CANCELLED", "用户取消邀请"));
  await assert.rejects(joining);
  assert.equal((await s.connection.view()).mode, "independent");
  assert.equal(s.library.freezeCount, 1);
  assert.equal(s.library.frozen, false);
  s.setPrepare(null);
  await s.connection.connect(invitation());
  assert.equal(s.library.frozen, true);
  assert.equal((await s.connection.view()).status, "connected");
  assert.deepEqual(s.library.data, original);
  assert.deepEqual(
    Object.keys(
      s.clients.at(-1)!.calls.find((call) => call.method === "pair")!.params as object,
    ).sort(),
    ["clientId", "invitation"],
  );
});
test("成功连接保存归属，后台重启重新封存并恢复同一 owner", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const saved = copy(s.store.saved!);
  s.clients[0]!.close();
  const restarted = setup(saved);
  await restarted.connection.ready();
  await tick();
  assert.equal(restarted.library.freezeCount, 1);
  assert.equal(restarted.library.frozen, true);
  assert.equal((await restarted.connection.view()).mode, "desktop");
  assert.equal((await restarted.connection.view()).status, "connected");
  assert.equal(ownerKey(restarted.store.saved!.credential!), ownerKey(saved.credential!));
  assert.equal(restarted.clients[0]!.calls[0]!.method, "resume");
});
test("断线保持桌面归属和封存，不自动写 A或恢复独立", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const original = copy(s.library.data);
  s.clients[0]!.lose();
  assert.equal((await s.connection.view()).status, "reconnecting");
  assert.equal((await s.connection.view()).mode, "desktop");
  assert.equal(s.library.frozen, true);
  assert.equal(s.library.resumeCount, 0);
  s.setPrepare((client) => {
    client.resumeError = new LmcpError("DESKTOP_NOT_RUNNING", "not running");
  });
  await assert.rejects(s.connection.capture(capture(), s.connection.ticket()));
  assert.deepEqual(s.library.data, original);
  assert.equal(s.library.resumeCount, 0);
});
test("明确离线断开允许恢复 A，记录未确认但保留配对凭据", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  s.clients[0]!.confirmDisconnect = false;
  const original = copy(s.library.data);
  await s.connection.disconnect();
  const view = await s.connection.view();
  assert.equal(view.mode, "independent");
  assert.equal(view.status, "independent");
  assert.equal(view.disconnectUnconfirmed, true);
  assert.equal(s.library.frozen, false);
  assert.equal(s.library.resumeCount, 1);
  assert.deepEqual(s.library.data, original);
  assert.equal(s.store.saved!.desired, "independent");
  assert.equal(s.store.saved!.credential!.pairingToken, PAIR_SECRET);
});
test("UI连接状态不包含会话令牌、配对令牌、来源资料或采集载荷", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  await s.connection.capture(capture(), s.connection.ticket());
  const visible = JSON.stringify(await s.connection.view());
  for (const forbidden of [
    SECRET,
    PAIR_SECRET,
    "originalSentence",
    "archiveId",
    "operations",
    "pairingToken",
    "sessionToken",
  ])
    assert.equal(visible.includes(forbidden), false, forbidden);
});
test("采集发送前原 owner和mutation已持久化，不增加独立事实", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const params = capture(),
    original = copy(s.library.data);
  s.clients[0]!.beforeCapture = () => {
    const op = s.store.saved!.operations.find(
      (op) => op.params.mutationId === params.mutationId,
    );
    assert.ok(op);
    assert.equal(op.status, "unknown");
    assert.equal(op.owner, ownerKey(s.store.saved!.credential!));
  };
  const receipt = await s.connection.capture(params, s.connection.ticket());
  assert.equal(receipt.entity.entityId, params.eventId);
  assert.equal(s.store.saved!.operations[0]!.status, "applied");
  assert.deepEqual(s.library.data, original);
});
test("未知采集先查回执，再以原mutation和原载荷重试", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const params = capture(),
    client = s.clients[0]!;
  client.captureError = new LmcpError("TIMEOUT", "timeout", {
    resultUnknown: true,
  });
  await assert.rejects(s.connection.capture(params, s.connection.ticket()));
  assert.equal(s.store.saved!.operations[0]!.status, "unknown");
  client.captureError = null;
  await s.connection.capture(copy(params), s.connection.ticket());
  assert.deepEqual(
    client.calls
      .filter((call) => ["recordEncounter", "getOperation"].includes(call.method))
      .map((call) => call.method),
    ["recordEncounter", "getOperation", "recordEncounter"],
  );
  const writes = client.calls
    .filter((call) => call.method === "recordEncounter")
    .map((call) => call.params);
  assert.deepEqual(writes, [params, params]);
});
test("已提交但ACK丢失只查询完整原回执，不重复发送", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const params = capture(),
    client = s.clients[0]!;
  client.captureError = new LmcpError("DISCONNECTED", "lost", {
    resultUnknown: true,
  });
  await assert.rejects(s.connection.capture(params, s.connection.ticket()));
  client.captureError = null;
  client.operation = {
    mutationId: params.mutationId,
    method: "recordEncounter",
    status: "applied",
    result: result(params),
  };
  const restored = await s.connection.capture(copy(params), s.connection.ticket());
  assert.equal(restored.entity.entityId, params.eventId);
  assert.equal(
    client.calls.filter((call) => call.method === "recordEncounter").length,
    1,
  );
});
for (const errorCode of [
  "DEADLINE_EXCEEDED",
  "HOST_UNAVAILABLE",
  "SESSION_EXPIRED",
  "FORBIDDEN",
  "FUTURE_WRITE_ERROR",
]) {
  test(`${errorCode} 不将原采集标为拒绝，恢复后只查原回执`, async () => {
    const s = setup();
    await s.connection.connect(invitation());
    const params = capture(),
      client = s.clients[0]!;
    // 模拟不同来源的错误，即使未附 resultUnknown，控制层也不能把非业务错误变成终态。
    client.captureError = new LmcpError(errorCode, "写入结果未确认");
    await assert.rejects(s.connection.capture(params, s.connection.ticket()), /尚未确认/);
    assert.equal(s.store.saved!.operations[0]!.status, "unknown");
    assert.deepEqual(s.store.saved!.operations[0]!.params, params);
    client.captureError = null;
    client.operation = {
      mutationId: params.mutationId,
      method: "recordEncounter",
      status: "applied",
      result: result(params),
    };
    const receipt = await s.connection.capture(copy(params), s.connection.ticket());
    assert.equal(receipt.entity.entityId, params.eventId);
    assert.equal(s.store.saved!.operations[0]!.status, "applied");
    assert.deepEqual(
      client.calls
        .filter((call) => ["recordEncounter", "getOperation"].includes(call.method))
        .map((call) => call.method),
      ["recordEncounter", "getOperation"],
    );
    assert.deepEqual(client.calls.at(-1)!.params, {
      mutationId: params.mutationId,
    });
  });
}
test("明确业务拒绝结束采集，但显式未知标记不得被同名错误覆盖", async () => {
  for (const unknown of [false, true]) {
    const s = setup();
    await s.connection.connect(invitation());
    const params = capture(),
      client = s.clients[0]!;
    client.captureError = new LmcpError("INVALID_OCCURRENCE_RANGE", "范围无效", {
      resultUnknown: unknown,
    });
    await assert.rejects(s.connection.capture(params, s.connection.ticket()));
    assert.equal(s.store.saved!.operations[0]!.status, unknown ? "unknown" : "rejected");
    client.captureError = null;
    client.operation = {
      mutationId: params.mutationId,
      method: "recordEncounter",
      status: "applied",
      result: result(params),
    };
    if (unknown) {
      await s.connection.capture(copy(params), s.connection.ticket());
      assert.equal(s.store.saved!.operations[0]!.status, "applied");
    } else {
      await assert.rejects(
        s.connection.capture(copy(params), s.connection.ticket()),
        /拒绝/,
      );
      assert.equal(
        client.calls.filter((call) => call.method === "getOperation").length,
        0,
      );
    }
    assert.equal(
      client.calls.filter((call) => call.method === "recordEncounter").length,
      1,
    );
  }
});
test("同mutation并发不同载荷拒绝，同载荷只发送一次", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const params = capture(),
    gate = deferred<RecordEncounterResult>(),
    client = s.clients[0]!;
  client.captureGate = gate;
  const first = s.connection.capture(params, s.connection.ticket());
  await tick();
  const changed = copy(params);
  changed.data.annotation.note = "different";
  const rejected = assert.rejects(
    s.connection.capture(changed, s.connection.ticket()),
    /更改|复用|内容|不一致/,
  );
  const same = s.connection.capture(copy(params), s.connection.ticket());
  gate.resolve(result(params));
  await first;
  await same;
  await rejected;
  assert.equal(
    client.calls.filter((call) => call.method === "recordEncounter").length,
    1,
  );
});
test("同payload键顺序不同可恢复同回执，不能误判成更改意图", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const params = capture();
  await s.connection.capture(params, s.connection.ticket());
  const reordered = {
    notebookId: params.notebookId,
    data: copy(params.data),
    eventId: params.eventId,
    mutationId: params.mutationId,
  };
  assert.equal(
    (await s.connection.capture(reordered, s.connection.ticket())).entity.entityId,
    params.eventId,
  );
});
test("显式断开后旧owner迟到回执只留原操作日志，不投影到独立 A", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const params = capture(),
    gate = deferred<RecordEncounterResult>();
  s.clients[0]!.captureGate = gate;
  const pending = s.connection.capture(params, s.connection.ticket());
  await tick();
  await s.connection.disconnect();
  gate.resolve(result(params));
  await assert.rejects(pending);
  assert.equal((await s.connection.view()).mode, "independent");
  assert.equal((await s.connection.view()).status, "independent");
  assert.equal(s.library.frozen, false);
  assert.equal(s.store.saved!.operations[0]!.status, "applied");
  assert.equal(s.store.saved!.operations[0]!.params.eventId, params.eventId);
});
test("显式断开完成后，旧恢复失败不能覆盖独立状态", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  s.clients[0]!.lose();
  const gate = deferred<void>();
  s.setPrepare((client) => {
    client.resumeGate = gate;
  });
  const recovering = s.connection.reconnect();
  await tick();
  await s.connection.disconnect();
  gate.reject(new Error("late resume refusal"));
  await assert.rejects(recovering);
  assert.equal((await s.connection.view()).mode, "independent");
  assert.equal((await s.connection.view()).status, "independent");
  assert.equal(s.library.frozen, false);
});
test("IndexedConnectionStore控制记录经新存储实例恢复，视图仍不会暴露受保护令牌", async () => {
  const name = `leximeet-control-test-${crypto.randomUUID()}`,
    store = new IndexedConnectionStore(name),
    library = new Ownership();
  const connection = new DesktopConnection({
    store,
    library,
    createClient: (fn) => new ModelClient(fn) as unknown as LmcpClient,
  });
  await connection.connect(invitation());
  const restored = await new IndexedConnectionStore(name).load();
  assert.equal(restored!.desired, "desktop");
  assert.equal(restored!.credential!.pairingToken, PAIR_SECRET);
  assert.equal(restored!.archiveId, ID);
});

test("恢复采集回执不能以相同eventId替换原语境、注释或来源", async () => {
  for (const field of [
    "surface",
    "originalSentence",
    "savedExcerpt",
    "annotation",
    "source",
    "occurrenceRanges",
    "excerptRanges",
  ] as const) {
    const s = setup();
    await s.connection.connect(invitation());
    const params = capture(),
      client = s.clients[0]!;
    client.captureError = new LmcpError("TIMEOUT", "timeout", {
      resultUnknown: true,
    });
    await assert.rejects(s.connection.capture(params, s.connection.ticket()));
    client.captureError = null;
    const forged = result(params),
      data = forged.entity.data;
    if (field === "annotation") data.annotation.note = "replaced";
    else if (field === "source") data.source.title = "other";
    else if (field === "occurrenceRanges" || field === "excerptRanges")
      data[field] = [{ start: 0, end: 6 }];
    else data[field] = "other";
    client.operation = {
      mutationId: params.mutationId,
      method: "recordEncounter",
      status: "applied",
      result: forged,
    };
    await assert.rejects(
      s.connection.capture(copy(params), s.connection.ticket()),
      /身份|内容|不一致/,
    );
    assert.equal(
      client.calls.filter((call) => call.method === "recordEncounter").length,
      1,
      field,
    );
    assert.equal(s.store.saved!.operations[0]!.status, "unknown", field);
  }
});
test("恢复时不能把其他方法的回执解释成采集成功或重发采集", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const params = capture(),
    client = s.clients[0]!;
  client.captureError = new LmcpError("TIMEOUT", "timeout", {
    resultUnknown: true,
  });
  await assert.rejects(s.connection.capture(params, s.connection.ticket()));
  client.captureError = null;
  client.operation = {
    mutationId: params.mutationId,
    method: "openInDesktop",
    status: "applied",
    result: { opened: true },
  };
  await assert.rejects(
    s.connection.capture(copy(params), s.connection.ticket()),
    /方法|不一致/,
  );
  assert.equal(
    client.calls.filter((call) => call.method === "recordEncounter").length,
    1,
  );
  assert.equal(s.store.saved!.operations[0]!.status, "unknown");
});

test("控制库存储单次失败后重试，采集仍须先持久化原意图再发送", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const params = capture(),
    client = s.clients[0]!,
    save = s.store.save.bind(s.store);
  let failNext = true;
  s.store.save = async (value) => {
    if (failNext) {
      failNext = false;
      throw new Error("temporary control store failure");
    }
    await save(value);
  };
  await assert.rejects(
    s.connection.capture(params, s.connection.ticket()),
    /temporary|保存/,
  );
  assert.equal(
    client.calls.filter((call) => call.method === "recordEncounter").length,
    0,
  );
  client.beforeCapture = () => {
    const op = s.store.saved!.operations.find(
      (item) => item.params.mutationId === params.mutationId,
    );
    assert.ok(op, "重试发送前，原采集意图必须已经持久化");
    assert.deepEqual(op.params, params);
  };
  const receipt = await s.connection.capture(copy(params), s.connection.ticket());
  assert.equal(receipt.entity.entityId, params.eventId);
  assert.equal(
    client.calls.filter((call) => call.method === "recordEncounter").length,
    1,
  );
  assert.equal(s.store.saved!.operations[0]!.status, "applied");
});

test("接管意图落盘前不安装Desktop归属，失败不封存A且可重新配对", async () => {
  const s = setup();
  await s.connection.ready();
  const save = s.store.save.bind(s.store),
    gate = deferred<void>();
  let intercept = true;
  s.store.save = async (value) => {
    if (intercept && value.desired === "desktop") {
      intercept = false;
      await gate.promise;
    }
    await save(value);
  };
  const pending = s.connection.connect(invitation());
  await tick();
  assert.equal(s.connection.connectedMode, false);
  assert.equal(s.library.freezeCount, 0);
  assert.equal((await s.connection.view()).mode, "independent");
  gate.reject(new Error("control commit failed"));
  await assert.rejects(pending);
  assert.equal(s.connection.connectedMode, false);
  assert.equal(s.library.frozen, false);
  assert.equal(s.library.freezeCount, 0);
  assert.equal(s.store.saved!.desired, "independent");
  assert.equal(s.store.saved!.credential, null);
  await s.connection.connect(invitation());
  assert.equal(s.connection.connectedMode, true);
  assert.equal(s.library.frozen, true);
});
test("断开意图保存失败时保持B归属与封存A，重试成功后才恢复A", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const save = s.store.save.bind(s.store);
  let fail = true;
  s.store.save = async (value) => {
    if (fail && value.desired === "independent") {
      fail = false;
      throw new Error("disconnect commit failed");
    }
    await save(value);
  };
  await assert.rejects(s.connection.disconnect(), /disconnect commit/);
  assert.equal(s.connection.connectedMode, true);
  assert.equal(s.library.frozen, true);
  assert.equal(s.library.resumeCount, 0);
  assert.equal(s.store.saved!.desired, "desktop");
  await s.connection.disconnect();
  assert.equal(s.connection.connectedMode, false);
  assert.equal(s.library.frozen, false);
  assert.equal(s.store.saved!.desired, "independent");
  assert.equal(s.store.saved!.archiveId, null);
});
test("独立恢复完成但清理记录暂时失败，保留可恢复标识而非假成功", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const save = s.store.save.bind(s.store);
  let fail = true;
  s.store.save = async (value) => {
    if (fail && value.desired === "independent" && value.archiveId === null) {
      fail = false;
      throw new Error("cleanup commit failed");
    }
    await save(value);
  };
  await assert.rejects(s.connection.disconnect(), /cleanup commit/);
  assert.equal(s.connection.connectedMode, false);
  assert.equal(s.library.frozen, false);
  assert.equal(s.store.saved!.archiveId, ID);
  await s.connection.disconnect();
  assert.equal(s.store.saved!.archiveId, null);
  assert.equal((await s.connection.view()).status, "independent");
});
test("首次控制记录写入失败后ready可重新加载，不永久沿失败Promise停止", async () => {
  const s = setup(),
    save = s.store.save.bind(s.store);
  let fail = true;
  s.store.save = async (value) => {
    if (fail) {
      fail = false;
      throw new Error("initial commit failed");
    }
    await save(value);
  };
  await assert.rejects(s.connection.ready(), /initial commit/);
  await s.connection.ready();
  assert.equal(s.store.saved!.desired, "independent");
  assert.equal(s.library.freezeCount, 0);
});
test("归属切换落盘期间原owner回执晚到，保存队列不会覆盖终态或新归属", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const params = capture(),
    reply = deferred<RecordEncounterResult>();
  s.clients[0]!.captureGate = reply;
  const pending = s.connection.capture(params, s.connection.ticket());
  await tick();
  const save = s.store.save.bind(s.store),
    commit = deferred<void>();
  let intercept = true;
  s.store.save = async (value) => {
    if (intercept && value.desired === "independent") {
      intercept = false;
      await commit.promise;
    }
    await save(value);
  };
  const disconnecting = s.connection.disconnect();
  await tick();
  assert.equal(s.connection.connectedMode, true);
  reply.resolve(result(params));
  await tick();
  commit.resolve();
  await disconnecting;
  await assert.rejects(pending);
  assert.equal(s.store.saved!.desired, "independent");
  assert.equal(s.store.saved!.operations[0]!.status, "applied");
  assert.equal(s.store.saved!.operations[0]!.result!.entity.entityId, params.eventId);
});
test("readContext只公开有效租期修订，失联或过期立即锁定", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const context = s.connection.readContext();
  assert.ok(context);
  assert.deepEqual(Object.keys(context).sort(), ["readLeaseUntil", "revision"]);
  s.clients[0]!.workspaceRevision = "2";
  await s.connection.heartbeat();
  assert.equal(s.connection.readContext()!.revision, "2");
  s.clients[0]!.readLeaseUntil = new Date(Date.now() - 1).toISOString();
  assert.equal(s.connection.readContext(), null);
  s.clients[0]!.lose();
  assert.equal(s.connection.readContext(), null);
  assert.equal(s.library.frozen, true);
});
test("会话续租并发只调用一次，授权失败后锁定且不恢复A", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const client = s.clients[0]!,
    gate = deferred<void>();
  client.expiresAt = new Date(Date.now() + 30_000).toISOString();
  client.renewGate = gate;
  const first = s.connection.active(),
    second = s.connection.active();
  await tick();
  assert.equal(client.calls.filter((item) => item.method === "renew").length, 1);
  gate.resolve();
  await first;
  await second;
  client.renewGate = null;
  client.expiresAt = new Date(Date.now() + 30_000).toISOString();
  client.renewError = new LmcpError("UNAUTHORIZED", "revoked");
  await assert.rejects(s.connection.active(), /revoked/);
  assert.equal((await s.connection.view()).status, "reconnecting");
  assert.equal(s.connection.readContext(), null);
  assert.equal(s.library.frozen, true);
  assert.equal(s.library.resumeCount, 0);
});
test("连续恢复失败不会通过相同状态广播触发再次恢复循环", async () => {
  const s = setup();
  let changes = 0;
  const connection = new DesktopConnection({
    store: s.store,
    library: s.library,
    createClient: (onDisconnect) => s.factory(onDisconnect),
    changed: () => {
      changes++;
    },
  });
  await connection.connect(invitation());
  s.clients[0]!.lose();
  const before = changes;
  s.setPrepare((client) => {
    client.resumeError = new LmcpError("DESKTOP_NOT_RUNNING", "offline");
  });
  await assert.rejects(connection.heartbeat());
  await assert.rejects(connection.heartbeat());
  await assert.rejects(connection.heartbeat());
  assert.equal(changes, before);
  assert.equal(s.clients.length, 2);
  assert.equal(s.library.resumeCount, 0);
});

test("已收到采集成功回执但本机终态保存失败，重试先补持久化且不重复写桌面", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const params = capture(),
    save = s.store.save.bind(s.store);
  let fail = true;
  s.store.save = async (value) => {
    if (
      fail &&
      value.operations.some(
        (op) => op.params.mutationId === params.mutationId && op.status === "applied",
      )
    ) {
      fail = false;
      throw new Error("receipt commit failed");
    }
    await save(value);
  };
  await assert.rejects(s.connection.capture(params, s.connection.ticket()));
  assert.equal(s.store.saved!.operations[0]!.status, "unknown");
  const restored = await s.connection.capture(copy(params), s.connection.ticket());
  assert.equal(restored.entity.entityId, params.eventId);
  assert.equal(s.store.saved!.operations[0]!.status, "applied");
  assert.equal(
    s.clients[0]!.calls.filter((item) => item.method === "recordEncounter").length,
    1,
  );
});

test("只读租期过期后首次悬浮球读取重取工作区，无需侧栏轮询或更换会话", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const client = s.clients[0]!;
  client.readLeaseUntil = new Date(Date.now() - 1).toISOString();
  assert.equal(s.connection.readContext(), null);
  const staleView = await s.connection.view();
  assert.equal(staleView.dictionaryEdition, undefined);
  assert.equal(staleView.account, undefined);
  assert.equal(await s.connection.active(), client);
  assert.ok(s.connection.readContext());
  assert.equal((await s.connection.view()).dictionaryEdition, "core-text");
  assert.equal(client.calls.filter((c) => c.method === "getWorkspace").length, 2);
  assert.equal(client.calls.filter((c) => c.method === "renew").length, 0);
  assert.equal(client.calls.filter((c) => c.method === "resume").length, 0);
  assert.equal(s.library.freezeCount, 1);
  assert.equal(s.library.resumeCount, 0);
});
test("读取租期不足五秒时并发active共用一次工作区读取", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const client = s.clients[0]!,
    gate = deferred<void>();
  client.readLeaseUntil = new Date(Date.now() + 1_000).toISOString();
  client.workspaceGate = gate;
  const first = s.connection.active(),
    second = s.connection.active();
  await tick();
  assert.equal(client.calls.filter((c) => c.method === "getWorkspace").length, 2);
  gate.resolve();
  assert.equal(await first, client);
  assert.equal(await second, client);
  assert.ok(Date.parse(s.connection.readContext()!.readLeaseUntil) > Date.now() + 20_000);
  assert.equal(client.calls.filter((c) => c.method === "renew").length, 0);
});
test("工作区续读失败锁定桌面资料，不恢复独立A或暴露失效元数据", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const client = s.clients[0]!;
  client.readLeaseUntil = new Date(Date.now() - 1).toISOString();
  client.workspaceError = new LmcpError("UNAUTHORIZED", "workspace revoked");
  await assert.rejects(s.connection.active(), /workspace revoked/);
  const view = await s.connection.view();
  assert.equal(view.mode, "desktop");
  assert.equal(view.status, "reconnecting");
  assert.equal(view.dictionaryEdition, undefined);
  assert.equal(view.account, undefined);
  assert.equal(s.connection.readContext(), null);
  assert.equal(s.library.frozen, true);
  assert.equal(s.library.resumeCount, 0);
  await assert.rejects(s.connection.capture(capture(), s.connection.ticket()));
  assert.equal(client.calls.filter((c) => c.method === "recordEncounter").length, 0);
});
test("工作区响应未授予有效读取租期时停止使用缓存，不返回假成功", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const client = s.clients[0]!;
  client.readLeaseUntil = new Date(Date.now() - 1).toISOString();
  client.workspaceLease = client.readLeaseUntil;
  await assert.rejects(s.connection.active(), /读取租期未恢复/);
  assert.equal((await s.connection.view()).status, "reconnecting");
  assert.equal(s.connection.readContext(), null);
  assert.equal(s.library.resumeCount, 0);
});
test("续读在途显式断开后旧owner响应不得重新投影桌面资料", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const client = s.clients[0]!,
    gate = deferred<void>();
  client.workspaceGate = gate;
  client.readLeaseUntil = new Date(Date.now() - 1).toISOString();
  const pending = s.connection.active();
  await tick();
  await s.connection.disconnect();
  gate.resolve();
  await assert.rejects(pending, /归属已变化|连接已切换/);
  const view = await s.connection.view();
  assert.equal(view.mode, "independent");
  assert.equal(view.status, "independent");
  assert.equal(view.account, undefined);
  assert.equal(view.dictionaryEdition, undefined);
  assert.equal(s.connection.readContext(), null);
  assert.equal(s.library.frozen, false);
});
test("heartbeat变更重取完整元数据，较早getChanges修订不覆盖更新的工作区", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const client = s.clients[0]!;
  client.workspaceRevision = "2";
  client.afterChanges = () => {
    client.workspaceRevision = "3";
    client.dictionaryEdition = "lite-text";
    client.account = { status: "signed-out", source: "desktop" };
  };
  await s.connection.heartbeat();
  assert.equal(s.connection.readContext()!.revision, "3");
  const view = await s.connection.view();
  assert.equal(view.dictionaryEdition, "lite-text");
  assert.deepEqual(view.account, { status: "signed-out", source: "desktop" });
  assert.equal(client.calls.filter((c) => c.method === "getWorkspace").length, 2);
});
test("迟到的无变更heartbeat不得覆盖并发续读拿到的新工作区元数据", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const client = s.clients[0]!,
    gate = deferred<void>();
  client.changeGate = gate;
  const heartbeat = s.connection.heartbeat();
  await tick();
  client.workspaceRevision = "3";
  client.dictionaryEdition = "lite-text";
  client.readLeaseUntil = new Date(Date.now() - 1).toISOString();
  await s.connection.active();
  assert.equal(s.connection.readContext()!.revision, "3");
  gate.resolve();
  await heartbeat;
  assert.equal(s.connection.readContext()!.revision, "3");
  assert.equal((await s.connection.view()).dictionaryEdition, "lite-text");
});
test("heartbeat工作区重取失败锁定旧账号词库，而非只改变修订假装刷新", async () => {
  const s = setup();
  await s.connection.connect(invitation());
  const client = s.clients[0]!;
  client.workspaceRevision = "2";
  client.workspaceError = new LmcpError("WORKSPACE_CHANGED", "new owner required");
  await assert.rejects(s.connection.heartbeat(), /new owner required/);
  const view = await s.connection.view();
  assert.equal(view.status, "reconnecting");
  assert.equal(view.mode, "desktop");
  assert.equal(view.dictionaryEdition, undefined);
  assert.equal(view.account, undefined);
  assert.equal(s.connection.readContext(), null);
  assert.equal(s.library.resumeCount, 0);
});

test("未知 pair 先持久原邀请且保持封存，Worker 重启沿同票恢复而非新邀请", async () => {
  const s = setup();
  s.setPrepare((client) => {
    client.pairError = new LmcpError("TIMEOUT", "ACK 丢失", {
      resultUnknown: true,
    });
  });
  const original = invitation();
  await assert.rejects(s.connection.connect(original));
  assert.equal(s.library.frozen, true);
  assert.equal(s.store.saved!.desired, "desktop");
  assert.deepEqual(s.store.saved!.pendingPair, original);
  assert.equal(s.store.saved!.credential, null);
  const restarted = setup(copy(s.store.saved!));
  await restarted.connection.ready();
  await tick();
  assert.equal((await restarted.connection.view()).status, "connected");
  assert.deepEqual(
    (restarted.clients[0]!.calls.find((call) => call.method === "pair")!.params as any)
      .invitation,
    original,
  );
  assert.equal(restarted.store.saved!.pendingPair, null);
  assert.equal(restarted.library.frozen, true);
});
test("未知 pair 后 Desktop 明确结束原邀请恢复 A，撤权或网络故障仍封存", async () => {
  for (const code of ["CONNECTION_ENDED", "PAIRING_REVOKED", "DESKTOP_NOT_RUNNING"]) {
    const s = setup();
    s.setPrepare((client) => {
      client.pairError = new LmcpError("TIMEOUT", "ACK 丢失");
    });
    await assert.rejects(s.connection.connect(invitation()));
    const restarted = setup(copy(s.store.saved!));
    restarted.setPrepare((client) => {
      client.pairError = new LmcpError(code, "原票据已终止或暂不可用");
    });
    await restarted.connection.ready();
    await tick();
    assert.equal(
      (await restarted.connection.view()).mode,
      code === "CONNECTION_ENDED" ? "independent" : "desktop",
    );
    assert.equal(restarted.library.frozen, code !== "CONNECTION_ENDED");
  }
});
