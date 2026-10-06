import path from "node:path";
import { defineConfig } from "@playwright/test";

// 真正双端联调独立于单插件回归；零重试，不借 headed 或 Inspector 抢占输入。
if (
  process.argv.some((arg) =>
    /^(--headed|--debug|--ui(?:-host|-port)?)(?:=|$)/.test(arg),
  ) ||
  (process.env.PWDEBUG && process.env.PWDEBUG !== "0")
)
  throw new Error("双端自动联调仅后台运行；可见人工验收请使用 npm run lab:connected");
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
const reportRoot = process.env.LEXIMEET_TEST_OUTPUT
  ? path.join(process.env.LEXIMEET_TEST_OUTPUT, "connected")
  : "test-results/connected";
export default defineConfig({
  testDir: "tests/connected",
  workers: 1,
  fullyParallel: false,
  timeout: 180000,
  expect: { timeout: 15000 },
  forbidOnly: true,
  retries: 0,
  outputDir: path.join(reportRoot, "artifacts"),
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(reportRoot, "report") }],
    ["json", { outputFile: path.join(reportRoot, "results.json") }],
  ],
  use: {
    headless: true,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
  },
});
