import test from "node:test";
import assert from "node:assert/strict";
import { verifyDesktopRegistrationIfRunning } from "../scripts/launch-connected-lab.mjs";

function running(pid: number) {
  return {
    pid,
    exitCode: null as number | null,
    signalCode: null as string | null,
  };
}

test("桌面明确停止后浏览器可重开，未调用来源等待且不沿用旧ready", async () => {
  let currentChild: ReturnType<typeof running> | undefined = running(123);
  const checked: number[] = [];
  const check = async (child: ReturnType<typeof running>) => {
    checked.push(child.pid);
    return { ready: true, instanceId: String(child.pid) };
  };
  assert.equal(
    (await verifyDesktopRegistrationIfRunning(currentChild, check)).ready,
    true,
  );
  // 与CurrentLab stopDesktop完成后相同：清除当前child，而非另设可失真的运行标记。
  currentChild = undefined;
  assert.deepEqual(await verifyDesktopRegistrationIfRunning(currentChild, check), {
    ready: false,
    reason: "desktop-stopped",
  });
  assert.deepEqual(checked, [123]);
  // 同资料桌面真正重开必须核验新当前进程；不能复用已经退出的旧child。
  currentChild = running(456);
  assert.deepEqual(await verifyDesktopRegistrationIfRunning(currentChild, check), {
    ready: true,
    instanceId: "456",
  });
  assert.deepEqual(checked, [123, 456]);
});

test("当前活进程的来源校验失败、原预算耗尽必须原样拒绝", async () => {
  const child = running(123);
  const failure = new Error("本轮实际origin未被同实例认可，原截止耗尽");
  await assert.rejects(
    verifyDesktopRegistrationIfRunning(child, async (actual: typeof child) => {
      assert.equal(actual, child);
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("仍被持有但已意外退出的child不能当作明确停机绕过门禁", async () => {
  for (const child of [
    { ...running(123), exitCode: 1 },
    { ...running(123), signalCode: "SIGTERM" },
    { ...running(123), spawnError: new Error("spawn failed") },
  ]) {
    await assert.rejects(
      verifyDesktopRegistrationIfRunning(child, async () => {
        throw new Error("失败进程不应进入实际来源等待");
      }),
      /本轮 Desktop 子进程已退出/,
    );
  }
});
