import { panelTitle, closeNativePanel } from "./ui-helpers";
import { nativePanel, pickWord } from "./ui-helpers";
import { test, expect } from "./fixtures";
import { readingServer } from "../helpers/extension.cjs";

const articleHtml = (
  title: string,
  word: string,
) => `<!doctype html><html><head><title>${title}</title>
<style>body{margin:56px;max-width:720px;font:22px/1.9 Georgia;background:#fafbf9;color:#24392e}h1{font-size:44px}</style></head>
<body><h1>The quiet art of beginning again</h1><p id="line">A ${word} reader does not finish every book. Instead, she learns to begin again.</p>
<button id="site-action" onclick="this.textContent='网页按钮正常可用'">网页原有按钮</button><p><a href="/next">Continue reading</a></p></body></html>`;

test("窗口级原生侧栏跨标签保持打开，当前来源与草稿隔离，关闭后工具栏可重新打开", async ({
  extension,
}, info) => {
  const server = await readingServer((url) =>
    articleHtml(
      url.startsWith("/a") ? "阅读页 A" : "阅读页 B",
      url.startsWith("/a") ? "resilient" : "attention",
    ),
  );
  try {
    const a = await extension.context.newPage();
    await a.goto(server.url + "/a");
    const panel = await extension.openPanel(a);
    await expect.poll(() => panelTitle(panel)).toBe("阅读页 A");
    const original = (await panel.evaluate(() =>
      (globalThis as any).chrome.runtime.getContexts({
        contextTypes: ["SIDE_PANEL"],
      }),
    )) as { documentId: string }[];
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    await pickWord(a, "resilient");
    await expect(panel.getByText("待加入语境 · 1 条")).toBeVisible();
    // 跨过 6 秒保护租约：真实面板必须持续续租，编辑中的网页采集不能自行结束。
    await panel.waitForTimeout(6500);
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    const b = await extension.context.newPage();
    await b.goto(server.url + "/b");
    await expect.poll(() => panelTitle(panel)).not.toBe("阅读页 A");
    await expect(panel.locator(".lm-detail h2")).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "开始采集", exact: true }),
    ).toBeDisabled();
    const switched = (await panel.evaluate(() =>
      (globalThis as any).chrome.runtime.getContexts({
        contextTypes: ["SIDE_PANEL"],
      }),
    )) as { documentId: string }[];
    expect(switched.map((item) => item.documentId)).toEqual(
      original.map((item) => item.documentId),
    );
    let switching = panel.getByRole("dialog", { name: "继续采集吗？" });
    await expect(switching).toContainText("1 条语境未加入单词本");
    await switching.getByRole("button", { name: "继续采集", exact: true }).click();
    await expect.poll(() => panelTitle(panel)).toBe("阅读页 A");
    await expect(
      panel.getByRole("button", { name: "结束采集", exact: true }),
    ).toBeVisible();
    await expect(panel.getByText("待加入语境 · 1 条")).toBeVisible();
    await b.bringToFront();
    await expect(switching).toBeVisible();
    await switching
      .getByRole("button", { name: "不继续，丢弃未加入", exact: true })
      .click();
    await expect(switching).toHaveCount(0);
    await extension.openPanel(b);
    await expect.poll(() => panelTitle(panel)).toBe("阅读页 B");
    await expect(panel.getByText("待加入语境 · 1 条")).toHaveCount(0);
    await b.reload();
    await expect.poll(() => panelTitle(panel)).toBe("阅读页 B");
    await a.bringToFront();
    await expect.poll(() => panelTitle(panel)).toBe("阅读页 A");
    await expect(panel.getByText("待加入语境 · 1 条")).toHaveCount(0);
    await a.getByRole("button", { name: "网页原有按钮", exact: true }).click();
    await expect(a.locator("#site-action")).toHaveText("网页按钮正常可用");
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await pickWord(a, "resilient");
    await expect(panel.getByText("待加入语境 · 1 条")).toBeVisible();
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect(panel.locator(".lm-local-banner")).toContainText("1 词");
    await panel.screenshot({ path: info.outputPath("after-panel-light.png") });
    const host = a.locator("leximeet-page-ui");
    const ball = host.locator(".ball");
    await closeNativePanel(panel);
    await expect(ball).toBeVisible();
    await extension.openPanel(a);
    await expect
      .poll(() =>
        extension.context.pages().some((page) => page.url().endsWith("/sidepanel.html")),
      )
      .toBe(true);
    const reopened = extension.context
      .pages()
      .find((page) => page.url().endsWith("/sidepanel.html"))!;
    await expect.poll(() => panelTitle(reopened)).toBe("阅读页 A");
    expect(
      (
        await reopened.evaluate(() =>
          (globalThis as any).chrome.runtime.getContexts({
            contextTypes: ["SIDE_PANEL"],
          }),
        )
      ).length,
    ).toBe(1);
    // 未授权受限页不复用 A 的来源或草稿，工作页入口依然可用。
    const restricted = await extension.context.newPage();
    await restricted.goto("chrome://version");
    await expect.poll(() => panelTitle(reopened)).not.toBe("阅读页 A");
    await expect(reopened.locator(".lm-detail h2")).toHaveCount(0);
    await expect(
      reopened.getByRole("button", { name: "打开管理", exact: true }),
    ).toBeEnabled();
    await info.attach("cross-tab-context", {
      body: Buffer.from(JSON.stringify({ original, switched }, null, 2)),
      contentType: "application/json",
    });
  } finally {
    await server.close();
  }
});

