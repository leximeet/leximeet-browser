import { test as base, expect, chromium } from "@playwright/test";
import { launchExtension, type ExtensionHarness } from "../helpers/extension.cjs";
// 每个用例建立新 MV3 / IndexedDB / Native 注册空间，禁止 beforeAll 共享用户状态。
export const test = base.extend<{ extension: ExtensionHarness }>({
  extension: async ({ headless }, use, testInfo) => {
    const extension = await launchExtension({
      chromium,
      expect,
      testInfo,
      headless,
      manageTrace: false,
    });
    try {
      await use(extension);
    } finally {
      await extension.close();
    }
  },
});
export { expect, chromium };
