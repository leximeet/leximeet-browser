import { createInterface } from "node:readline";

const help =
  "本轮终端命令（输入后回车）：stop 停止隔离 Desktop；restart 用同一资料重启 Desktop；help 显示说明。Ctrl+C 结束并清理整轮环境。";

// 只有可见验收的真实终端读取输入；自动化和重定向 stdin 均不安装输入处理。
export function installManualDesktopCommands({
  session,
  headless,
  signal,
  input = process.stdin,
  output = process.stdout,
  onInterrupt,
  onStatus = console.log,
}) {
  if (headless || !input.isTTY || signal?.aborted) return;
  let accepting = true,
    busy = false,
    pending = Promise.resolve(),
    closing;
  const terminal = createInterface({ input, output, terminal: true });
  const onLine = (line) => {
    if (!accepting || signal?.aborted) return;
    const command = line.trim().toLowerCase();
    if (!command) return;
    if (command === "help") {
      onStatus(help);
      return;
    }
    if (command !== "stop" && command !== "restart") {
      onStatus("未知命令；输入 help 查看本轮终端命令。");
      return;
    }
    // 不排队积累重复重启；当前操作结束后才接收下一次操作。
    if (busy) {
      onStatus("Desktop 操作正在进行，请完成后再输入命令。");
      return;
    }
    busy = true;
    pending = (async () => {
      try {
        if (command === "stop") await session.stopDesktop();
        else await session.restartDesktop();
        if (accepting)
          onStatus(
            command === "stop"
              ? "本轮 Desktop 已停止；输入 restart 回车，以同一隔离资料重启。"
              : "本轮 Desktop 已用同一隔离资料重启。",
          );
      } catch (error) {
        // 正常取消不算清理失败；其他错误仍交由会话保留证据。
        if (!accepting && (error.code === "LAB_CLOSING" || error === signal?.reason))
          return;
        if (accepting) onStatus(`Desktop 操作失败：${error.message}`);
        throw error;
      } finally {
        busy = false;
      }
    })();
    // 输入事件不产生未处理拒绝；关闭时仍将真实失败交给会话清理记录。
    void pending.catch(() => {});
  };
  const onAbort = () => void close().catch(() => {});
  const onSigint = () => {
    if (accepting) onInterrupt?.();
  };
  terminal.on("line", onLine);
  terminal.on("SIGINT", onSigint);
  terminal.once("close", () => {
    accepting = false;
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  onStatus(help);

  function close() {
    if (closing) return closing;
    accepting = false;
    signal?.removeEventListener("abort", onAbort);
    terminal.removeListener("line", onLine);
    terminal.removeListener("SIGINT", onSigint);
    terminal.close();
    // 先注销输入，再等待在途 stop/restart；会话随后才销毁进程与资料。
    closing = pending;
    return closing;
  }
  return { close };
}
