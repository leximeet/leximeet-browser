import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startConnectedCliWorker } from "../scripts/lib/connected-lab-cli.mjs";

test("程序式联调驱动只加载浏览器库，不引入另一份测试运行器", async () => {
  const entry = new URL("../scripts/launch-connected-lab.mjs", import.meta.url).href;
  // 独立进程检查真实模块加载结果；只导入程序式 API，不启动浏览器或桌面应用。
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {createRequire} from 'node:module';
       const driver=await import(${JSON.stringify(entry)});
       const require=createRequire(import.meta.url);
       console.log(JSON.stringify({
         reusable:typeof driver.startConnectedLab==='function',
         testRunners:Object.keys(require.cache).filter(p=>p.includes('/node_modules/@playwright/test/'))
       }));`,
    ],
    { timeout: 10000 },
  );
  assert.deepEqual(JSON.parse(stdout), { reusable: true, testRunners: [] });
});

// 这里只验证线程控制生命周期；真实 SIGINT/Native/资料清理由原三场联调证明。
class FakeWorker extends EventEmitter {
  messages: any[] = [];
  postMessage(value: unknown) {
    this.messages.push(value);
  }
}
function setup(signal?: AbortSignal) {
  const worker = new FakeWorker();
  const statuses: string[] = [];
  const ready = startConnectedCliWorker({
    entrypoint: new URL("../scripts/launch-connected-lab.mjs", import.meta.url),
    options: { headless: true },
    signal,
    createWorker: () => worker,
    onStatus: (text: string) => statuses.push(text),
  });
  return { worker, ready, statuses };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("取消只请求 worker 清理；closed 确认与线程正常退出后才结束", async () => {
  const controller = new AbortController();
  const s = setup(controller.signal);
  s.worker.emit("message", { type: "ready" });
  const session = await s.ready;
  let settled = false;
  const finished = session.closed.then(() => {
    settled = true;
  });
  controller.abort(new Error("SIGINT"));
  assert.deepEqual(s.worker.messages, [{ type: "cancel" }]);
  await tick();
  assert.equal(settled, false);
  s.worker.emit("message", { type: "closed" });
  await tick();
  assert.equal(settled, false);
  s.worker.emit("exit", 0);
  await finished;
  assert.equal(settled, true);
});

test("关闭后不能发送或积累 restart；命名操作保留 worker 的真实失败", async () => {
  const s = setup();
  s.worker.emit("message", { type: "ready" });
  const session = await s.ready;
  const operation = session.restartDesktop();
  await assert.rejects(session.restartDesktop(), /操作正在进行/);
  assert.deepEqual(s.worker.messages, [{ type: "command", action: "restart", id: 1 }]);
  s.worker.emit("message", {
    type: "response",
    id: 1,
    error: "Desktop 启动失败",
  });
  await assert.rejects(operation, /Desktop 启动失败/);
  const finish = session.close();
  await assert.rejects(session.restartDesktop(), /不能排队重启/);
  assert.equal(s.worker.messages.length, 2);
  s.worker.emit("message", { type: "closed" });
  s.worker.emit("exit", 0);
  await finish;
});

test("中断中的 restart 保留关闭错误码，终端可结束在途操作而非误报启动故障", async () => {
  const s = setup();
  s.worker.emit("message", { type: "ready" });
  const session = await s.ready;
  const command = session.restartDesktop();
  const finish = session.close();
  s.worker.emit("message", {
    type: "response",
    id: 1,
    error: "本轮会话正在结束",
    errorCode: "LAB_CLOSING",
  });
  await assert.rejects(command, { code: "LAB_CLOSING" });
  s.worker.emit("message", { type: "closed" });
  s.worker.emit("exit", 0);
  await finish;
});

test("worker 启动崩溃与未发送 closed 的退出均不得误报已清理", async () => {
  const startup = setup();
  startup.worker.emit("error", new Error("worker 创建失败"));
  startup.worker.emit("exit", 1);
  await assert.rejects(startup.ready, /worker 创建失败/);
  const s = setup();
  s.worker.emit("message", { type: "ready" });
  const session = await s.ready;
  const finish = session.closed;
  s.worker.emit("exit", 0);
  await assert.rejects(finish, /未完整结束/);
});

test("清理错误不能被正常线程退出覆盖；在途命令也要结束", async () => {
  const s = setup();
  s.worker.emit("message", { type: "ready" });
  const session = await s.ready;
  const command = session.stopDesktop();
  s.worker.emit("message", { type: "closed", error: "焦点观察未完成" });
  s.worker.emit("exit", 0);
  await assert.rejects(session.closed, /焦点观察未完成/);
  await assert.rejects(command, /焦点观察未完成/);
});

test("启动中取消须等待清理，不发出 ready；状态文本按原样传出", async () => {
  const controller = new AbortController();
  const s = setup(controller.signal);
  s.worker.emit("message", { type: "status", message: "仅本轮临时资料" });
  controller.abort(new Error("用户取消"));
  s.worker.emit("message", { type: "ready" });
  s.worker.emit("message", { type: "closed" });
  s.worker.emit("exit", 0);
  await assert.rejects(s.ready, /用户取消/);
  assert.deepEqual(s.statuses, ["仅本轮临时资料"]);
});
