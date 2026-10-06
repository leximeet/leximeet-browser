import { test, expect } from "./fixtures";
import { workspace, navigate, addWord, editWord, facts } from "./ui-helpers";

test("真实浏览器配额不足时保留原资料和编辑输入，解除配额后可重试", async ({
  extension,
}, testInfo) => {
  testInfo.setTimeout(90000);
  const page = await workspace(extension);
  const origin = `chrome-extension://${extension.extensionId}`;
  await addWord(page, "resilient");
  await editWord(page, "resilient");
  const note = page.getByRole("textbox", { name: "我的笔记" });
  await note.fill("原来的笔记");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await editWord(page, "resilient");
  // CDP 返回实际覆盖额度；navigator 的隐私化估算值不会随该调试覆盖变化。
  const cdp = await extension.context.newCDPSession(page);
  try {
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1 });
    const override = await cdp.send("Storage.getUsageAndQuota", { origin });
    expect(override.quota).toBe(1);
    expect(override.overrideActive).toBe(true);
    // Chromium IDB 原生剩余空间缓存存活 30 秒，需等缓存失效才能触发实际配额检查。
    await page.waitForTimeout(31000);
    const input = "新的输入保留".repeat(400);
    await note.fill(input);
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByRole("alert")).toContainText("存储空间不足");
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(note).toHaveValue(input);
    await page.screenshot({
      path: testInfo.outputPath("quota-failure-input-preserved.png"),
    });
    const data = await facts(page);
    expect(data.words[0]).not.toHaveProperty("personalMeaning");
    expect(data.words[0].note).toBe("原来的笔记");
    await cdp.send("Storage.overrideQuotaForOrigin", { origin });
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByRole("status")).toContainText("已保存");
    await page.reload();
    await editWord(page, "resilient");
    await expect(page.getByRole("textbox", { name: "我的释义" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "我的笔记" })).toHaveValue(input);
    await page.getByRole("button", { name: "关闭对话框" }).click();
    await navigate(page, "设置");
    await expect(page.locator(".v3-settings")).toContainText("已使用");
    const observed = await page.evaluate(async () => navigator.storage.estimate());
    expect(observed.usage).toBeGreaterThan(0);
    expect(observed.quota).toBeGreaterThan(observed.usage!);
    await testInfo.attach("quota-preservation", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          nativeQuotaOverride: override,
          originalDataPreserved: true,
          draftPreserved: true,
          retrySaved: true,
          currentEstimatedUsageBytes: observed.usage,
          currentEstimatedQuotaBytes: observed.quota,
        }),
      ),
    });
  } finally {
    await cdp.send("Storage.overrideQuotaForOrigin", { origin }).catch(() => {});
    await cdp.detach();
  }
});
