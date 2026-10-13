import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  chromeAccessToken,
  publishChrome,
  publishEdge,
} from "../scripts/publish-stores.mjs";
import { verifyConnectedRelease } from "../scripts/verify-connected-release.mjs";
import {
  compareVersions,
  verifyLatestStoreRelease,
} from "../scripts/verify-latest-store-release.mjs";

const productId = "11111111-2222-3333-4444-555555555555";
const extensionId = "a".repeat(32);
const publisherId = "test-publisher";
const name = `publishers/${publisherId}/items/${extensionId}`;
const bytes = Buffer.from("isolated fixture, not a store package");
const sha = createHash("sha256").update(bytes).digest("hex");
const chromeResult = (fields: Record<string, unknown> = {}) =>
  Response.json({ name, itemId: extensionId, ...fields });
const accepted = (location = "operation-123") =>
  new Response(null, { status: 202, headers: { Location: location } });
const edgeStatus = (status: string) => Response.json({ status });

// 全部是假响应，仅证明协议顺序和拒绝边界，不宣称商店凭据或上架已验收。
function fixture(t: TestContext, replies: (Response | Error)[]) {
  const dir = mkdtempSync(join(tmpdir(), "leximeet-store-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packagePath = join(dir, "candidate.zip");
  writeFileSync(packagePath, bytes);
  const calls: { url: string; options: RequestInit }[] = [];
  const waits: number[] = [];
  const fetchImpl: typeof fetch = async (input, options) => {
    calls.push({ url: String(input), options: options ?? {} });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, "未预期网络请求");
    return next;
  };
  return {
    calls,
    waits,
    options: {
      packagePath,
      expectedSha256: sha,
      version: "1.0.1",
      publisherId,
      extensionId,
      accessToken: "private-test-token",
      productId,
      clientId: "private-test-client",
      apiKey: "private-test-key",
      notes: "No login. See tutorial for core tests.",
      fetchImpl,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    },
  };
}

test("Google 服务账号 assertion 的签名、scope、aud 与有效期符合官方交换规范", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    type: "service_account",
    client_email: "test@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: "https://evil.example/steal",
  };
  const now = 1_700_000_000_000;
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(input, "https://oauth2.googleapis.com/token");
    assert.equal(init?.redirect, "error");
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, payload, signature] = body.get("assertion")!.split(".");
    assert.ok(header && payload && signature);
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
      alg: "RS256",
      typ: "JWT",
    });
    assert.equal(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/chromewebstore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now / 1000,
      exp: now / 1000 + 3600,
    });
    return Response.json({ token_type: "Bearer", access_token: "token" });
  };
  assert.equal(await chromeAccessToken(JSON.stringify(account), fetchImpl, now), "token");
  let calls = 0;
  await assert.rejects(
    chromeAccessToken('{"private_key":"private-test-key"}', async () => {
      calls++;
      throw new Error();
    }),
    (error: Error) => !error.message.includes("private-test-key"),
  );
  assert.equal(calls, 0);
});

test("Chrome V2 先确认上传成功，再按正常审核和通过即发布方式提交", async (t) => {
  const s = fixture(t, [
    chromeResult(),
    chromeResult({ uploadState: "IN_PROGRESS" }),
    chromeResult({ lastAsyncUploadState: "SUCCEEDED" }),
    chromeResult(),
    chromeResult({ state: "PENDING_REVIEW" }),
  ]);
  assert.deepEqual(await publishChrome(s.options), {
    state: "PENDING_REVIEW",
    alreadySubmitted: false,
    version: "1.0.1",
  });
  assert.deepEqual(
    s.calls.map((call) => [call.options.method, call.url]),
    [
      ["GET", `https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`],
      ["POST", `https://chromewebstore.googleapis.com/upload/v2/${name}:upload`],
      ["GET", `https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`],
      ["GET", `https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`],
      ["POST", `https://chromewebstore.googleapis.com/v2/${name}:publish`],
    ],
  );
  assert.deepEqual(JSON.parse(String(s.calls[4]!.options.body)), {
    publishType: "DEFAULT_PUBLISH",
    skipReview: false,
  });
  assert.deepEqual(s.waits, [5000]);
  for (const call of s.calls) {
    assert.equal(call.options.redirect, "error");
    assert.equal(
      new Headers(call.options.headers).get("Authorization"),
      "Bearer private-test-token",
    );
  }
});

