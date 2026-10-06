import { test, expect, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  startConnectedLab,
  type ConnectedLabSession,
} from "../../scripts/launch-connected-lab.mjs";
import { addWord, facts, navigate, pickWord } from "../browser/ui-helpers.ts";

import {
  withLab,
  connection,
  independentFacts,
  desktopQuery,
  prepareDesktopSettings,
  pairThroughUi,
  disconnectThroughUi,
} from "./helpers.ts";

// A 是原独立词库，B 是桌面原有内容，C 是真实网页采集；绝不互相导入合并。
test("真实 Native 链路：独立资料封存、桌面读卡与采集写入、明确断开恢复 A", async ({}, info) => {
  await withLab(info, async (lab) => {
    const manager = lab.workspace;
    const skip = manager.getByRole("button", { name: "跳过引导", exact: true });
    if (await skip.count()) await skip.click();
    await addWord(manager, "network");
    const original = independentFacts(await facts(manager));
    await lab.desktopPage!.evaluate(() =>
      (globalThis as any).leximeet.desktopCommand({
        action: "collect",
        word: "system",
        note: "桌面原有 B；连接不能覆盖",
      }),
    );
    expect(
      (await desktopQuery(lab, { scope: "manual", search: "network" })).words,
    ).toHaveLength(0);
    await pairThroughUi(lab);
    expect(independentFacts(await facts(manager))).toEqual(original);
    // 管理/学习入口让位 Desktop，连接设置只留下断开。
    await expect(manager.getByRole("navigation", { name: "工作区导航" })).toHaveCount(0);
    await expect(manager.getByRole("textbox", { name: "桌面配对码" })).toHaveCount(0);
    await manager
      .getByRole("navigation", { name: "管理导航" })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await expect(
      manager.getByRole("button", {
        name: "断开连接，恢复独立使用",
        exact: true,
      }),
    ).toBeVisible();
    let panel = await lab.openPanel();
    await expect(panel.getByRole("contentinfo", { name: "运行状态" })).toContainText(
      "已连接桌面端",
    );
    await panel.getByRole("button", { name: "分析本页", exact: true }).click();
    await expect(panel.getByRole("region", { name: "遇见单词列表" })).toContainText(
      /system/i,
    );
    await panel
      .locator(".lm-row")
      .filter({ hasText: /^system/i })
      .first()
      .click();
    await expect(
      panel.getByRole("article", { name: "桌面词卡", exact: true }),
    ).toContainText("桌面原有 B");
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    await pickWord(lab.reading, "resilient");
    await expect(panel.locator(".lm-row")).toHaveCount(1);
    await expect(panel.locator(".lm-detail h2")).toHaveText("resilient");
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect
      .poll(async () => (await desktopQuery(lab, { kind: "encounters" })).total)
      .toBe(1);
    const stored = (await desktopQuery(lab, { kind: "encounters" })).encounters;
    expect(stored).toHaveLength(1);
    const saved = stored[0]!;
    expect(saved.word).toBe("resilient");
    expect(saved.context).toContain("resilient");
    expect(saved.sourceUrl).toBe(lab.url);
    const systemRows = (await desktopQuery(lab, { scope: "manual", search: "system" }))
      .words;
    expect(systemRows).toHaveLength(1);
    expect(systemRows[0]!.note).toBe("桌面原有 B；连接不能覆盖");
    expect(
      (await desktopQuery(lab, { scope: "manual", search: "network" })).words,
    ).toHaveLength(0);
    expect(independentFacts(await facts(manager))).toEqual(original);
    await manager.bringToFront();
    await disconnectThroughUi(manager);
    await expect
      .poll(() => connection(manager))
      .toMatchObject({ mode: "independent", status: "independent" });
    await expect(manager.getByRole("navigation", { name: "工作区导航" })).toBeVisible();
    expect(independentFacts(await facts(manager))).toEqual(original);
    expect((await desktopQuery(lab, { kind: "encounters" })).total).toBe(1);
    await navigate(manager, "我的词库");
    await expect(
      manager.locator(".v3-table-body").getByRole("button", { name: /^network\s/ }),
    ).toContainText("network");
    // 只在实际恢复的独立列表可读后留图，与失败轮切换锁造成的 loading 对照。
    await info.attach("owner-restored-library-after", {
      body: await manager.screenshot(),
      contentType: "image/png",
    });
    lab.evidence.scenarios = {
      actualNativePanel: true,
      pairingByProductUi: true,
      frozenA: true,
      desktopBPreserved: true,
      captureCOnlyDesktop: true,
      explicitDisconnectRestoresA: true,
    };
    expect(lab.evidence.nativePanel).toBe(true);
  });
});