test("默认网站入口和 Chrome 收回权限后停止注入；浮球展开、连续拖动、固定、本站隐藏与恢复", async ({
  extension,
}, info) => {
  const server = await readingServer(articleHtml("阅读练习 · 词遇", "resilient"));
  try {
    const a = await extension.context.newPage();
    await a.goto(server.url + "/first");
    await expect(a.locator("leximeet-page-ui .ball")).toBeVisible();
    expect(
      await extension.worker.evaluate(() =>
        (globalThis as any).chrome.runtime.getContexts({
          contextTypes: ["SIDE_PANEL"],
        }),
      ),
    ).toHaveLength(0);
    let panel = await extension.openPanel(a);
    await expect(a.locator("leximeet-page-ui .ball")).toBeVisible();
    await closeNativePanel(panel);
    const b = await extension.context.newPage();
    await b.goto(server.url + "/second");
    const host = b.locator("leximeet-page-ui");
    const ball = host.locator(".ball");
    const tip = host.locator(".ball-tip");
    await expect(ball).toBeVisible();
    panel = await extension.openPanel(b);
    await expect(ball).toBeVisible();
    await expect.poll(() => panelTitle(panel)).toBe("阅读练习 · 词遇");
    await closeNativePanel(panel);
    await expect(ball).toBeVisible();
    await b.mouse.move(40, 40); // 原生侧栏关闭后先移出浮球，再核对默认菜单收起。
    await expect(tip).toBeHidden();
    const original = await b.locator("#line").evaluate((line) => ({
      html: line.outerHTML,
      rect: JSON.stringify(line.getBoundingClientRect()),
    }));
    await ball.hover();
    await expect(tip).toContainText("单击开关遇见");
    await expect(tip.getByRole("button")).toHaveCount(0);
    await b.screenshot({ path: info.outputPath("after-float-light.png") });
    await b.mouse.down();
    await b.mouse.move(280, 240, { steps: 12 });
    await expect(ball).toHaveClass(/dragging/);
    expect((await ball.boundingBox())!.x).toBeGreaterThan(150);
    await b.mouse.move(36, 180, { steps: 8 });
    await b.mouse.up();
    await expect(ball).not.toHaveClass(/dragging/);
    await b.mouse.move(420, 40);
    await expect(tip).toBeHidden();
    // 左侧吸边也应保留半隐藏位置的热区；静止在页面最外沿不会令菜单闪回。
    // hidden 是收起动画的开始；等真正露出半球后，再从那个可见位置移入。
    await expect(ball).toHaveCSS("transform", "matrix(1, 0, 0, 1, -28, 0)");
    const left = await ball.boundingBox();
    await b.mouse.move(2, left!.y + 23);
    await expect(ball).toHaveCSS("transform", "none");
    await b.waitForTimeout(400); // 覆盖收起延迟，模拟用户停在原位置。
    await expect(tip).toBeVisible();
    await expect(ball).toHaveCSS("transform", "none");
    await b.mouse.move(420, 40);
    await expect(tip).toBeHidden();
    await ball.hover();
    const workspace = await extension.context.newPage();
    await workspace.goto(`chrome-extension://${extension.extensionId}/options.html`);
    await workspace.getByRole("button", { name: "设置", exact: true }).click();
    await workspace.getByRole("checkbox", { name: "固定位置", exact: true }).check();
    await b.bringToFront();
    await expect(ball).toHaveClass(/locked/);
    await b.mouse.move(420, 40);
    await expect.poll(async () => (await ball.boundingBox())!.x).toBe(12);
    await b.reload();
    await expect(ball).toHaveClass(/locked/);
    await expect.poll(async () => (await ball.boundingBox())!.x).toBe(12);
    await workspace.bringToFront();
    await workspace.getByRole("button", { name: "隐藏悬浮球", exact: true }).click();
    await expect(ball).toBeHidden();
    await workspace
      .getByRole("button", { name: "恢复已隐藏网站的悬浮球", exact: true })
      .click();
    await workspace.getByLabel("主题").selectOption("dark");
    await b.bringToFront();
    await extension.openPanel(b);
    await expect
      .poll(() =>
        extension.worker.evaluate(
          async () =>
            (
              await (globalThis as any).chrome.runtime.getContexts({
                contextTypes: ["SIDE_PANEL"],
              })
            ).length,
        ),
      )
      .toBe(1);
    panel = await nativePanel(extension.context);
    await expect(ball).toBeVisible();
    await expect(host).toHaveAttribute("data-theme", "dark");
    await panel.screenshot({ path: info.outputPath("after-panel-dark.png") });
    await closeNativePanel(panel);
    await expect(ball).toBeVisible();
    await ball.hover();
    await b.screenshot({ path: info.outputPath("after-float-dark.png") });
    const current = await b.locator("#line").evaluate((line) => ({
      html: line.outerHTML,
      rect: JSON.stringify(line.getBoundingClientRect()),
    }));
    expect(current).toEqual(original);
    expect(
      await b.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    ).toBe(false);
    await workspace.bringToFront();
    const opened = extension.context.waitForEvent("page");
    await workspace
      .getByRole("button", { name: "管理网站访问权限", exact: true })
      .click();
    const consent = await opened;
    await expect(consent).toHaveURL(`chrome://extensions/?id=${extension.extensionId}`);
    // 调用 Chrome 自己的网站设置 API 收回访问；未改 profile、扩展 API 或 manifest。
    await consent.evaluate(async (id) => {
      await (globalThis as any).chrome.developerPrivate.updateExtensionConfiguration({
        extensionId: id,
        hostAccess: "ON_CLICK",
      });
    }, extension.extensionId);
    await consent.close();
    // 已点工具栏的旧标签仍有 activeTab 临时访问；新标签才验证收回常驻权限后的行为。
    const revoked = await extension.context.newPage();
    await revoked.goto(server.url + "/revoked");
    await expect(revoked.locator("leximeet-page-ui")).toHaveCount(0);
  } finally {
    await server.close();
  }
});