test("Chrome 拒绝错 SHA、非法身份、换行凭据或错误预算，零网络请求", async (t) => {
  for (const change of [
    { expectedSha256: "0".repeat(64) },
    { publisherId: "a/b" },
    { extensionId: "wrong" },
    { version: "v1.0.1" },
    { accessToken: "bad\nsecret" },
    { maxPolls: 0 },
    { replacePendingReview: "true" as unknown as boolean },
  ]) {
    const s = fixture(t, []);
    await assert.rejects(publishChrome({ ...s.options, ...change }));
    assert.equal(s.calls.length, 0);
  }
});

test("Chrome 同版本已送审/发布不重复写；其他版本在审核时停止", async (t) => {
  for (const state of ["PENDING_REVIEW", "PUBLISHED", "SUBMITTED_PUBLISHED"]) {
    const revision = {
      state: state === "SUBMITTED_PUBLISHED" ? "PUBLISHED" : state,
      distributionChannels: [{ crxVersion: "1.0.1" }],
    };
    const s = fixture(t, [
      chromeResult({
        [state === "PUBLISHED"
          ? "publishedItemRevisionStatus"
          : "submittedItemRevisionStatus"]: revision,
      }),
    ]);
    assert.equal((await publishChrome(s.options)).alreadySubmitted, true);
    assert.equal(s.calls.length, 1);
  }
  const s = fixture(t, [
    chromeResult({
      submittedItemRevisionStatus: {
        state: "PENDING_REVIEW",
        distributionChannels: [{ crxVersion: "1.0.2" }],
      },
    }),
  ]);
  await assert.rejects(publishChrome(s.options), /其他待审核/);
  assert.equal(s.calls.length, 1);
});

test("Chrome 错身份、错版本、上传失败和未知状态都不触发 publish", async (t) => {
  for (const replies of [
    [Response.json({ name: "wrong", itemId: extensionId })],
    [chromeResult(), chromeResult({ uploadState: "FAILED" })],
    [chromeResult(), chromeResult({ uploadState: "SUCCEEDED", crxVersion: "1.0.2" })],
    [chromeResult(), chromeResult({ uploadState: "UPLOAD_IN_PROGRESS" })],
  ]) {
    const s = fixture(t, replies);
    await assert.rejects(publishChrome(s.options));
    assert.equal(
      s.calls.some((call) => call.url.endsWith(":publish")),
      false,
    );
  }
});

test("Chrome 未知 POST 结果不重试；轮询超时不误报完成；错误不暴露凭据", async (t) => {
  for (const reply of [
    new Error("private-test-token"),
    new Response("private-test-token", { status: 401 }),
    new Response("private-test-token", { status: 200 }),
  ]) {
    const s = fixture(t, [chromeResult(), reply]);
    await assert.rejects(
      publishChrome(s.options),
      (error: Error) => !error.message.includes("private-test-token"),
    );
    assert.equal(s.calls.length, 2);
  }
  const s = fixture(t, [
    chromeResult(),
    chromeResult({ uploadState: "IN_PROGRESS" }),
    chromeResult({ lastAsyncUploadState: "IN_PROGRESS" }),
    chromeResult({ lastAsyncUploadState: "IN_PROGRESS" }),
  ]);
  await assert.rejects(publishChrome({ ...s.options, maxPolls: 2 }), /未确认成功/);
  assert.equal(s.calls.filter((call) => call.options.method === "POST").length, 1);
});

test("Edge v1.1 确认草稿包处理成功后提交审核，Succeeded 只表示提交已创建", async (t) => {
  const s = fixture(t, [
    accepted(),
    edgeStatus("Succeeded"),
    accepted(
      `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions/operations/submission-123`,
    ),
    edgeStatus("InProgress"),
    edgeStatus("Succeeded"),
  ]);
  assert.deepEqual(await publishEdge(s.options), {
    state: "SUBMITTED",
    operationId: "submission-123",
    uploadOperationId: "operation-123",
  });
  assert.equal(s.calls.filter((call) => call.options.method === "POST").length, 2);
  assert.deepEqual(JSON.parse(String(s.calls[2]!.options.body)), {
    notes: s.options.notes,
  });
  for (const call of s.calls) {
    assert.equal(
      new Headers(call.options.headers).get("Authorization"),
      "ApiKey private-test-key",
    );
    assert.equal(call.options.redirect, "error");
  }
});

