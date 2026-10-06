import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadEdgeDraft, uploadOperationId } from "../scripts/upload-edge-draft.mjs";

const productId = "11111111-2222-3333-4444-555555555555";
const origin = "https://api.addons.microsoftedge.microsoft.com";
const uploadPath = `/v1/products/${productId}/submissions/draft/package`;
const operationId = "operation-123";
const bytes = Buffer.from("fixture bytes, not a real extension");
const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

// 仅检查发布脚本的安全边界与错误路径；这些模拟响应不是商店上传或 Edge 验收证据。
function fixture(t: TestContext, responses: (Response | Error)[]) {
  const dir = mkdtempSync(join(tmpdir(), "leximeet-edge-draft-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packagePath = join(dir, "candidate-edge.zip");
  writeFileSync(packagePath, bytes);
  const calls: { url: string; options: RequestInit }[] = [];
  const waits: number[] = [];
  const fetchImpl: typeof fetch = async (input, options) => {
    calls.push({ url: String(input), options: options ?? {} });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, "发生未预期网络请求");
    return next;
  };
  return {
    calls,
    waits,
    options: {
      packagePath,
      expectedSha256,
      productId,
      clientId: "test-client",
      apiKey: "test-api-key",
      fetchImpl,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    },
  };
}
const accepted = (location = operationId) =>
  new Response(null, { status: 202, headers: { Location: location } });
const status = (value: string) => Response.json({ status: value });

test("Edge 上传严格使用 v1.1 凭据，仅写草稿并等待实际成功状态", async (t) => {
  const s = fixture(t, [accepted(), status("InProgress"), status("Succeeded")]);
  const result = await uploadEdgeDraft(s.options);
  assert.deepEqual(result, { status: "Succeeded", operationId, sha256: expectedSha256 });
  assert.deepEqual(
    s.calls.map(({ url, options }) => [options.method, url]),
    [
      ["POST", `${origin}${uploadPath}`],
      ["GET", `${origin}${uploadPath}/operations/${operationId}`],
      ["GET", `${origin}${uploadPath}/operations/${operationId}`],
    ],
  );
  for (const call of s.calls) {
    const headers = new Headers(call.options.headers);
    assert.equal(headers.get("Authorization"), "ApiKey test-api-key");
    assert.equal(headers.get("X-ClientID"), "test-client");
    assert.equal(call.options.redirect, "error");
    assert.ok(call.options.signal);
  }
  const uploadCall = s.calls[0];
  assert.ok(uploadCall);
  assert.equal(
    new Headers(uploadCall.options.headers).get("Content-Type"),
    "application/zip",
  );
  assert.deepEqual(uploadCall.options.body, bytes);
  assert.deepEqual(s.waits, [5000]);
});

test("Edge 已验收 SHA 不匹配、凭据或产品无效时零网络请求", async (t) => {
  for (const overrides of [
    { expectedSha256: "a".repeat(64) },
    { productId: "other/products" },
    { apiKey: "" },
    { clientId: "bad\nclient" },
    { maxPolls: 0 },
  ]) {
    const s = fixture(t, []);
    await assert.rejects(uploadEdgeDraft({ ...s.options, ...overrides }));
    assert.equal(s.calls.length, 0);
  }
});

test("Edge Location 只接受本产品的操作 ID，不向外部地址传递凭据", () => {
  for (const value of [
    operationId,
    `${uploadPath}/operations/${operationId}`,
    `${origin}${uploadPath}/operations/${operationId}`,
  ]) {
    assert.equal(uploadOperationId(value, productId), operationId);
  }
  for (const value of [
    null,
    "",
    `https://evil.example${uploadPath}/operations/${operationId}`,
    `${origin}/v1/products/other/submissions/draft/package/operations/${operationId}`,
    `${origin}${uploadPath}/operations/${operationId}?token=x`,
    `${origin}${uploadPath}/operations/${operationId}#fragment`,
    `${origin}${uploadPath}/operations/a/b`,
  ]) {
    assert.throws(() => uploadOperationId(value, productId));
  }
});

test("Edge POST 失败或结果未知时不重试上传，不暴露响应和凭据", async (t) => {
  for (const response of [
    new Error("test-api-key"),
    new Response("test-api-key", { status: 401 }),
    new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
  ]) {
    const s = fixture(t, [response]);
    await assert.rejects(uploadEdgeDraft(s.options), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("test-api-key"));
      return true;
    });
    assert.equal(s.calls.length, 1);
  }
});

test("Edge 恶意操作地址在首次上传后拒绝，不继续查询", async (t) => {
  const s = fixture(t, [accepted(`https://evil.example${uploadPath}/operations/x`)]);
  await assert.rejects(uploadEdgeDraft(s.options), /操作地址/);
  assert.equal(s.calls.length, 1);
});

test("Edge 处理失败、未知状态、失联和非法 JSON 不伪报上传成功", async (t) => {
  for (const response of [
    status("Failed"),
    status("Unknown"),
    new Error("test-api-key"),
    new Response("test-api-key", { status: 500 }),
    new Response("invalid json", { status: 200 }),
  ]) {
    const s = fixture(t, [accepted(), response]);
    await assert.rejects(uploadEdgeDraft(s.options));
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls.filter(({ options }) => options.method === "POST").length, 1);
  }
});

test("Edge 状态轮询耗尽后保留操作 ID，不重传或发布", async (t) => {
  const s = fixture(t, [accepted(), status("InProgress"), status("InProgress")]);
  await assert.rejects(uploadEdgeDraft({ ...s.options, maxPolls: 2 }), /operation-123/);
  assert.equal(s.calls.length, 3);
  assert.deepEqual(s.waits, [5000]);
});
