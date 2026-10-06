import { browser } from "wxt/browser";
export async function call<T = any>(
  action: string,
  data: Record<string, unknown> = {},
  windowId?: number,
): Promise<T> {
  const response = await browser.runtime.sendMessage({
    channel: "leximeet",
    action,
    data: { ...data, ...(windowId !== undefined ? { windowId } : {}) },
  });
  if (!response?.ok) throw new Error(response?.error || "扩展后台暂时不可用，请重试");
  return response.result;
}
