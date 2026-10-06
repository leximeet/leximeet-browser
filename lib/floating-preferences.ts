import {
  BALL_SIZE,
  snapBallPosition,
  type BallPosition,
  type ViewportSize,
} from "./page-overlay.ts";

export const FLOATING_STORAGE_KEY = "leximeet-floating-ui-v1";
export type FloatingPreferences = {
  enabled: boolean;
  locked: boolean;
  side: "left" | "right";
  verticalRatio: number;
  hiddenOrigins: string[];
};
// 浮球位置是设备上的展示偏好，独立于个人词库身份与学习事实。
export function defaultFloatingPreferences(): FloatingPreferences {
  return {
    enabled: true,
    locked: false,
    side: "right",
    verticalRatio: 0.72,
    hiddenOrigins: [],
  };
}
export function parseFloatingPreferences(value: unknown): FloatingPreferences {
  const raw = value as Partial<FloatingPreferences> | undefined;
  const result = defaultFloatingPreferences();
  if (!raw || typeof raw !== "object") return result;
  for (const key of ["enabled", "locked"] as const)
    if (typeof raw[key] === "boolean") result[key] = raw[key];
  if (raw.side === "left" || raw.side === "right") result.side = raw.side;
  if (typeof raw.verticalRatio === "number" && Number.isFinite(raw.verticalRatio))
    result.verticalRatio = Math.min(1, Math.max(0, raw.verticalRatio));
  if (Array.isArray(raw.hiddenOrigins))
    result.hiddenOrigins = [
      ...new Set(
        raw.hiddenOrigins.filter((origin) => {
          try {
            return (
              typeof origin === "string" &&
              /^https?:/.test(origin) &&
              new URL(origin).origin === origin
            );
          } catch {
            return false;
          }
        }),
      ),
    ];
  return result;
}
// 发到某个网页的投影不含曾隐藏的其他网站，也不含任何个人资料。
export function floatingProjection(value: FloatingPreferences, origin: string) {
  // 设置中的站点授权按主机覆盖所有端口；旧的带端口记录仍只隐藏那个来源。
  let siteOrigin = origin;
  try {
    const url = new URL(origin);
    url.port = "";
    siteOrigin = url.origin;
  } catch {}
  return {
    enabled:
      value.enabled &&
      !value.hiddenOrigins.includes(origin) &&
      !value.hiddenOrigins.includes(siteOrigin),
    locked: value.locked,
    side: value.side,
    verticalRatio: value.verticalRatio,
  };
}
export type FloatingProjection = ReturnType<typeof floatingProjection>;
export function floatingPosition(
  value: FloatingProjection,
  viewport: ViewportSize,
): BallPosition {
  return snapBallPosition(
    value.side === "left" ? 0 : viewport.width,
    value.verticalRatio * Math.max(1, viewport.height - BALL_SIZE),
    viewport,
  );
}
export function floatingPlacement(position: BallPosition, viewport: ViewportSize) {
  return {
    side:
      position.left + BALL_SIZE / 2 < viewport.width / 2
        ? ("left" as const)
        : ("right" as const),
    verticalRatio: Math.min(
      1,
      Math.max(0, position.top / Math.max(1, viewport.height - BALL_SIZE)),
    ),
  };
}
