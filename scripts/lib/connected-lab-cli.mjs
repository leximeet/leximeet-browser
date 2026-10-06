import { Worker } from "node:worker_threads";

/**
 * 主线程只接收信号和终端命令；Playwright 所在 worker 不接收进程的 SIGINT。
 * closed 消息与正常线程退出必须同时到达，才能宣称资料、注册及观察工具已清理。
 */
export function startConnectedCliWorker({
  entrypoint,
  options,
  signal,
  onStatus = console.log,
  createWorker = (file, config) => new Worker(file, config),
}) {
  signal?.throwIfAborted();
  const worker = createWorker(entrypoint, {
    workerData: { kind: "leximeet.connected-cli/1", options },
  });
  let sequence = 0,
    closing = false,
    exited = false,
    completed = false,
    failure;
  const requests = new Map();
  let resolveReady, rejectReady, resolveClosed, rejectClosed;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => {});
  const send = (message) => {
    try {
      worker.postMessage(message);
    } catch (error) {
      failure ||= error;
    }
  };
  const close = () => {
    if (!closing && !exited) {
      closing = true;
      send({ type: "cancel" });
    }
    return closed;
  };
  const command = (action) => {
    if (closing || exited || signal?.aborted)
      return Promise.reject(
        Object.assign(new Error("本轮会话正在结束，不能排队重启"), {
          code: "LAB_CLOSING",
        }),
      );
    if (requests.size)
      return Promise.reject(new Error("Desktop 操作正在进行，不能排队重启"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      send({ type: "command", action, id });
      if (failure) {
        requests.delete(id);
        reject(failure);
      }
    });
  };
  const session = {
    headless: options.headless,
    closed,
    close,
    stopDesktop: () => command("stop"),
    restartDesktop: () => command("restart"),
  };
  const onAbort = () => void close().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  worker.on("message", (message) => {
    if (message?.type === "status" && typeof message.message === "string")
      onStatus(message.message);
    else if (message?.type === "ready" && !closing) resolveReady(session);
    else if (message?.type === "response") {
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      if (message.error)
        request.reject(
          Object.assign(
            new Error(message.error),
            message.errorCode === "LAB_CLOSING" ? { code: "LAB_CLOSING" } : {},
          ),
        );
      else request.resolve();
    } else if (message?.type === "closed") {
      completed = true;
      closing = true;
      if (message.error) failure ||= new Error(message.error);
    }
  });
  worker.once("error", (error) => {
    failure ||= error;
  });
  worker.once("exit", (code) => {
    exited = true;
    signal?.removeEventListener("abort", onAbort);
    if (!completed || code !== 0)
      failure ||= new Error(`双端会话线程未完整结束：${code}；请检查本轮清理记录`);
    const ended =
      failure || Object.assign(new Error("本轮会话已经结束"), { code: "LAB_CLOSING" });
    for (const request of requests.values()) request.reject(ended);
    requests.clear();
    if (failure) {
      rejectReady(failure);
      rejectClosed(failure);
    } else {
      rejectReady(signal?.reason || ended);
      resolveClosed();
    }
  });
  // 注册回调后再检查一次取消，避免创建线程与安装监听之间漏掉取消。
  if (signal?.aborted) onAbort();
  return ready;
}
