import type { LocalSettings } from "./local-model.ts";

// 只验证正式本机设置；废弃的学习配额、词卡和打字设置不补齐、不双读。
export function validSettings(value: unknown): value is LocalSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return (
    Object.keys(settings).every((key) => key === "theme") &&
    ["system", "light", "dark"].includes(String(settings.theme))
  );
}
