import { test, expect } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import { resolve, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { workspace, navigate, addWord, facts } from "./ui-helpers";

async function publicCache(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const r = indexedDB.open("leximeet-text-cache-v1", 1);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
    const tx = db.transaction(["meta", "heads", "entries"]);
    const read = <T>(r: IDBRequest<T>) =>
      new Promise<T>((ok, fail) => {
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      });
    const result = {
      meta: await read(tx.objectStore("meta").getAll()),
      count: await read(tx.objectStore("heads").count()),
      entry: await read(
        tx
          .objectStore("entries")
          .index("lookup")
          .getAll([
            "0.0.3/core-text/8c9392ddf92c3bf3b0f471075b55c5042826a08129c4aa1efbbe9cd922926317",
            "abandoning",
          ]),
      ),
    };
    db.close();
    return {
      meta: result.meta,
      count: result.count,
      abandoning: result.entry
        .filter((e: any) => e.entry_id === "99a4bd1f-b5e0-594c-847a-57c0ca651cf1")
        .map((e: any) => e.headword),
    };
  });
}
/** 先等真实事务提交后的 UI 进度，再核对 IDB；持续读 entries 会与安装写事务争用队列。
 * 维护者确认阶段等待为 15 秒；真实安装完成与整例预算仍为 120/180 秒。 */
async function stagedBeyond(page: Page, count: number) {
  await expect
    .poll(
      async () => {
        const text = await page.getByRole("dialog").innerText();
        return Number(text.match(/安装 (\d+) \/ /)?.[1] || 0);
      },
      { timeout: 15000 },
    )
    .toBeGreaterThan(count);
  expect((await publicCache(page)).count).toBeGreaterThan(count);
}

