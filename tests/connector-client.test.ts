import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import fixtures from "../lib/connector/contracts/contracts.json" with { type: "json" };
import snapshot from "../lib/connector/contracts/snapshot.json" with { type: "json" };
import {
  assertApiCompatibility,
  assertCaptureSemantics,
  assertHelloCompatibility,
  LMCP_CONTRACT,
  LMCP_METHODS,
  validFrame,
  validValue,
} from "../lib/connector/protocol.ts";
import { LmcpClient } from "../lib/connector/client.ts";
import { NativeMessagingTransport } from "../lib/connector/transport.ts";
import { LmcpError } from "../lib/connector/types.ts";
import type {
  HostRequest,
  RequestFrame,
  RecordEncounterParams,
} from "../lib/connector/types.ts";
import type { NativePort } from "../lib/connector/transport.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-03T00:00:00.000Z");
const clone = <T>(value: T): T => structuredClone(value);
function fixture(name: string): any {
  return clone(fixtures.find((item) => item.name === name)!.value);
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function port(): NativePort & {
  sent: any[];
  reply(message: unknown): void;
  closed(): void;
  responder: ((message: any) => void) | null;
} {
  const messages: ((value: unknown) => void)[] = [],
    disconnects: (() => void)[] = [];
  return {
    sent: [],
    responder: null,
    onMessage: {
      addListener(listener) {
        messages.push(listener);
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnects.push(listener);
      },
    },
    postMessage(message) {
      this.sent.push(clone(message));
      queueMicrotask(() => this.responder?.(message));
    },
    disconnect() {},
    reply(message) {
      for (const listener of messages) listener(clone(message));
    },
    closed() {
      for (const listener of disconnects) listener();
    },
  };
}
function service(
  options: {
    mutate?: (frame: RequestFrame, result: any) => any;
    drop?: string;
    timeoutMs?: number;
  } = {},
) {
  const ports: ReturnType<typeof port>[] = [],
    hostNames: string[] = [];
  const native = new NativeMessagingTransport({
    connectNative(name) {
      hostNames.push(name);
      const p = port();
      ports.push(p);
      p.responder = (frame) => {
        if (frame.kind === "host-response" || frame.method === options.drop) return;
        const response = fixture(`${frame.method}-response`);
        response.requestId = frame.requestId;
        response.connectionId = frame.connectionId;
        const result = response.result;
        if (frame.method === "hello") {
          result.connectionId = frame.connectionId;
          result.maxFrameBytes = 262144;
          result.methods = LMCP_METHODS.map((spec) => spec.method);
          result.capabilities = [
            ...LMCP_CONTRACT.requiredCapabilities,
            "desktop.notebooks/1",
            "desktop.encounters/1",
            "host.registration/1",
          ];
        }
        if (["pair", "resumeSession", "renewSession"].includes(frame.method)) {
          result.expiresAt = new Date(NOW + 3_600_000).toISOString();
          result.readLeaseUntil = new Date(NOW + 30_000).toISOString();
        }
        if (frame.method === "registerHost") {
          result.capabilities = frame.params.capabilities;
          result.expiresAt = new Date(NOW + 600_000).toISOString();
        }
        if (frame.method === "getOperation") {
          response.result = {
            mutationId: frame.params.mutationId,
            status: "applied",
            method: "recordEncounter",
            result: fixture("recordEncounter-response").result,
          };
        }
        const changed = options.mutate?.(frame, response) ?? response;
        p.reply(changed);
      };
      return p;
    },
  });
  if (options.timeoutMs) {
    const send = native.request.bind(native);
    native.request = (frame) => send(frame, options.timeoutMs);
  }
  const client = new LmcpClient({
    transport: native,
    now: () => NOW,
    clientInstanceId: UUID,
  });
  return {
    client,
    native,
    ports,
    hostNames,
    get frames() {
      return ports
        .flatMap((p) => p.sent)
        .filter((frame) => frame.kind !== "host-response");
    },
  };
}
async function paired(options: Parameters<typeof service>[0] = {}) {
  const fixture = service(options);
  await fixture.client.pair(
    { invitationId: UUID, invitationToken: "i".repeat(43) },
    UUID,
  );
  return fixture;
}
function code(expected: string, unknown?: boolean) {
  return (error: unknown) =>
    error instanceof LmcpError &&
    error.code === expected &&
    (unknown === undefined || error.resultUnknown === unknown);
}

test("冻结 Schema 通过全部 126 个官方正反样例，拒绝旧方法和分数伪造", () => {
  for (const item of fixtures)
    assert.equal(validFrame(item.schema as any, item.value), item.valid, item.name);
  assert.equal(fixtures.length, 126);
  assert.equal(validValue("Timestamp", "2026-02-30T00:00:00.000Z", "reading"), false);
  assert.equal(validValue("Day", "2026-02-30", "reading"), false);
});
test("打包 Schema 快照与固定合同逐字节一致，不运行时借用对端摘要", () => {
  for (const item of snapshot.files) {
    const file = new URL(
      `../lib/connector/contracts/${item.path.split("/").at(-1)}`,
      import.meta.url,
    );
    assert.equal(
      createHash("sha256").update(readFileSync(file)).digest("hex"),
      item.sha256,
      item.path,
    );
  }
  assert.equal(snapshot.contractDigest, LMCP_CONTRACT.digest);
});
test("原生 hello、pair 与读词卡使用1.0.0信封，凭据不混入 params", async () => {
  const s = await paired();
  const workspace = await s.client.getWorkspace();
  assert.equal(s.hostNames[0], "org.leximeet.browser");
  assert.equal(s.frames[0].params.contractDigest, LMCP_CONTRACT.digest);
  assert.equal(s.frames[0].params.connectionId, s.frames[0].connectionId);
  assert.equal(s.frames[0].authorization, undefined);
  assert.equal(workspace.account.source, "desktop");
  assert.equal(workspace.cloudSync, "disabled");
  assert.equal(s.frames.at(-1).authorization.sessionToken.length, 43);
  assert.deepEqual(s.frames.at(-1).params, {});
  s.client.close();
});
test("旧预发布候选或必需能力缺失明确拒绝连接，不协商旧格式", async () => {
  const cases = [
    {
      code: "CONTRACT_MISMATCH",
      mutate: (frame: RequestFrame, response: any) => {
        if (frame.method === "hello") response.result.contractVersion = "1.0.0-rc.4";
        return response;
      },
    },
    {
      code: "CAPABILITY_UNAVAILABLE",
      mutate: (frame: RequestFrame, response: any) => {
        if (frame.method === "hello")
          response.result.capabilities = ["lmcp.connection/1"];
        return response;
      },
    },
  ];
  for (const item of cases) {
    const s = service({ mutate: item.mutate });
    await assert.rejects(s.client.hello(), code(item.code));
    assert.equal(s.client.connectionId, null);
    assert.equal(s.frames.length, 1);
  }
});
test("正式1.x不同摘要与更高服务版本可协商，后续读写使用同一服务版本", async () => {
  for (const peerVersion of ["1.0.1", "1.2.0"]) {
    const s = await paired({
      mutate(frame, response) {
        response.apiVersion = peerVersion;
        if (frame.method === "hello") {
          response.result.apiVersion = peerVersion;
          response.result.contractVersion = "1.2.3";
          response.result.contractDigest = "a".repeat(64);
          response.result.capabilities.push("future.optional/1");
          response.result.methods.push("futureOptional");
        }
        return response;
      },
    });
    const hello = await s.client.hello();
    assert.equal(hello.apiVersion, peerVersion);
    assert.equal(hello.contractDigest, "a".repeat(64));
    // 请求始终声明本端真正构建身份，不能抄取对端摘要来冒充。
    assert.equal(s.frames[0].params.contractDigest, LMCP_CONTRACT.digest);
    assert.equal(s.frames[0].params.contractVersion, LMCP_CONTRACT.version);
    assert.equal(s.frames[0].params.minApiVersion, LMCP_CONTRACT.apiVersion);
    assert.equal((await s.client.getWorkspace()).cloudSync, "disabled");
    const receipt = await s.client.recordEncounter(
      fixture("recordEncounter-request").params,
    );
    assert.deepEqual(receipt, fixture("recordEncounter-response").result);
    s.client.close();
  }
});
test("API按三段整数比较，拒绝不满足major或最低版本的服务", () => {
  for (const [actual, minimum] of [
    ["1.0.1", "1.0.0"],
    ["1.2.0", "1.1.999"],
    ["1.10.0", "1.9.0"],
    ["1.0.9007199254740993", "1.0.9007199254740992"],
  ] as const)
    assert.doesNotThrow(() => assertApiCompatibility(actual, minimum));
  for (const [actual, minimum] of [
    ["2.0.0", "1.0.0"],
    ["0.9.0", "1.0.0"],
    ["1.0.99", "1.1.0"],
    ["1.9.99", "1.10.0"],
    ["1.0.9007199254740992", "1.0.9007199254740993"],
    ["1.01.0", "1.0.0"],
    ["1.0.0-rc.1", "1.0.0"],
  ] as const)
    assert.throws(
      () => assertApiCompatibility(actual, minimum),
      code("UNSUPPORTED_VERSION"),
    );
});
test("预发布只允许相同合同版本和摘要，API仍满足major与最低版本", () => {
  const peer = fixture("hello-response").result;
  peer.methods = LMCP_METHODS.map((spec) => spec.method);
  peer.capabilities = [...LMCP_CONTRACT.requiredCapabilities];
  peer.contractVersion = "1.0.0-rc.1";
  const local = { ...LMCP_CONTRACT, version: peer.contractVersion };
  assert.doesNotThrow(() => assertHelloCompatibility(peer, local));
  assert.doesNotThrow(() =>
    assertHelloCompatibility({ ...peer, apiVersion: "1.0.1" }, local),
  );
  for (const altered of [
    { ...peer, contractDigest: "a".repeat(64) },
    { ...peer, contractVersion: "1.0.0-rc.2" },
    { ...peer, contractVersion: "1.0.0" },
  ])
    assert.throws(
      () => assertHelloCompatibility(altered, local),
      code("CONTRACT_MISMATCH"),
    );
  assert.throws(() => assertHelloCompatibility(peer), code("CONTRACT_MISMATCH"));
  assert.throws(
    () => assertHelloCompatibility(peer, { ...local, apiVersion: "1.1.0" }),
    code("UNSUPPORTED_VERSION"),
  );
});
test("缺必需方法仍拒绝；缺可选方法仅禁用相应功能", async () => {
  const missing = service({
    mutate(frame, response) {
      if (frame.method === "hello")
        response.result.methods = response.result.methods.filter(
          (name: string) => name !== "recordEncounter",
        );
      return response;
    },
  });
  await assert.rejects(missing.client.hello(), code("CAPABILITY_UNAVAILABLE"));
  assert.equal(missing.client.connectionId, null);
  const core = await paired({
    mutate(frame, response) {
      if (frame.method === "hello") {
        response.result.methods = LMCP_METHODS.filter((spec) => spec.required).map(
          (spec) => spec.method,
        );
        response.result.capabilities = [...LMCP_CONTRACT.requiredCapabilities];
      }
      return response;
    },
  });
  assert.equal((await core.client.getWorkspace()).cloudSync, "disabled");
  await assert.rejects(
    core.client.request("listNotebooks"),
    code("CAPABILITY_UNAVAILABLE"),
  );
  core.client.close();
});
test("hello结果连接身份和信封版本必须一致，协商后不能更换响应版本", async () => {
  for (const [expected, mutate] of [
    [
      "CONNECTION_MISMATCH",
      (response: any) => {
        response.result.connectionId = OTHER;
      },
    ],
    [
      "INVALID_RESPONSE",
      (response: any) => {
        response.result.apiVersion = "1.0.1";
      },
    ],
    [
      "INVALID_FRAME",
      (response: any) => {
        response.apiVersion = response.result.apiVersion = "2.0.0";
      },
    ],
  ] as const) {
    const s = service({
      mutate(frame, response) {
        if (frame.method === "hello") mutate(response);
        return response;
      },
    });
    await assert.rejects(s.client.hello(), code(expected));
    assert.equal(s.client.connectionId, null);
  }
  const s = await paired({
    mutate(frame, response) {
      response.apiVersion = frame.method === "getWorkspace" ? "1.0.2" : "1.0.1";
      if (frame.method === "hello") response.result.apiVersion = "1.0.1";
      return response;
    },
  });
  await assert.rejects(s.client.getWorkspace(), code("INVALID_RESPONSE", true));
  s.client.close();
});
test("owner 六字段、核心 scope 和只读租期必须与配对一致", async () => {
  for (const [expected, change] of [
    [
      "OWNER_MISMATCH",
      (result: any) => {
        result.owner.authorizationEpoch = "2";
      },
    ],
    [
      "OWNER_MISMATCH",
      (result: any) => {
        result.pairingCredential.workspaceId = OTHER;
      },
    ],
    [
      "INVALID_SESSION",
      (result: any) => {
        result.scopes = ["library:read"];
      },
    ],
    [
      "INVALID_SESSION",
      (result: any) => {
        result.readLeaseUntil = new Date(NOW + 31_000).toISOString();
      },
    ],
  ] as const) {
    const s = service({
      mutate(frame, response) {
        if (frame.method === "pair") change(response.result);
        return response;
      },
    });
    await assert.rejects(
      s.client.pair({ invitationId: UUID, invitationToken: "i".repeat(43) }, UUID),
      code(expected),
    );
    assert.equal(s.client.connected, false);
    s.client.close();
  }
});
test("请求拒绝未知字段和任意方法，反向能力未实现时不能声明", async () => {
  const s = await paired(),
    before = s.frames.length;
  await assert.rejects(
    s.client.request("getWorkspace", { private: true }),
    code("INVALID_FRAME"),
  );
  await assert.rejects(
    s.client.request("submitPracticeFeedback", {}),
    code("METHOD_UNAVAILABLE"),
  );
  await assert.rejects(
    s.client.registerHost(["browser.open-source/1"]),
    code("CAPABILITY_UNAVAILABLE"),
  );
  assert.equal(s.frames.length, before);
  s.client.close();
});
test("未知响应可选字段保留兼容，但严格请求只回传五个授权字段", async () => {
  const s = await paired({
    mutate(frame, response) {
      if (frame.method === "pair")
        response.result.authorization.futureLabel = "only-response";
      response.optionalTransport = true;
      return response;
    },
  });
  await s.client.getWorkspace();
  assert.deepEqual(
    Object.keys(s.frames.at(-1).authorization).sort(),
    [
      "sessionId",
      "sessionToken",
      "workspaceId",
      "generation",
      "authorizationEpoch",
    ].sort(),
  );
  s.client.close();
});
test("重建端口用新 connectionId 和 resume，旧端口 disconnect 不杀新会话", async () => {
  const s = await paired();
  const credential = s.client.session!;
  const saved = fixture("pair-response").result.pairingCredential;
  const old = s.ports[0]!,
    oldId = s.client.connectionId;
  s.client.close();
  await s.client.resume(saved);
  assert.notEqual(s.client.connectionId, oldId);
  old.closed();
  await s.client.getWorkspace();
  assert.equal(s.client.connected, true);
  assert.equal(s.frames.filter((frame) => frame.method === "resumeSession").length, 1);
  assert.equal(s.frames.at(-1).connectionId, s.client.connectionId);
  assert.equal(credential.owner.workspaceId, s.client.session!.owner.workspaceId);
  s.client.close();
});
test("重连不能换投 Desktop、工作区、世代或授权代次", async () => {
  for (const field of [
    "desktopInstanceId",
    "workspaceId",
    "generation",
    "authorizationEpoch",
  ] as const) {
    const s = service({
      mutate(frame, response) {
        if (frame.method === "resumeSession")
          response.result.owner[field] = field === "authorizationEpoch" ? "2" : OTHER;
        return response;
      },
    });
    const credential = fixture("pair-response").result.pairingCredential;
    if (field === "desktopInstanceId") credential.desktopInstanceId = OTHER;
    await assert.rejects(s.client.resume(credential), code("OWNER_MISMATCH"));
    s.client.close();
  }
});
test("断线立即锁定会话，不自动写独立库或自动重连", async () => {
  const s = await paired();
  s.ports[0]!.closed();
  await assert.rejects(
    s.client.recordEncounter(fixture("recordEncounter-request").params),
    code("DISCONNECTED"),
  );
  assert.equal(s.client.session, null);
  assert.equal(s.ports.length, 1);
  assert.equal(s.frames.filter((frame) => frame.method === "recordEncounter").length, 0);
});
test("采集超时保留未知结果，查询原 mutationId，而非自动重发", async () => {
  const s = await paired({ drop: "recordEncounter", timeoutMs: 10 });
  const params = fixture("recordEncounter-request").params as RecordEncounterParams;
  await assert.rejects(s.client.recordEncounter(params), code("TIMEOUT", true));
  const receipt = await s.client.getOperation(params.mutationId);
  assert.equal(receipt.status, "applied");
  assert.equal(receipt.mutationId, params.mutationId);
  assert.equal(s.frames.filter((frame) => frame.method === "recordEncounter").length, 1);
  assert.equal(s.frames.at(-1).params.mutationId, params.mutationId);
  s.client.close();
});
for (const errorCode of [
  "DEADLINE_EXCEEDED",
  "HOST_UNAVAILABLE",
  "INTERNAL_ERROR",
  "STORAGE_FULL",
  "RATE_LIMITED",
  "SESSION_EXPIRED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "PAIRING_REVOKED",
  "STALE_CONNECTION",
  "GENERATION_MISMATCH",
  "FUTURE_WRITE_ERROR",
]) {
  test(`服务器 ${errorCode} 不能证明采集未提交，原 mutation 查询成功且不重发`, async () => {
    const s = await paired({
      mutate(frame, response) {
        if (frame.method !== "recordEncounter") return response;
        delete response.result;
        return {
          ...response,
          ok: false,
          error: {
            code: errorCode,
            message: "写入结果未确认",
            retryable: false,
          },
        };
      },
    });
    const params = fixture("recordEncounter-request").params;
    await assert.rejects(s.client.recordEncounter(params), code(errorCode, true));
    const receipt = await s.client.getOperation(params.mutationId);
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.mutationId, params.mutationId);
    assert.equal(
      s.frames.filter((frame) => frame.method === "recordEncounter").length,
      1,
    );
    assert.equal(s.frames.at(-1).params.mutationId, params.mutationId);
    s.client.close();
  });
}
test("服务器明确的业务拒绝可终止，显式 resultUnknown 和 retryable 优先保留原意图", async () => {
  for (const remoteError of [
    { code: "INVALID_OCCURRENCE_RANGE", message: "范围无效", retryable: false },
    {
      code: "INVALID_OCCURRENCE_RANGE",
      message: "结果未知",
      retryable: false,
      resultUnknown: true,
    },
    { code: "RESOURCE_UNAVAILABLE", message: "稍后恢复资源", retryable: true },
  ]) {
    const s = await paired({
      mutate(frame, response) {
        if (frame.method !== "recordEncounter") return response;
        delete response.result;
        return { ...response, ok: false, error: remoteError };
      },
    });
    await assert.rejects(
      s.client.recordEncounter(fixture("recordEncounter-request").params),
      code(remoteError.code, remoteError.retryable || remoteError.resultUnknown === true),
    );
    s.client.close();
  }
});
test("导航服务器超时仍是结果未知，读取错误不冒充业务写入", async () => {
  const s = await paired({
    mutate(frame, response) {
      if (!["openInDesktop", "getWorkspace"].includes(frame.method)) return response;
      delete response.result;
      return {
        ...response,
        ok: false,
        error: {
          code: "DEADLINE_EXCEEDED",
          message: "回执未确认",
          retryable: false,
        },
      };
    },
  });
  await assert.rejects(
    s.client.openInDesktop("plan", UUID),
    code("DEADLINE_EXCEEDED", true),
  );
  await assert.rejects(s.client.getWorkspace(), code("DEADLINE_EXCEEDED", false));
  s.client.close();
});
test("采集只允许真实单词范围、UTF-16 边界和无凭据 HTTP 来源", () => {
  const params = fixture("recordEncounter-request").params;
  assertCaptureSemantics(params);
  for (const change of [
    (copy: any) => {
      copy.data.occurrenceRanges[0].end--;
    },
    (copy: any) => {
      copy.data.source.url = "https://user:pass@example.invalid";
    },
    (copy: any) => {
      copy.data.source.url += "#private";
    },
    (copy: any) => {
      copy.data.originalSentence = "\ud800";
    },
  ]) {
    const invalid = clone(params);
    change(invalid);
    assert.throws(() => assertCaptureSemantics(invalid), LmcpError);
  }
});
test("收到其他词条或操作回执不接收为本次成功", async () => {
  const word = fixture("getWord-request").params.word;
  const s = await paired({
    mutate(frame, response) {
      if (frame.method === "getWord") response.result.word.entryId = OTHER;
      if (frame.method === "recordEncounter") response.result.entity.entityId = OTHER;
      if (frame.method === "getOperation") response.result.mutationId = OTHER;
      return response;
    },
  });
  await assert.rejects(s.client.getWord(word), code("WORD_MISMATCH"));
  await assert.rejects(
    s.client.recordEncounter(fixture("recordEncounter-request").params),
    code("RECEIPT_MISMATCH", true),
  );
  await assert.rejects(s.client.getOperation(UUID), code("RECEIPT_MISMATCH", true));
  s.client.close();
});
test("公共词卡、分页、桌面导航均有类型化入口，导航保留 mutationId", async () => {
  const s = await paired();
  const word = fixture("getWord-request").params.word;
  assert.equal((await s.client.getPublicEntry(word)).entry.entry_id, word.entryId);
  assert.equal((await s.client.listNotebooks()).complete, true);
  assert.equal((await s.client.listEncounters(word)).complete, true);
  const mutationId = crypto.randomUUID();
  assert.equal((await s.client.openInDesktop("plan", mutationId)).opened, true);
  assert.equal(s.frames.at(-1).params.mutationId, mutationId);
  s.client.close();
});
test("显式 disconnect 无 ACK 也关闭本机通道，但不伪造服务端确认", async () => {
  const s = await paired({ drop: "disconnect", timeoutMs: 10 });
  assert.deepEqual(await s.client.disconnect(), { confirmed: false });
  assert.equal(s.client.connectionId, null);
  assert.equal(s.client.session, null);
});
test("宿主调用核验 grant、owner、期限与能力，不能凭配对读取任意页面", async () => {
  const s = await paired();
  let actions = 0;
  s.client.setHostHandler(async () => {
    actions++;
    return { status: "opened", actionId: null };
  });
  const grant = await s.client.registerHost(["browser.open-source/1"]),
    p = s.ports[0]!;
  const request = fixture("browser.openSource 请求") as HostRequest;
  request.connectionId = s.client.connectionId!;
  request.grantId = grant.grantId;
  request.grantToken = grant.grantToken;
  request.deadlineAt = new Date(NOW + 15_000).toISOString();
  for (const change of [
    (copy: HostRequest) => {
      copy.grantToken = "z".repeat(32);
    },
    (copy: HostRequest) => {
      copy.workspace.generation = OTHER;
    },
    (copy: HostRequest) => {
      copy.deadlineAt = new Date(NOW - 1).toISOString();
    },
    (copy: HostRequest) => {
      copy.deadlineAt = new Date(NOW + 31_000).toISOString();
    },
  ]) {
    const rejected = clone(request);
    rejected.requestId = crypto.randomUUID();
    change(rejected);
    p.reply(rejected);
    await tick();
    const response = p.sent.at(-1);
    assert.equal(response.kind, "host-response");
    assert.equal(response.ok, false);
  }
  assert.equal(actions, 0);
  p.reply(request);
  await tick();
  assert.equal(actions, 1);
  assert.equal(p.sent.at(-1).ok, true);
  s.client.close();
});
test("Native 在途响应的 connectionId 和 method 必须一一对应", async () => {
  for (const mutate of [
    (frame: RequestFrame, response: any) => {
      response.connectionId = OTHER;
      return response;
    },
    (frame: RequestFrame, response: any) => ({
      ...response,
      method: "pair",
      ok: false,
      error: { code: "REJECTED", message: "wrong method", retryable: false },
    }),
  ]) {
    const s = service({ mutate });
    await assert.rejects(
      s.client.hello(),
      (error: unknown) =>
        error instanceof LmcpError &&
        ["CONNECTION_MISMATCH", "METHOD_MISMATCH"].includes(error.code),
    );
    assert.equal(s.client.connectionId, null);
  }
});
test("合法但超大 UTF-8 采集在发送前被拦截，私人事实不进入端口", async () => {
  const s = await paired();
  const params = fixture("recordEncounter-request").params;
  params.data.originalSentence = "词".repeat(19_900) + "photosynthesis";
  params.data.savedExcerpt = params.data.originalSentence;
  params.data.occurrenceRanges = params.data.excerptRanges = [
    { start: 19_900, end: 19_914 },
  ];
  // 结构字段本身有上限；降低对端消息预算来核对 UTF-8 字节而非字符数。
  s.native.setMaxFrameBytes(50_000);
  await assert.rejects(
    s.client.recordEncounter(params),
    code("MESSAGE_TOO_LARGE", false),
  );
  assert.equal(s.frames.filter((frame) => frame.method === "recordEncounter").length, 0);
  s.client.close();
});

