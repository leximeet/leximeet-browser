import type {
  chromium,
  expect,
  TestInfo,
  BrowserContext,
  Worker,
  Page,
  CDPSession,
} from "@playwright/test";
export interface ExtensionHarness {
  root: string;
  profile: string;
  headless: boolean;
  extensionId: string;
  context: BrowserContext;
  worker: Worker;
  cdp: CDPSession;
  restart(options?: { upgradeBuildDir?: string }): Promise<void>;
  workerHeapSampler?: () => Promise<{
    stop(): Promise<{
      samples: number;
      firstUsedBytes: number;
      lastUsedBytes: number;
      peakUsedBytes: number;
      peakTotalBytes: number;
      peakEmbedderBytes: number;
    }>;
  }>;
  openPanel(page: Page): Promise<Page>;
  close(): Promise<void>;
}
export function launchExtension(options: {
  chromium: typeof chromium;
  expect: typeof expect;
  testInfo: TestInfo;
  headless?: boolean;
  browserDataDir?: string;
  manageTrace?: boolean;
  workerMetrics?: boolean;
  browserChannel?: "chromium" | "chrome" | "msedge";
  enableBackForwardCache?: boolean;
  buildDir?: string;
}): Promise<ExtensionHarness>;
export function readingServer(
  html: string | ((url: string) => string),
  options?: { cacheControl?: string },
): Promise<{ url: string; close(): Promise<void> }>;
export function hashes(directory: string): Record<string, string>;
export function attach(testInfo: TestInfo, name: string, value: unknown): Promise<void>;