test("Edge 未通过上传不提交；审核备注和凭据在任何网络请求前校验", async (t) => {
  const s = fixture(t, [accepted(), edgeStatus("Failed")]);
  await assert.rejects(publishEdge(s.options));
  assert.equal(s.calls.length, 2);
  for (const change of [{ notes: "" }, { notes: "a".repeat(2001) }, { apiKey: "" }]) {
    const failed = fixture(t, []);
    await assert.rejects(publishEdge({ ...failed.options, ...change }));
    assert.equal(failed.calls.length, 0);
  }
});

test("Edge 拒绝外站或错误产品 Location，不传递密钥、不盲目重复提交", async (t) => {
  for (const reply of [
    accepted("https://evil.example/op"),
    new Error("private-test-key"),
    new Response("private-test-key", { status: 401 }),
  ]) {
    const s = fixture(t, [accepted(), edgeStatus("Succeeded"), reply]);
    await assert.rejects(
      publishEdge(s.options),
      (error: Error) => !error.message.includes("private-test-key"),
    );
    assert.equal(s.calls.length, 3);
  }
});

test("独立/连接发布门禁拒绝错源码、脏源码、错版本和生产内容差异", () => {
  const commit = "a".repeat(40);
  const evidence = {
    sourceCommit: commit,
    version: "1.0.1",
    sourceDirty: false,
    equivalence: true,
    productionDigest: "b".repeat(64),
    productionFiles: 5,
  };
  const connected = {
    ...evidence,
    connectedWith: {
      verified: true,
      desktopCommit: "d".repeat(40),
      coreCommit: "e".repeat(40),
    },
  };
  verifyConnectedRelease(evidence, connected, "1.0.1", commit);
  for (const change of [
    { sourceCommit: "c".repeat(40) },
    { sourceDirty: true },
    { version: "1.0.2" },
    { equivalence: false },
    { productionDigest: "d".repeat(64) },
    { productionFiles: 6 },
    { connectedWith: undefined },
    {
      connectedWith: {
        verified: false,
        desktopCommit: "d".repeat(40),
        coreCommit: "e".repeat(40),
      },
    },
    {
      connectedWith: {
        verified: true,
        desktopCommit: "not-a-sha",
        coreCommit: "e".repeat(40),
      },
    },
  ])
    assert.throws(() =>
      verifyConnectedRelease(evidence, { ...connected, ...change }, "1.0.1", commit),
    );
});

test("商店没有确认成功时拒绝假完成，不自动重试提交", async (t) => {
  for (const state of ["REJECTED", "STAGED", "UNKNOWN"]) {
    const chrome = fixture(t, [
      chromeResult(),
      chromeResult({ uploadState: "SUCCEEDED" }),
      chromeResult(),
      chromeResult({ state }),
    ]);
    await assert.rejects(publishChrome(chrome.options), /未返回待审核/);
    assert.equal(chrome.calls.filter((call) => call.url.endsWith(":publish")).length, 1);
  }
  for (const state of ["Failed", "Unknown"]) {
    const edge = fixture(t, [
      accepted(),
      edgeStatus("Succeeded"),
      accepted("submission-123"),
      edgeStatus(state),
    ]);
    await assert.rejects(publishEdge(edge.options), /提交未成功/);
    assert.equal(edge.calls.filter((call) => call.options.method === "POST").length, 2);
  }
  const timeout = fixture(t, [
    accepted(),
    edgeStatus("Succeeded"),
    accepted("submission-123"),
    edgeStatus("InProgress"),
    edgeStatus("InProgress"),
  ]);
  await assert.rejects(publishEdge({ ...timeout.options, maxPolls: 2 }), /仍在处理/);
  assert.equal(timeout.calls.filter((call) => call.options.method === "POST").length, 2);
});

