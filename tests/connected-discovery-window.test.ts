import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { expect } from "@playwright/test";
import type { ConnectedLabSession } from "../scripts/launch-connected-lab.mjs";
import { createConnectionUi } from "./connected/connection-ui.mjs";

const start = Date.parse("2026-10-06T11:00:00.000Z");
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

// 只替换时钟、通知读取和轮询调度，执行共享 helper 的真实截止与证据写入逻辑。
// 真实 Chrome 通知是否产生仍由完整 connected 套件验收，此处不启动任何浏览器。
function fixture(
  t: TestContext,
  evidence: Record<string, unknown>,
  options: {
    now?: number;
    available?: boolean;
    readDuration?: number;
    schedulingDelay?: number;
    failure?: Error;
  } = {},
) {
  const clock = { now: options.now ?? start + 1_000 };
  const calls = { reads: 0, timeouts: [] as number[] };
  t.mock.method(Date, "now", () => clock.now);
  const lab = {
    evidence,
    workspace: {
      async evaluate() {
        calls.reads++;
        clock.now += options.readDuration ?? 0;
        if (options.failure) throw options.failure;
        return options.available ?? true;
      },
    },
  } as unknown as ConnectedLabSession;
  const assertions = {
    poll(read: () => Promise<boolean>, settings: { timeout: number }) {
      calls.timeouts.push(settings.timeout);
      return {
        async toBe(expected: boolean) {
          clock.now += options.schedulingDelay ?? 0;
          assert.equal(await read(), expected);
        },
      };
    },
  } as unknown as typeof expect;
  const ui = createConnectionUi(assertions);
  return { evidence, calls, clock, wait: () => ui.waitForDiscoveryNotification(lab) };
}

test("Browser 准备超过 60 秒时仍从首次 Chromium 启动计算原发现窗口", async (t) => {
  const s = fixture(t, {
    startedAt: iso(start - 90_000),
    discoveryStartedAt: iso(start),
  });
  await s.wait();
  assert.deepEqual(s.calls, { reads: 1, timeouts: [59_000] });
  assert.equal(s.evidence.actualDiscoveryNotification, true);
  assert.equal(s.evidence.actualDiscoveryNotificationAt, iso(start + 1_000));
});

test("Desktop 随包驱动没有新增字段时继续使用 startedAt 的剩余预算", async (t) => {
  const s = fixture(t, { startedAt: iso(start) }, { now: start + 12_000 });
  await s.wait();
  assert.deepEqual(s.calls, { reads: 1, timeouts: [48_000] });
  assert.equal(s.evidence.actualDiscoveryNotificationAt, iso(start + 12_000));
});

test("缺失、无效或已经截止的起点拒绝等待，不另开 60 秒窗口", async (t) => {
  for (const evidence of [
    {},
    { startedAt: iso(start), discoveryStartedAt: "invalid" },
    { startedAt: iso(start - 60_000) },
    { startedAt: iso(start), discoveryStartedAt: iso(start - 60_000) },
  ]) {
    await t.test(JSON.stringify(evidence), async (t) => {
      const s = fixture(t, evidence, { now: start });
      await assert.rejects(s.wait(), /60 秒截止已到/);
      assert.deepEqual(s.calls, { reads: 0, timeouts: [] });
      assert.equal(s.evidence.actualDiscoveryNotification, undefined);
    });
  }
});

test("轮询调度已经耗尽截止时不再读取通知", async (t) => {
  const s = fixture(
    t,
    { discoveryStartedAt: iso(start) },
    {
      now: start + 59_999,
      schedulingDelay: 1,
    },
  );
  await assert.rejects(s.wait(), /60 秒截止已到/);
  assert.deepEqual(s.calls, { reads: 0, timeouts: [1] });
  assert.equal(s.evidence.actualDiscoveryNotification, undefined);
});

test("真实读取在截止前完成才记录成功，正好截止或更晚的 true 均拒绝", async (t) => {
  for (const readDuration of [1, 2, 3]) {
    await t.test(`读取耗时 ${readDuration}ms`, async (t) => {
      const s = fixture(
        t,
        { discoveryStartedAt: iso(start) },
        {
          now: start + 59_998,
          readDuration,
        },
      );
      if (readDuration === 1) {
        await s.wait();
        assert.equal(s.evidence.actualDiscoveryNotification, true);
        assert.equal(s.evidence.actualDiscoveryNotificationAt, iso(start + 59_999));
      } else {
        await assert.rejects(s.wait(), /60 秒截止已到/);
        assert.equal(s.evidence.actualDiscoveryNotification, undefined);
        assert.equal(s.evidence.actualDiscoveryNotificationAt, undefined);
      }
      assert.deepEqual(s.calls, { reads: 1, timeouts: [2] });
    });
  }
});

test("通知未出现或真实读取失败时不写入成功证据", async (t) => {
  const failure = new Error("通知读取失败");
  for (const options of [{ available: false }, { failure }]) {
    await t.test(options.failure ? "读取失败" : "尚无通知", async (t) => {
      const s = fixture(t, { discoveryStartedAt: iso(start) }, options);
      if (options.failure)
        await assert.rejects(s.wait(), (error: unknown) => error === failure);
      else await assert.rejects(s.wait());
      assert.equal(s.evidence.actualDiscoveryNotification, undefined);
      assert.equal(s.evidence.actualDiscoveryNotificationAt, undefined);
    });
  }
});

test("业务准备耗时不抹去截止前已观察的通知，也不重新授予发现预算", async (t) => {
  const s = fixture(t, { discoveryStartedAt: iso(start) });
  await s.wait();
  s.clock.now = start + 120_000;
  await s.wait();
  assert.deepEqual(s.calls, { reads: 1, timeouts: [59_000] });
  assert.equal(s.evidence.actualDiscoveryNotificationAt, iso(start + 1_000));
});
