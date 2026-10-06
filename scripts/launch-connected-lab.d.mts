import type { BrowserContext, ElectronApplication, Page, Worker } from "@playwright/test";

export interface ConnectedLabOptions {
  desktopRoot?: string;
  extensionDir?: string;
  headless?: boolean;
  readingUrl?: string;
  // 人工默认真实教学；后台自动回归默认管理页，可显式后台验收教学启动。
  startupPage?: "tutorial" | "workspace";
  navigationTimeout?: number;
  outputDir?: string;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
  // 人工 CLI 关闭输入并等待在途命令；不在自动化模式安装终端。
  beforeClose?: () => void | Promise<void>;
}
export interface ConnectedLabSession {
  id: string;
  ownedRoot: string;
  profileDir: string;
  browserProfile: string;
  copiedExtension: string;
  extensionId: string;
  headless: boolean;
  evidence: Record<string, any>;
  closed: Promise<void>;
  close(): Promise<void>;
  saveEvidence(): void;
  readonly desktop: ElectronApplication | undefined;
  readonly desktopPage: Page | undefined;
  readonly context: BrowserContext;
  readonly worker: Worker;
  readonly workspace: Page;
  readonly reading: Page;
  url: string;
  localUrl: string;
  stopDesktop(): Promise<void>;
  restartDesktop(): Promise<Page>;
  restartBrowser(): Promise<BrowserContext>;
  openPanel(page?: Page): Promise<Page>;
}
export function startConnectedLab(
  options?: ConnectedLabOptions,
): Promise<ConnectedLabSession>;

// 只跳过本轮明确停机的undefined；持有的失败child和实际校验失败仍拒绝。
export function verifyDesktopRegistrationIfRunning<
  Child extends {
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    spawnError?: unknown;
  },
  Result,
>(
  child: Child | undefined,
  verify: (currentChild: Child) => Result | Promise<Result>,
): Promise<Result | { ready: false; reason: "desktop-stopped" }>;