test("Edge 恢复已受理上传后只提交一次审核；202 仍按正文状态判断", async (t) => {
  const s = fixture(t, [
    Response.json({ status: "Succeeded" }, { status: 202 }),
    accepted("submission-123"),
    Response.json({ status: "InProgress" }, { status: 202 }),
    edgeStatus("Succeeded"),
  ]);
  const result = await publishEdge({
    ...s.options,
    resumeUploadOperationId: "operation-123",
  });
  assert.equal(result.state, "SUBMITTED");
  assert.equal(result.uploadOperationId, "operation-123");
  assert.deepEqual(
    s.calls.map((call) => [call.options.method, call.url]),
    [
      [
        "GET",
        `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions/draft/package/operations/operation-123`,
      ],
      [
        "POST",
        `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions`,
      ],
      [
        "GET",
        `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions/operations/submission-123`,
      ],
      [
        "GET",
        `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions/operations/submission-123`,
      ],
    ],
  );
  assert.deepEqual(s.waits, [5000]);
});

test("Edge 已有上传操作失败或一直处理时不重传也不送审", async (t) => {
  for (const replies of [
    [Response.json({ status: "Failed" }, { status: 202 })],
    [
      Response.json({ status: "InProgress" }, { status: 202 }),
      Response.json({ status: "InProgress" }, { status: 202 }),
    ],
  ]) {
    const s = fixture(t, replies);
    await assert.rejects(
      publishEdge({
        ...s.options,
        resumeUploadOperationId: "operation-123",
        maxPolls: 2,
      }),
    );
    assert.equal(s.calls.filter((call) => call.options.method === "POST").length, 0);
  }
});

const pendingChrome = (version: string, state = "PENDING_REVIEW") =>
  chromeResult({
    submittedItemRevisionStatus: {
      state,
      distributionChannels: [{ crxVersion: version }],
    },
  });

test("Chrome 仅在显式开启后取消旧审核，接受空成功响应并等状态生效再上传", async (t) => {
  for (const status of [200, 204]) {
    const s = fixture(t, [
      pendingChrome("1.0.0"),
      pendingChrome("1.0.0"),
      new Response(null, { status }),
      pendingChrome("1.0.0"),
      chromeResult(),
      chromeResult({ uploadState: "SUCCEEDED", crxVersion: "1.0.1" }),
      chromeResult(),
      chromeResult({ state: "PENDING_REVIEW" }),
    ]);
    assert.deepEqual(await publishChrome({ ...s.options, replacePendingReview: true }), {
      state: "PENDING_REVIEW",
      alreadySubmitted: false,
      version: "1.0.1",
      cancelledVersion: "1.0.0",
    });
    assert.deepEqual(
      s.calls.map(({ url, options }) => [options.method, url.split(":").at(-1)]),
      [
        ["GET", "fetchStatus"],
        ["GET", "fetchStatus"],
        ["POST", "cancelSubmission"],
        ["GET", "fetchStatus"],
        ["GET", "fetchStatus"],
        ["POST", "upload"],
        ["GET", "fetchStatus"],
        ["POST", "publish"],
      ],
    );
    assert.equal(s.calls[2]!.options.body, undefined);
    assert.deepEqual(s.waits, [5000]);
  }
});

test("Chrome 自动替换不撤回同版本、更新版本、待发布版本或无法识别的版本", async (t) => {
  const same = fixture(t, [pendingChrome("1.0.1")]);
  assert.equal(
    (await publishChrome({ ...same.options, replacePendingReview: true }))
      .alreadySubmitted,
    true,
  );
  assert.equal(same.calls.length, 1);
  for (const reply of [
    pendingChrome("1.0.2"),
    pendingChrome("1.0.0", "STAGED"),
    chromeResult({
      publishedItemRevisionStatus: {
        state: "UNKNOWN",
        distributionChannels: [{ crxVersion: "1.0.0" }],
      },
    }),
    chromeResult({
      submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [] },
    }),
    chromeResult({
      submittedItemRevisionStatus: {
        state: "PENDING_REVIEW",
        distributionChannels: [{ crxVersion: "unknown" }],
      },
    }),
    chromeResult({
      submittedItemRevisionStatus: {
        state: "PENDING_REVIEW",
        distributionChannels: [{ crxVersion: "1.0.0" }, { crxVersion: "1.0.1" }],
      },
    }),
    chromeResult({ submittedItemRevisionStatus: { state: "UNKNOWN" } }),
    chromeResult({
      publishedItemRevisionStatus: {
        state: "PUBLISHED",
        distributionChannels: [{ crxVersion: "1.0.2" }],
      },
    }),
  ]) {
    const s = fixture(t, [reply]);
    await assert.rejects(publishChrome({ ...s.options, replacePendingReview: true }));
    assert.equal(s.calls.length, 1);
    assert.equal(
      s.calls.some(({ options }) => options.method === "POST"),
      false,
    );
  }
});

