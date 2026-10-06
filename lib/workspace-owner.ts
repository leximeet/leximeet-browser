import type { ConnectionView } from "./desktop-connection.ts";

// 这是插件内部控制视图；ownerReady 不是 LMCP 字段，也不是独立资料的一部分。
export type WorkspaceConnectionState = ConnectionView & { ownerReady: boolean };

/**
 * 持久连接状态可能先于资料切换完成。只有后台明确释放归属锁，才挂载对应业务页面，
 * 避免恢复 A 时初始化请求过早被拒，也避免过渡期间挂载原独立私人资料。
 */
export function readyWorkspaceMode(
  state: { mode: string; ownerReady?: boolean } | null,
): "independent" | "desktop" | null {
  if (state?.ownerReady !== true) return null;
  return state.mode === "independent" || state.mode === "desktop" ? state.mode : null;
}