test("采集回执不得替换原始语境，即使 eventId 和词条身份一致", async () => {
  const s = await paired({
    mutate(frame, response) {
      if (frame.method === "recordEncounter")
        response.result.entity.data.annotation.note = "changed";
      return response;
    },
  });
  await assert.rejects(
    s.client.recordEncounter(fixture("recordEncounter-request").params),
    code("RECEIPT_MISMATCH", true),
  );
  s.client.close();
});

test("在途采集使用调用时的参数快照，调用方改对象不能改意图或干扰原回执", async () => {
  const s = await paired();
  const params = fixture("recordEncounter-request").params as RecordEncounterParams;
  const original = clone(params);
  const pending = s.client.recordEncounter(params);
  params.data.annotation.note = "changed while awaiting";
  const receipt = await pending;
  assert.equal(receipt.entity.data.annotation.note, original.data.annotation.note);
  assert.deepEqual(
    s.frames.find((frame) => frame.method === "recordEncounter").params,
    original,
  );
  s.client.close();
});

test("严格请求不会把原型属性名误当成合同中声明的字段", () => {
  for (const key of ["__proto__", "constructor", "toString"]) {
    const request = fixture("pair-request");
    Object.defineProperty(request, key, {
      value: { hidden: true },
      enumerable: true,
    });
    assert.equal(validFrame("Request", request), false, key);
    const nested = fixture("pair-request");
    Object.defineProperty(nested.params, key, {
      value: { hidden: true },
      enumerable: true,
    });
    assert.equal(validFrame("Request", nested), false, `params.${key}`);
  }
});

test("控制发现 STALE_CONNECTION 后重新 hello；未知业务写入仍保留原回执意图", async () => {
  let stale = true;
  const s = service({
    mutate(frame, response) {
      if (frame.method === "getConnectionStatus" && stale) {
        stale = false;
        delete response.result;
        return {
          ...response,
          ok: false,
          error: {
            code: "STALE_CONNECTION",
            message: "发现记录已过期",
            retryable: true,
          },
        };
      }
      return response;
    },
  });
  await s.client.hello();
  await assert.rejects(s.client.getConnectionStatus(), code("STALE_CONNECTION"));
  await s.client.getConnectionStatus();
  assert.equal(s.frames.filter((frame) => frame.method === "hello").length, 2);
  assert.equal(
    s.frames.some((frame) => frame.method === "pair" || frame.method === "getWorkspace"),
    false,
  );
  s.client.close();
});
