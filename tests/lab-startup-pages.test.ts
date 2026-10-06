import test from "node:test";
import assert from "node:assert/strict";
import {
  labReadingUrl,
  openLabReadingPage,
  activateLabPage,
} from "../scripts/lib/lab-startup-pages.mjs";
import { DEFAULT_READING_URL } from "../lib/reading-page.mjs";

// 此处只验证启动策略和故障分支；真实安装、标签选择、侧栏与清理由 lab/随包 E2E 验证。
test("人工默认 Node.js 文档，后台默认回环 fixture，显式地址可供真实故障验证", () => {
  assert.equal(labReadingUrl({ headless: false }), DEFAULT_READING_URL);
  assert.equal(labReadingUrl({ headless: true }), "local");
  assert.equal(
    labReadingUrl({ headless: true, readingUrl: "http://127.0.0.1:45678/slow" }),
    "http://127.0.0.1:45678/slow",
  );
  assert.throws(
    () => labReadingUrl({ headless: true, readingUrl: "file:///private/data" }),
    /HTTP/,
  );
});
function fixture({
  failure,
  body = "English reading",
  closed = false,
}: {
  failure?: () => void;
  body?: string;
  closed?: boolean;
} = {}) {
  const calls: Array<{ url: string; timeout: number }> = [];
  let current = "about:blank";
  const page = {
    async goto(url: string, options: { timeout: number }) {
      calls.push({ url, timeout: options.timeout });
      if (calls.length === 1) failure?.();
      current = url;
      return { ok: () => true };
    },
    locator: () => ({ innerText: async () => body }),
    isClosed: () => closed,
    url: () => current,
  };
  return { calls, page, context: { newPage: async () => page } };
}
test("外站失败只回退当前阅读标签，保留初始地址并报告实际地址", async () => {
  const s = fixture({
    failure: () => {
      throw new Error("timeout");
    },
  });
  const statuses: string[] = [];
  const result = await openLabReadingPage({
    context: s.context as any,
    readingUrl: "https://example.invalid/english",
    localUrl: "http://127.0.0.1:45678/",
    navigationTimeout: 1000,
    onStatus: (message) => statuses.push(message),
  });
  assert.equal(result.requestedUrl, "https://example.invalid/english");
  assert.equal(result.url, "http://127.0.0.1:45678/");
  assert.equal(result.fallback, true);
  assert.equal(statuses.length, 1);
  assert.deepEqual(s.calls, [
    { url: "https://example.invalid/english", timeout: 1000 },
    { url: "http://127.0.0.1:45678/", timeout: 15000 },
  ]);
});
test("取消与本地 fixture 故障必须保留原错误，不重试成另一个验收场景", async () => {
  const controller = new AbortController();
  const reason = new Error("本轮取消");
  const s = fixture({
    failure: () => {
      controller.abort(reason);
      throw new Error("goto cancelled");
    },
  });
  await assert.rejects(
    openLabReadingPage({
      context: s.context as any,
      readingUrl: DEFAULT_READING_URL,
      localUrl: "http://127.0.0.1:45678/",
      signal: controller.signal,
      onStatus: () => {
        throw new Error("取消不能降级");
      },
    }),
    (error) => error === reason,
  );
  assert.equal(s.calls.length, 1);
  const local = fixture({
    failure: () => {
      throw new Error("fixture unavailable");
    },
  });
  await assert.rejects(
    openLabReadingPage({
      context: local.context as any,
      readingUrl: "local",
      localUrl: "http://127.0.0.1:45678/",
    }),
    /fixture unavailable/,
  );
  assert.equal(local.calls.length, 1);
});
test("教学已关闭时不可悄悄改选管理页，避免把引导失败误报为启动成功", async () => {
  await assert.rejects(
    activateLabPage({
      tutorial: { isClosed: () => true } as any,
      startupPage: "tutorial",
    }),
    /关闭或未就绪/,
  );
});
