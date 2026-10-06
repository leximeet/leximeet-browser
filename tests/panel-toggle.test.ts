import test from "node:test";
import assert from "node:assert/strict";
import { PanelToggle } from "../page/panel-toggle.ts";

test("打开真实回执后立即右键收起，不受300毫秒时间窗口影响", async () => {
  let visible = false;
  const actions: string[] = [],
    pending: boolean[] = [];
  const toggle = new PanelToggle({
    visible: () => visible,
    request: async (action) => {
      actions.push(action);
      visible = action === "open";
    },
    changed: (value) => pending.push(value),
  });
  await toggle.toggle();
  await toggle.toggle();
  assert.deepEqual(actions, ["open", "close"]);
  assert.deepEqual(pending, [true, false, true, false]);
});
test("尚未回执时重复操作不会发送第二个请求，失败后允许明确重试", async () => {
  let reject!: (error: Error) => void;
  const actions: string[] = [];
  const toggle = new PanelToggle({
    visible: () => true,
    request: (action) => {
      actions.push(action);
      return new Promise((_, fail) => {
        reject = fail;
      });
    },
    changed() {},
  });
  const first = toggle.toggle();
  assert.equal(await toggle.toggle(), false);
  assert.deepEqual(actions, ["close"]);
  reject(new Error("原生关闭失败"));
  await assert.rejects(first, /原生关闭失败/);
  const retry = toggle.toggle();
  assert.deepEqual(actions, ["close", "close"]);
  reject(new Error("再次失败"));
  await assert.rejects(retry, /再次失败/);
});
