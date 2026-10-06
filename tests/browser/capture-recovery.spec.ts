import { panelTitle } from "./ui-helpers";
import { test, expect } from "./fixtures";
import { readingServer } from "../helpers/extension.cjs";
import { workspace, facts, pickWord } from "./ui-helpers";

test("切换采集确认跨真实 worker 回收恢复，转入管理页确认后收栏且不自动保存", async ({
  extension,
}, info) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  const server = await readingServer(
    "<!doctype html><title>Recovery source</title><style>body{margin:40px;font:22px/1.8 Georgia}</style><p>A resilient reader returns.</p>",
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await pickWord(reading, "resilient");
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    const second = await extension.context.newPage();
    await second.goto(server.url + "/second");
    const dialog = panel.getByRole("dialog", { name: "继续采集吗？" });
    await expect(dialog).toContainText("1 条语境未加入单词本");
    const original = await panel.evaluate(
      async () =>
        (
          await (globalThis as any).chrome.storage.session.get(
            "standaloneCaptureSwitches",
          )
        ).standaloneCaptureSwitches,
    );
    const cdp = await extension.context.newCDPSession(panel);
    await cdp.send("ServiceWorker.enable");
    const workerTarget = (await cdp.send("Target.getTargets")).targetInfos.find(
      (t) => t.type === "service_worker" && t.url === extension.worker.url(),
    )!;
    expect(workerTarget).toBeTruthy();
    await extension.worker.evaluate(() => {
      (globalThis as any).__captureBeforeStop = "before-stop";
    });
    await cdp.send("ServiceWorker.stopAllWorkers");
    // 原生 targetId 可被 Chromium 复用；重新唤醒后必须证明旧执行上下文已销毁。
    // 不能只检查 Playwright 代理的 close 通知，或把同一个 target 当作未重启。
    await dialog.getByRole("button", { name: "继续采集", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(async () => {
        const current = extension.context
          .serviceWorkers()
          .find((w) => w.url() === extension.worker.url());
        return (
          !!current &&
          (await current.evaluate(() => (globalThis as any).__captureBeforeStop)) ===
            undefined
        );
      })
      .toBe(true);
    await expect.poll(() => panelTitle(panel)).toBe("Recovery source");
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    const restored = await panel.evaluate(
      async () =>
        (await (globalThis as any).chrome.storage.session.get("standaloneDrafts"))
          .standaloneDrafts,
    );
    expect(Object.values(restored).flat()).toHaveLength(1);
    await manager.bringToFront();
    await expect(dialog).toContainText("1 条语境未加入单词本");
    await dialog.getByRole("button", { name: "不继续，丢弃未加入", exact: true }).click();
    await expect
      .poll(() =>
        manager.evaluate(() =>
          (globalThis as any).chrome.runtime.getContexts({
            contextTypes: ["SIDE_PANEL"],
          }),
        ),
      )
      .toHaveLength(0);
    expect((await facts(manager)).encounters).toHaveLength(0);
    await reading.bringToFront();
    const reopen = await extension.openPanel(reading);
    await reopen.getByRole("button", { name: "采集", exact: true }).click();
    await expect(reopen.locator(".lm-row")).toHaveCount(0);
    await info.attach("capture-switch-recovery", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          actualWorkerStopped: true,
          originalPending: Object.keys(original).length,
          retainedDraftEvent: (Object.values(restored).flat()[0] as any).eventId,
          managedTabClosedPanelAfterDecision: true,
          noAutomaticFactWrite: true,
        }),
      ),
    });
  } finally {
    await server.close();
  }
});