test("真实双进程重启和撤权：临时断线不退回独立库，原配对恢复后撤销仍封存", async ({}, info) => {
  await withLab(info, async (lab) => {
    await addWord(lab.workspace, "network");
    const original = independentFacts(await facts(lab.workspace));
    await pairThroughUi(lab);
    const firstDesktopPid = lab.evidence.processes.desktop[0];
    await lab.stopDesktop();
    await expect
      .poll(() => connection(lab.workspace))
      .toMatchObject({ mode: "desktop", status: "reconnecting" });
    await expect(
      lab.workspace.locator('main[data-workspace-mode="desktop"]'),
    ).toHaveAttribute("data-desktop-state", "reconnecting");
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    await lab.restartBrowser();
    await expect
      .poll(() => connection(lab.workspace))
      .toMatchObject({ mode: "desktop", status: "reconnecting" });
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    await lab.restartDesktop();
    expect(lab.evidence.processes.desktop.at(-1)).not.toBe(firstDesktopPid);
    // 业务恢复通过用户再次操作阅读入口触发真实 ResumeSession，不新建连接邀请。
    const panel = await lab.openPanel();
    await panel.getByRole("button", { name: "分析本页", exact: true }).click();
    await expect
      .poll(() => connection(lab.workspace))
      .toMatchObject({ mode: "desktop", status: "connected" });
    await prepareDesktopSettings(lab);
    const desktop = lab.desktopPage!;
    await expect(desktop.locator(".connection-device .connection-online")).toHaveText(
      "连接成功",
    );
    await desktop.getByRole("button", { name: "撤销授权", exact: true }).click();
    await desktop.getByRole("button", { name: "确认撤销", exact: true }).click();
    await expect
      .poll(() => connection(lab.workspace))
      .toMatchObject({ mode: "desktop", status: "reconnecting" });
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    await lab.workspace.bringToFront();
    await disconnectThroughUi(lab.workspace);
    await expect
      .poll(() => connection(lab.workspace))
      .toMatchObject({ mode: "independent", status: "independent" });
    expect(independentFacts(await facts(lab.workspace))).toEqual(original);
    lab.evidence.scenarios = {
      realBrowserRestart: true,
      realDesktopRestart: true,
      noSilentFallback: true,
      resumeWithoutPairingAgain: true,
      revokedStillFrozen: true,
      explicitIndependentRestore: true,
    };
  });
});

async function portClosed(url: string) {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: Number(new URL(url).port),
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) =>
      (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
        ? resolve(true)
        : reject(error),
    );
  });
}

test("双端隔离 CLI 收到 SIGINT 退出且只撤销本轮 Native 注册、资料与端口", async ({}, info) => {
  const child = spawn(
    process.execPath,
    [path.resolve("scripts/launch-connected-lab.mjs"), "--no-build", "--headless"],
    {
      cwd: process.cwd(),
      env: { ...process.env, LEXIMEET_LAB_URL: "local" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<{ root: string; url: string }>((resolve, reject) => {
    const inspect = (value: Buffer) => {
      output += value.toString();
      const root = /临时资料：([^\n]+)/.exec(output)?.[1],
        url = /阅读页：(http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)?.[1];
      if (root && url) resolve({ root, url });
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", () => reject(new Error("双端 CLI 就绪前退出：" + output)));
  });
  try {
    const session = await ready;
    expect(output).toContain("运行方式：无界面自动化");
    expect(session.root).toContain("lmcp-lab-");
    expect(fs.existsSync(session.root)).toBe(true);
    expect((await fetch(session.url)).status).toBe(200);
    expect(child.kill("SIGINT")).toBe(true);
    expect(await exit).toEqual({ code: 130, signal: null });
    expect(fs.existsSync(session.root)).toBe(false);
    expect(await portClosed(session.url)).toBe(true);
    expect(output).toContain("本轮临时资料和 Native 注册已清理");
    // 真实 CLI 另存完整监测结果；显式核对并带入当前报告，不能只凭退出码推断焦点安全。
    const recordFile = /本轮记录：([^\n]+)/.exec(output)?.[1];
    expect(recordFile).toBeTruthy();
    const boundary = JSON.parse(fs.readFileSync(recordFile!, "utf8"));
    expect(boundary.focus.complete).toBe(true);
    expect(boundary.focus.violations).toEqual([]);
    expect(boundary.desktopBackground.violations).toEqual([]);
    expect(boundary.cleanupErrors).toEqual([]);
    expect(boundary.productionBytesUnchanged).toBe(true);
    expect(boundary.profileRemoved).toBe(true);
    await info.attach("connected-cli-boundary", {
      body: Buffer.from(
        JSON.stringify({
          versions: boundary.versions,
          focus: boundary.focus,
          desktopBackground: boundary.desktopBackground,
          cleanupErrors: boundary.cleanupErrors,
          profileRemoved: boundary.profileRemoved,
          productionBytesUnchanged: boundary.productionBytesUnchanged,
          stoppedAt: boundary.stoppedAt,
          stopReason: boundary.stopReason,
        }),
      ),
      contentType: "application/json",
    });
    await info.attach("connected-signal", {
      body: Buffer.from(
        JSON.stringify({
          headless: true,
          signal: "SIGINT",
          exitCode: 130,
          profileRemoved: true,
          loopbackClosed: true,
        }),
      ),
      contentType: "application/json",
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exit;
    }
  }
});
