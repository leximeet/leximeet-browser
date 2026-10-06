import { installCoreText } from "./dictionary-installer.ts";
// 安装放在独立 worker，管理页可取消；中断最多留下不可见的缓存，不改个人事实。
self.onmessage = async ({ data }: { data: { file: Blob; liteIds: string[] } }) => {
  try {
    await installCoreText(data.file, new Set(data.liteIds), (p) =>
      self.postMessage({ progress: p }),
    );
    self.postMessage({ done: true });
  } catch (e) {
    self.postMessage({ error: (e as Error).message });
  }
};
