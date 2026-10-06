import type { BrowserContext } from "@playwright/test";

export interface IsolatedBrowserSession {
  root: string;
  profile: string;
  url: string;
  requestedUrl: string;
  fallback: boolean;
  startupUrl: string;
  localUrl: string;
  headless: boolean;
  context: BrowserContext;
  extensionId: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

export function startIsolatedBrowser(options?: {
  extensionDir?: string;
  readingUrl?: string;
  navigationTimeout?: number;
  // 程序调用默认 true；人工 CLI 默认可见，自动测试继承 Playwright 配置。
  headless?: boolean;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<IsolatedBrowserSession>;
