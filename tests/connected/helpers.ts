import { expect, type Page, type TestInfo } from "@playwright/test";
import {
  startConnectedLab,
  type ConnectedLabSession,
} from "../../scripts/launch-connected-lab.mjs";
import { facts } from "../browser/ui-helpers.ts";
type BrowserApi = typeof import("wxt/browser").browser;
// 本套件必须连接生产 Main/Core；不存在时失败，不回退假 Desktop 或旧 LMCP。
export async function withLab(
  info: TestInfo,
  run: (lab: ConnectedLabSession) => Promise<void>,
) {
  const lab = await startConnectedLab({
    headless: true,
    readingUrl: "local",
    outputDir: info.outputPath("lab"),
    onStatus: () => {},
  });
  let failure: unknown;
  lab.evidence.testScenarioPassed = false;
  try {
    // 业务 seed 前观察启动通知，保留原 60 秒绝对截止，不把后续资料准备算进发现。
    await waitForDiscoveryNotification(lab);
    await run(lab);
  } catch (error) {
    failure = error;
    try {
      const browser = await lab.workspace.evaluate(async () => {
        const response = await (
          globalThis as unknown as { chrome: BrowserApi }
        ).chrome.runtime.sendMessage({
          channel: "leximeet",
          action: "desktop-discovery-state",
          data: {},
        });
        return {
          view: response.ok ? response.result : { error: response.error },
          permission: await (
            globalThis as unknown as { chrome: BrowserApi }
          ).chrome.notifications.getPermissionLevel(),
          notifications: Object.keys(
            await (
              globalThis as unknown as { chrome: BrowserApi }
            ).chrome.notifications.getAll(),
          ),
        };
      });
      const desktop = await lab.desktopPage!.evaluate(() =>
        (
          globalThis as unknown as {
            leximeet: {
              connectionSettings(input: { action: string }): Promise<unknown>;
            };
          }
        ).leximeet.connectionSettings({ action: "state" }),
      );
      await info.attach("safe-discovery-diagnostic", {
        body: Buffer.from(
          JSON.stringify(
            { capturedAt: new Date().toISOString(), browser, desktop },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
    } catch {
      // 诊断失败不替换业务原错，不读私有票据。
    }
    const panel = lab.context
      .pages()
      .find(
        (page) => page.url() === `chrome-extension://${lab.extensionId}/sidepanel.html`,
      );
    if (panel && !panel.isClosed()) {
      try {
        const projection = await panel.evaluate(async () => {
          const api = (globalThis as unknown as { chrome: BrowserApi }).chrome;
          const window = await api.windows.getCurrent();
          const response = await api.runtime.sendMessage({
            channel: "leximeet",
            action: "state",
            data: { windowId: window.id },
          });
          if (!response.ok) throw new Error(response.error);
          const { currentPage, page, storage, connection } = response.result;
          return {
            currentPage,
            storage,
            connectionStatus: connection.status,
            alerts: [...document.querySelectorAll('[role="alert"],.lm-error')].map(
              (node) => node.textContent,
            ),
            tabs: (await api.tabs.query({ windowId: window.id })).map(
              ({ id, url, active }) => ({ id, url, active }),
            ),
            page: page && {
              phase: page.phase,
              resultMode: page.resultMode,
              message: page.message,
              occurrenceSurfaces: page.occurrences.map(
                (item: { surface: string }) => item.surface,
              ),
            },
          };
        });
        await info.attach("safe-reading-final", {
          body: Buffer.from(JSON.stringify(projection, null, 2)),
          contentType: "application/json",
        });
        await info.attach("connected-panel", {
          body: await panel.screenshot(),
          contentType: "image/png",
        });
      } catch {
        // 失败只读诊断不替换原始业务错误。
      }
    }
    for (const [label, page] of [
      ["browser", lab.workspace],
      ["reading", lab.reading],
      ["desktop", lab.desktopPage],
    ] as const)
      if (page && !page.isClosed())
        try {
          await info.attach(`connected-${label}`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
        } catch {
          // 截图失败不覆盖原始业务错误。
        }
  } finally {
    try {
      await lab.close();
    } catch (error) {
      failure ||= error;
    }
  }
  try {
    if (failure) throw failure;
    expect(lab.evidence.manifestUnchanged).toBe(true);
    expect(lab.evidence.productionBytesUnchanged).toBe(true);
    expect(lab.evidence.headless).toBe(true);
    expect(lab.evidence.desktopRuntime.coreConnected).toBe(true);
    expect(lab.evidence.desktopBackground.violations).toEqual([]);
    expect(lab.evidence.focus.complete).toBe(true);
    expect(lab.evidence.focus.violations).toEqual([]);
    expect(lab.evidence.cleanupErrors).toEqual([]);
    expect(lab.evidence.profileRemoved).toBe(true);
    // 只有业务、生产字节、完整焦点监测与退出边界全部通过，才标当前单例通过。
    lab.evidence.testScenarioPassed = true;
  } finally {
    lab.saveEvidence();
    await info.attach("connected-boundary", {
      body: Buffer.from(JSON.stringify(lab.evidence, null, 2)),
      contentType: "application/json",
    });
  }
}

import { createConnectionUi } from "./connection-ui.mjs";
export const {
  connection,
  independentFacts,
  desktopQuery,
  prepareDesktopSettings,
  discoveredNotification,
  waitForDiscoveryNotification,
  invitationPopup,
  requestInvitation,
  pairThroughUi,
  disconnectThroughUi,
} = createConnectionUi(expect);
