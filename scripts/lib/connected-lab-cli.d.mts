export interface ConnectedCliSession {
  headless: boolean;
  closed: Promise<void>;
  close(): Promise<void>;
  stopDesktop(): Promise<void>;
  restartDesktop(): Promise<void>;
}
interface CliOptions {
  headless: boolean;
  readingUrl?: string;
  outputDir?: string;
}
interface CliWorker {
  postMessage(value: unknown): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
}
// 仅命名操作的控制桥接；不传递 Playwright 页面或受保护的 Native 凭据。
export function startConnectedCliWorker(config: {
  entrypoint: URL;
  options: CliOptions;
  signal?: AbortSignal;
  onStatus?: (text: string) => void;
  createWorker?: (
    file: URL,
    config: { workerData: { kind: string; options: CliOptions } },
  ) => CliWorker;
}): Promise<ConnectedCliSession>;
