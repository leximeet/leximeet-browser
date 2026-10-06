import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readStorageHealth,
  storageSize,
  localWriteError,
} from "../lib/storage-health.ts";

test("存储估算保留真实用量/配额；超额或零配额不显示负剩余空间", async () => {
  assert.deepEqual(
    await readStorageHealth({
      estimate: async () => ({ usage: 4096, quota: 1024 }),
      persisted: async () => false,
    }),
    { usageBytes: 4096, quotaBytes: 1024, remainingBytes: 0, persistent: false },
  );
  assert.deepEqual(
    await readStorageHealth({
      estimate: async () => ({ usage: 0, quota: 0 }),
      persisted: async () => true,
    }),
    { usageBytes: 0, quotaBytes: 0, remainingBytes: 0, persistent: true },
  );
});

test("存储查询同步/异步失败分别降级；未知状态不宣称已持久保存", async () => {
  assert.deepEqual(
    await readStorageHealth({
      estimate: async () => ({ usage: 1024, quota: 4096 }),
      persisted: () => {
        throw new Error("浏览器查询失败");
      },
    }),
    { usageBytes: 1024, quotaBytes: 4096, remainingBytes: 3072, persistent: null },
  );
  assert.deepEqual(
    await readStorageHealth({
      estimate: async () => {
        throw new Error("设备故障");
      },
      persisted: async () => true,
    }),
    { usageBytes: null, quotaBytes: null, remainingBytes: null, persistent: true },
  );
  assert.deepEqual(
    await readStorageHealth({
      estimate: async () => ({ usage: NaN, quota: Infinity }),
      persisted: async () => false,
    }),
    { usageBytes: null, quotaBytes: null, remainingBytes: null, persistent: false },
  );
});

test("存储显示区分未知值与零字节，不将安装包计入个人资料用量", () => {
  assert.equal(storageSize(null), "暂不可用");
  assert.equal(storageSize(0), "0 B");
  assert.equal(storageSize(1024 * 1024), "1.0 MiB");
  assert.equal(storageSize(-1), "暂不可用");
});

test("写入失败根据 QuotaExceededError 身份提示保留资料，其他错误保持原原因", () => {
  assert.match(
    localWriteError(new DOMException("browser-specific message", "QuotaExceededError")),
    /空间不足.*未保存.*保留/,
  );
  assert.equal(localWriteError(new Error("资料修订冲突")), "资料修订冲突");
  assert.equal(localWriteError(undefined), "本次操作失败，请保留输入后重试。");
});
