import path from "node:path";
import { defineConfig } from "@playwright/test";
// 统一所有 fixture、lab 和子进程的运行方式；可见调试只能显式开启。
const visible = process.env.LEXIMEET_TEST_VISIBLE;
if (visible !== undefined && visible !== "0" && visible !== "1")
  throw new Error("LEXIMEET_TEST_VISIBLE 仅支持 0 或 1");
const reportRoot = process.env.LEXIMEET_TEST_OUTPUT
  ? path.join(process.env.LEXIMEET_TEST_OUTPUT, "browser")
  : ".";
// 固定 Playwright 版本才能使用此原生侧栏适配；升级时必须通过 native context 断言。
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  // 本地贡献者与 CI 采用同一门槛，防止误留 test.only 后提交不完整验收。
  forbidOnly: true,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: path.join(reportRoot, "playwright-report/browser"),
      },
    ],
    ["junit", { outputFile: path.join(reportRoot, "test-results/reports/browser.xml") }],
    [
      "json",
      {
        outputFile: path.join(reportRoot, "test-results/reports/browser.json"),
      },
    ],
  ],
  outputDir: path.join(reportRoot, "test-results/browser"),
  use: {
    headless: visible !== "1",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  },
});