test("Chrome 临取消前遇到审核变化或错误身份时零写入", async (t) => {
  for (const changed of [
    pendingChrome("1.0.2"),
    pendingChrome("1.0.0", "STAGED"),
    chromeResult(),
    Response.json({ name: "wrong", itemId: extensionId }),
  ]) {
    const s = fixture(t, [pendingChrome("1.0.0"), changed]);
    await assert.rejects(publishChrome({ ...s.options, replacePendingReview: true }));
    assert.equal(s.calls.length, 2);
    assert.equal(
      s.calls.some(({ options }) => options.method === "POST"),
      false,
    );
  }
});

test("Chrome 取消失败、失联或取消状态未确认时不上传、不重试取消、不暴露凭据", async (t) => {
  for (const reply of [
    new Error("private-test-token"),
    new Response("private-test-token", { status: 400 }),
    new Response(null, { status: 202 }),
    new Response("private-test-token", { status: 429 }),
  ]) {
    const s = fixture(t, [pendingChrome("1.0.0"), pendingChrome("1.0.0"), reply]);
    await assert.rejects(
      publishChrome({ ...s.options, replacePendingReview: true }),
      (error: Error) => !error.message.includes("private-test-token"),
    );
    assert.equal(s.calls.length, 3);
    assert.equal(s.calls.filter(({ options }) => options.method === "POST").length, 1);
  }
  for (const states of [
    [pendingChrome("1.0.0"), pendingChrome("1.0.0")],
    [pendingChrome("1.0.2")],
    [pendingChrome("1.0.0", "STAGED")],
  ]) {
    const s = fixture(t, [
      pendingChrome("1.0.0"),
      pendingChrome("1.0.0"),
      new Response(null, { status: 204 }),
      ...states,
    ]);
    await assert.rejects(
      publishChrome({ ...s.options, replacePendingReview: true, maxPolls: 2 }),
    );
    assert.equal(s.calls.filter(({ options }) => options.method === "POST").length, 1);
  }
});

test("Chrome 上传后出现新的活动提交就停止送审，不再次取消", async (t) => {
  for (const ready of [pendingChrome("1.0.2"), pendingChrome("1.0.0")]) {
    const s = fixture(t, [
      chromeResult(),
      chromeResult({ uploadState: "SUCCEEDED" }),
      ready,
    ]);
    await assert.rejects(publishChrome({ ...s.options, replacePendingReview: true }));
    assert.equal(s.calls.filter(({ options }) => options.method === "POST").length, 1);
    assert.equal(
      s.calls.some(
        ({ url }) => url.endsWith(":publish") || url.endsWith(":cancelSubmission"),
      ),
      false,
    );
  }
});

test("最新正式发行门禁跨分页按数字版本比较，不按时间或 Latest 标记倒退", () => {
  const release = (tag_name: string, extra = {}) => ({
    tag_name,
    draft: false,
    prerelease: false,
    published_at: "2026-10-13T00:00:00Z",
    ...extra,
  });
  assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
  assert.equal(compareVersions("1.9007199254740993.0", "1.9007199254740992.0"), 1);
  assert.equal(compareVersions("1.0.1", "1.0.1"), 0);
  const pages = [
    [release("1.0.9"), release("2.0.0", { draft: true })],
    [release("1.0.10"), release("3.0.0", { prerelease: true })],
  ];
  assert.equal(verifyLatestStoreRelease(pages, "1.0.10"), "1.0.10");
  assert.throws(() => verifyLatestStoreRelease(pages, "1.0.9"), /更新的正式/);
  assert.throws(() => verifyLatestStoreRelease(pages, "1.0.11"), /尚未正式发行/);
  for (const input of [null, [], {}, [{}], [[{ tag_name: "1.0.10" }]]])
    assert.throws(() => verifyLatestStoreRelease(input, "1.0.10"));
  for (const version of ["v1.0.10", "1.00.10", "1.0.10-rc.1"])
    assert.throws(() => verifyLatestStoreRelease(pages, version));
});
