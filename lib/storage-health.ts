// 当前扩展源的浏览器估算，包含 IndexedDB/缓存，不包含内置词包的安装文件。
export type StorageHealth = {
  usageBytes: number | null;
  quotaBytes: number | null;
  remainingBytes: number | null;
  persistent: boolean | null;
};

type StorageReader = Pick<StorageManager, "estimate" | "persisted">;
const validBytes = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

// 查询失败仅影响状态展示，不能阻断离线读写；不自动请求持久化或增加权限。
export async function readStorageHealth(
  manager: StorageReader | undefined = globalThis.navigator?.storage,
): Promise<StorageHealth> {
  const [estimate, persistent] = await Promise.allSettled([
    Promise.resolve().then(() => manager?.estimate()),
    Promise.resolve().then(() => manager?.persisted()),
  ]);
  const usageBytes = validBytes(
    estimate.status === "fulfilled" ? estimate.value?.usage : undefined,
  );
  const quotaBytes = validBytes(
    estimate.status === "fulfilled" ? estimate.value?.quota : undefined,
  );
  return {
    usageBytes,
    quotaBytes,
    remainingBytes:
      usageBytes !== null && quotaBytes !== null
        ? Math.max(0, quotaBytes - usageBytes)
        : null,
    persistent:
      persistent.status === "fulfilled" && typeof persistent.value === "boolean"
        ? persistent.value
        : null,
  };
}

export function storageSize(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "暂不可用";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1024,
    index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index++;
  }
  return `${amount.toFixed(1)} ${units[index]}`;
}

// 根据标准错误身份识别配额失败，不能解析可能随浏览器版本改变的错误文本。
export function localWriteError(cause: unknown): string {
  if (
    cause &&
    typeof cause === "object" &&
    "name" in cause &&
    cause.name === "QuotaExceededError"
  )
    return "浏览器存储空间不足，本次修改未保存。原资料和当前输入仍保留，请先备份并释放设备空间后重试。";
  return cause instanceof Error ? cause.message : "本次操作失败，请保留输入后重试。";
}
