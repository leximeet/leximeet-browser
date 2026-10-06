import type { BrowserContext, Page } from "@playwright/test";
export type LabStartupPage = "tutorial" | "workspace";
export function labReadingUrl(options: {
  headless: boolean;
  readingUrl?: string;
}): string;
export function openLabReadingPage(options: {
  context: BrowserContext;
  readingUrl: string;
  localUrl: string;
  navigationTimeout?: number;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<{ reading: Page; requestedUrl: string; url: string; fallback: boolean }>;
export function installedTutorial(options: {
  context: BrowserContext;
  extensionId: string;
  signal?: AbortSignal;
  timeout?: number;
}): Promise<Page>;
export function activateLabPage(options: {
  tutorial?: Page;
  workspace?: Page;
  startupPage: LabStartupPage;
}): Promise<string>;
