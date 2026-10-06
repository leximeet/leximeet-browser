export type RuntimeReply = { ok: boolean; result?: unknown; error?: string };

/**
 * Chrome 142～147，以及未开启 Promise listener 的新版浏览器，需要 literal true + sendResponse。
 * 统一适配异步回执，不依赖 Chrome 148 正在逐步启用的 Promise 返回能力。
 */
export function replyAsync(
  sendResponse: (reply: RuntimeReply) => void,
  task: Promise<RuntimeReply>,
): true {
  const send = (reply: RuntimeReply) => {
    try {
      sendResponse(reply);
    } catch {
      // 收信文档已关闭，不产生新的业务动作。
    }
  };
  void task.then(send, (cause) =>
    send({ ok: false, error: cause instanceof Error ? cause.message : "异步消息失败" }),
  );
  return true;
}
