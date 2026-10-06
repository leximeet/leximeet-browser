import { CORE_DELTA } from "./dictionary-cache.ts";

export const CORE_DOWNLOAD_URL =
  "https://github.com/leximeet/leximeet-dictionary/releases/download/v0.0.3/" +
  CORE_DELTA.file;

// 只负责获取公开字节；授权留在点击入口，哈希和原子安装仍由安装器负责。
export async function fetchCoreDelta(
  request: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await request(CORE_DOWNLOAD_URL, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(`增量下载失败（${response.status}），可改用本地包`);
  return response.blob();
}
