import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";
// 需要真实已构建的前一候选，不修改版本号或以页面reload冒充软件替换。
export default defineConfig({
  ...base,
  testDir: "tests/upgrade",
  timeout: 120000,
});