test("正式 91,485 词 Core 增量：取消、半包重开、幂等重试与切换保留全部个人事实", async ({
  extension,
}, info) => {
  info.setTimeout(180000);
  const delta = resolve(
    process.env.LEXIMEET_DICTIONARY_RELEASE_DIR ||
      "../../leximeet-dictionary/dist/v0.0.3",
    "entries-core-delta.jsonl.zst",
  );
  let page: Page = await workspace(extension);
  // 本例验证日常词典升级：通过真实按钮退出教学，不修改引导状态或权限。
  await page.getByRole("button", { name: "跳过引导", exact: true }).click();
  await expect(page.getByRole("region", { name: "真实操作引导" })).toHaveCount(0);
  await addWord(page, "resilient");
  const before = await facts(page);
  await navigate(page, "词库中心");
  await page.getByRole("button", { name: "本地词典", exact: true }).click();
  await page.getByRole("button", { name: "增量升级", exact: true }).click();
  const bad = await readFile(delta);
  bad[bad.length >> 1] = bad[bad.length >> 1]! ^ 1;
  const invalid = join(extension.root, "corrupt-core-delta.zst");
  await writeFile(invalid, bad);
  await page.locator('input[type=file][accept=".zst"]').setInputFiles(invalid);
  await expect(page.getByRole("alert")).toContainText("哈希不符");
  await expect(page.getByRole("switch", { name: "Lite Text 已启用" })).toBeVisible();
  expect((await publicCache(page)).count).toBe(0);
  expect(await facts(page)).toEqual(before);

  // 只延迟真实清单响应，不修改内容、浏览器 API 或安装结果。
  const manifestURL = `chrome-extension://${extension.extensionId}/dictionaries/core/release.json`;
  let manifestArrived!: (route: Route) => void;
  const manifestHeld = new Promise<Route>((resolve) => {
    manifestArrived = resolve;
  });
  await page.route(manifestURL, (route) => manifestArrived(route));
  await page.locator('input[type=file][accept=".zst"]').setInputFiles(delta);
  const pendingManifest = await manifestHeld;
  const abortedManifest = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url() === manifestURL,
  });
  await page.getByRole("button", { name: "取消安装", exact: true }).click();
  await pendingManifest.continue();
  const failedRequest = await abortedManifest;
  expect(failedRequest.failure()?.errorText).toBe("net::ERR_ABORTED");
  await page.unroute(manifestURL);
  await expect(
    page.getByRole("button", { name: "选择本地增量包", exact: true }),
  ).toBeEnabled();
  expect(page.workers()).toHaveLength(0);
  expect((await publicCache(page)).count).toBe(0);
  expect(await facts(page)).toEqual(before);

  // 首批实际 IndexedDB 事务提交后取消；半包必须没有 ready/active 指针。
  await page.locator('input[type=file][accept=".zst"]').setInputFiles(delta);
  await stagedBeyond(page, 0);
  await page.getByRole("button", { name: "取消安装", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "选择本地增量包", exact: true }),
  ).toBeEnabled();
  const cancelledCache = await publicCache(page);
  expect(cancelledCache.count).toBeGreaterThan(0);
  expect(cancelledCache.count).toBeLessThan(91485);
  expect(cancelledCache.meta).not.toContain(117902);
  expect(cancelledCache.meta).not.toContain("core-text");
  await expect(page.getByRole("switch", { name: "Lite Text 已启用" })).toBeVisible();
  expect(await facts(page)).toEqual(before);

  // 重试到新增批次落盘时关闭整个自有浏览器，不能用 reload 冒充进程重开。
  await page.locator('input[type=file][accept=".zst"]').setInputFiles(delta);
  await stagedBeyond(page, cancelledCache.count);
  await extension.restart();
  page = await workspace(extension);
  await expect(page.getByRole("region", { name: "真实操作引导" })).toHaveCount(0);
  expect(
    await extension.worker.evaluate(
      async () =>
        (await (globalThis as any).chrome.storage.local.get("leximeet-onboarding-v2"))[
          "leximeet-onboarding-v2"
        ].active,
    ),
  ).toBe(false);
  await navigate(page, "词库中心");
  await page.getByRole("button", { name: "本地词典", exact: true }).click();
  const interruptedCache = await publicCache(page);
  expect(interruptedCache.count).toBeGreaterThan(cancelledCache.count);
  expect(interruptedCache.count).toBeLessThan(91485);
  expect(interruptedCache.meta).not.toContain(117902);
  expect(interruptedCache.meta).not.toContain("core-text");
  await expect(page.getByRole("switch", { name: "Lite Text 已启用" })).toBeVisible();
  expect(await facts(page)).toEqual(before);
  await page.getByRole("button", { name: "增量升级", exact: true }).click();
  await page.locator('input[type=file][accept=".zst"]').setInputFiles(delta);
  await expect(page.getByRole("switch", { name: "Core Text 已启用" })).toBeVisible({
    timeout: 120000,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await publicCache(page)).toMatchObject({
    count: 91485,
    abandoning: ["abandoning"],
  });
  expect(await facts(page)).toEqual(before);

  // 用正式查词弹窗读取仅 Core 存在的词卡，确认完整 JSON 缓存仍能投影为可用释义。
  await navigate(page, "我的词库");
  await page.getByRole("button", { name: "添加单词", exact: true }).click();
  const lookupDialog = page.getByRole("dialog", { name: "查词与添加" });
  await lookupDialog.getByRole("textbox", { name: "输入英文单词" }).fill("abandoning");
  await expect(
    lookupDialog.getByRole("heading", { name: "abandoning", exact: true }),
  ).toBeVisible();
  await expect(lookupDialog.locator(".v3-card-summary")).toContainText("放弃");
  await lookupDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(lookupDialog).toHaveCount(0);
  expect(await facts(page)).toEqual(before);
  await extension.restart();
  page = await workspace(extension);
  await expect(page.getByRole("region", { name: "真实操作引导" })).toHaveCount(0);
  expect(
    await extension.worker.evaluate(
      async () =>
        (await (globalThis as any).chrome.storage.local.get("leximeet-onboarding-v2"))[
          "leximeet-onboarding-v2"
        ].active,
    ),
  ).toBe(false);
  await navigate(page, "词库中心");
  await page.getByRole("button", { name: "本地词典", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Core Text 已启用" })).toBeVisible();
  const liteRow = page.locator(".v3-dictionary-row").filter({ hasText: "Lite Text" });
  await liteRow.getByRole("button", { name: "切换使用" }).click();
  await expect(page.getByRole("switch", { name: "Lite Text 已启用" })).toBeVisible();
  expect((await publicCache(page)).count).toBe(91485);
  expect(await facts(page)).toEqual(before);
  await page
    .locator(".v3-dictionary-row")
    .filter({ hasText: "Core Text" })
    .getByRole("button", { name: "切换使用" })
    .click();
  await expect(page.getByRole("switch", { name: "Core Text 已启用" })).toBeVisible();
  await info.attach("core-text-native", {
    body: Buffer.from(
      JSON.stringify({
        rawDeltaBytes: 50843911,
        stagedEntries: 91485,
        totalEntries: 117902,
        corruptedHashRejectedBeforeStaging: true,
        manifestRequestAbortedBeforeWorker: true,
        cancelledStagedEntries: cancelledCache.count,
        interruptedStagedEntries: interruptedCache.count,
        incompletePackageNeverActive: true,
        retryDidNotDuplicateEntries: true,
        nativeWorker: true,
        restartedProcess: true,
        factsUnchanged: true,
        coreOnlyCardLookup: true,
      }),
    ),
    contentType: "application/json",
  });
});
