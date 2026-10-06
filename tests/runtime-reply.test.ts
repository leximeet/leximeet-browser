import test from "node:test";
import assert from "node:assert/strict";
import { replyAsync, type RuntimeReply } from "../lib/runtime-reply.ts";

test("异步消息先保持 Chrome 回执通道，再发送完成结果", async () => {
  let finish!: (reply: RuntimeReply) => void;
  const task = new Promise<RuntimeReply>((resolve) => {
    finish = resolve;
  });
  const received: RuntimeReply[] = [];
  assert.equal(
    replyAsync((value) => received.push(value), task),
    true,
  );
  assert.equal(received.length, 0);
  finish({ ok: true, result: "saved" });
  await task;
  assert.deepEqual(received, [{ ok: true, result: "saved" }]);
});
test("拒绝的异步任务仍有明确回执；已关闭接收页不会留下未处理拒绝", async () => {
  const failure = Promise.reject(new Error("本机写入失败"));
  const received: RuntimeReply[] = [];
  replyAsync((value) => received.push(value), failure);
  await failure.catch(() => {});
  assert.deepEqual(received, [{ ok: false, error: "本机写入失败" }]);
  const done = Promise.resolve({ ok: true });
  replyAsync(() => {
    throw new Error("接收页已关闭");
  }, done);
  await done;
});
