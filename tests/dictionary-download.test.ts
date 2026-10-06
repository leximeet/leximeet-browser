import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchCoreDelta, CORE_DOWNLOAD_URL } from "../lib/dictionary-download.ts";

test("下载端口只发送固定公开 URL，不携带账号凭据，返回原始字节", async () => {
  const controller = new AbortController();
  const bytes = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);
  const blob = await fetchCoreDelta(async (url, init) => {
    assert.equal(url, CORE_DOWNLOAD_URL);
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.signal, controller.signal);
    return new Response(bytes);
  }, controller.signal);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});

test("网络错误不返回半包；HTTP 503 不读取错误页作为词典", async () => {
  const controller = new AbortController();
  await assert.rejects(
    fetchCoreDelta(
      async () => new Response("unavailable", { status: 503 }),
      controller.signal,
    ),
    /增量下载失败（503）/,
  );
  await assert.rejects(
    fetchCoreDelta(async () => {
      throw new TypeError("offline");
    }, controller.signal),
    /offline/,
  );
});

test("取消与传输途中失败传播给安装入口，下载端口不自行重试或安装", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = fetchCoreDelta(async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("cancelled", "AbortError")),
        { once: true },
      );
    });
  }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
  await assert.rejects(
    fetchCoreDelta(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("truncated"));
            },
          }),
        ),
      new AbortController().signal,
    ),
    /truncated/,
  );
});
