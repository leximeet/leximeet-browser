import { closeNativePanel } from "./ui-helpers";
import { test, expect } from "./fixtures";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { launchExtension, readingServer } from "../helpers/extension.cjs";
test("真实 MV3 初始为空；明暗设置与本机词本跨侧栏共享", async ({
  extension,
}, testInfo) => {
  const { context } = extension;
  const article = await context.newPage();
  await article.route("https://reading.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Empty fixture</title><p>A book.</p>",
    }),
  );
  await article.goto("https://reading.example.test/initial");
  let panel = await extension.openPanel(article);
  await expect(panel.locator(".lm-local-banner")).toContainText("我的词库0 词");
  await expect(panel.getByText("遇见，从这里开始", { exact: true })).toBeVisible();
  await expect(panel.locator(".lm-row")).toHaveCount(0);
  await expect(
    panel.getByText("分析当前网页，查看目标与已采集的词。", { exact: true }),
  ).toBeVisible();
  await panel.screenshot({
    path: testInfo.outputPath("sidepanel-empty-light.png"),
    scale: "css",
  });
  const workspace = await context.newPage();
  await workspace.goto(`chrome-extension://${extension.extensionId}/options.html`);
  await workspace.getByRole("button", { name: "设置", exact: true }).click();
  await workspace.getByLabel("主题").selectOption("dark");
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
    .toBe(0);
  await article.bringToFront();
  panel = await extension.openPanel(article);
  await expect(panel.locator("main")).toHaveAttribute("data-theme", "dark");
  await panel.screenshot({
    path: testInfo.outputPath("settings-dark.png"),
    scale: "css",
  });
  await expect(workspace.locator("main")).toHaveAttribute(
    "data-desktop-state",
    "unavailable",
  );
  await expect(workspace.getByText("Desktop 配对码")).toHaveCount(0);
  await panel.reload();
  await expect(panel.locator("main")).toHaveAttribute("data-theme", "dark");
  await panel.screenshot({
    path: testInfo.outputPath("sidepanel-empty-dark.png"),
    scale: "css",
  });
  const metrics = await panel.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    density: devicePixelRatio,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  expect(metrics.overflow).toBe(false);
  await testInfo.attach("viewport", {
    body: JSON.stringify(metrics),
    contentType: "application/json",
  });
  await expect(panel.getByText("浏览器独立运行", { exact: true })).toBeVisible();
});
test("manifest 仅默认 HTTP/HTTPS 顶层入口，无 WAR 私人页或默认 popup，Native 仅用于显式连接", async () => {
  const manifest = JSON.parse(await readFile(".output/chrome-mv3/manifest.json", "utf8"));
  expect(manifest.permissions.sort()).toEqual(
    [
      "activeTab",
      "scripting",
      "sidePanel",
      "storage",
      "nativeMessaging",
      "notifications",
      "alarms",
    ].sort(),
  );
  expect(manifest.host_permissions).toEqual(["http://*/*", "https://*/*"]);
  expect(manifest.optional_permissions || []).toEqual([]);
  expect(manifest.optional_host_permissions || []).toEqual([]);
  expect(manifest.content_scripts).toEqual([
    {
      matches: ["http://*/*", "https://*/*"],
      all_frames: false,
      run_at: "document_idle",
      js: ["content-scripts/page.js"],
    },
  ]);
  expect(manifest.web_accessible_resources).toBeUndefined();
  expect(manifest.action.default_popup).toBeUndefined();
  expect(manifest.side_panel.default_path).toBe("sidepanel.html");
});

test("DOM 组件层（源码注入）：跨内联词项、UTF-16、编辑区排除与几何不变", async ({
  page,
}) => {
  await page.route("https://reading.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><html><head><style>body{margin:40px;font:20px/1.8 Georgia}article{width:620px}button{font:inherit}</style></head><body><article><p id="line">📚 Read this <em>book</em>, then book a room. Ser<em>endipity</em> matters.</p><p id="spaced">🙂 <span>Resilient</span> <span>SYSTEM</span>, <span>network</span>\n<span>context</span>.</p><p contenteditable="true">editorsecret</p><div hidden>hiddensecret</div><pre>codesecret</pre><p><a href="/other">ordinary link</a> remains interactive.</p></article></body></html>',
    }),
  );
  await page.goto("https://reading.example.test/article");
  const ts = await import("typescript");
  const source = (
    await Promise.all(
      ["lib/pure.ts", "page/document.ts"].map((file) => readFile(file, "utf8")),
    )
  )
    .join("\n")
    .replace(/^import .*;\s*$/gm, "")
    .replace(/export /g, "");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  await page.addScriptTag({
    content: compiled + "\nwindow.testReadDocument=readDocument;",
  });
  const result = await page.evaluate(() => {
    const article = document.querySelector("article")!,
      line = document.querySelector("#line")!;
    const before = {
      html: article.innerHTML,
      rect: JSON.stringify(line.getBoundingClientRect().toJSON()),
      count: article.querySelectorAll("*").length,
    };
    const scan = (window as any).testReadDocument(document);
    (CSS as any).highlights.set(
      "leximeet-test",
      new (window as any).Highlight(...scan.occurrences.map((x: any) => x.range)),
    );
    const after = {
      html: article.innerHTML,
      rect: JSON.stringify(line.getBoundingClientRect().toJSON()),
      count: article.querySelectorAll("*").length,
    };
    const words = scan.occurrences.map((x: any) => ({
      surface: x.surface,
      start: x.start,
      text: x.range.toString(),
      sentence: x.sentence,
      sentenceStart: x.sentenceStart,
    }));
    (CSS as any).highlights.delete("leximeet-test");
    return { before, after, words };
  });
  expect(result.before).toEqual(result.after);
  expect(result.words.filter((x: any) => x.surface === "book")).toHaveLength(2);
  expect(result.words.find((x: any) => x.surface === "book")?.start).toBe(13);
  expect(result.words.find((x: any) => x.surface === "Serendipity")?.text).toBe(
    "Serendipity",
  );
  // 内联标签之间的空白是原句的一部分，不能丢掉后把两个词拼接；偏移按 UTF-16 保留。
  const spacedWords = result.words.filter(
    (x: any) => x.sentence.startsWith("🙂 ") || x.sentence === "context.",
  );
  expect(
    spacedWords.map((x: any) => [x.surface, x.text, x.start, x.sentenceStart]),
  ).toEqual([
    ["Resilient", "Resilient", 3, 0],
    ["SYSTEM", "SYSTEM", 13, 0],
    ["network", "network", 21, 0],
    ["context", "context", 0, 29],
  ]);
  expect(
    spacedWords
      .slice(0, 3)
      .every((x: any) => x.sentence === "🙂 Resilient SYSTEM, network\n"),
  ).toBe(true);
  for (const excluded of ["editorsecret", "hiddensecret", "codesecret"])
    expect(result.words.some((x: any) => x.surface === excluded)).toBe(false);
  await page.getByRole("link", { name: "ordinary link" }).click();
  await expect(page).toHaveURL("https://reading.example.test/other");
  await page.close();
});

test("浮球可拖拽吸边且不改网页正文几何；入口可键盘聚焦", async ({ extension }) => {
  const { context, worker } = extension;
  const article = await context.newPage();
  await article.route("https://reading.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Ball fixture</title><p id='line'>A book remains readable.</p><p><a href='https://example.org/ordinary'>ordinary link</a></p>",
    }),
  );
  await article.goto("https://reading.example.test/ball");
  const panel = await extension.openPanel(article);
  await worker.evaluate(async () => {
    const [tab] = await (globalThis as any).chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    await (globalThis as any).chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-scripts/page.js"],
    });
  });
  const host = article.locator("leximeet-page-ui");
  const ball = host.locator(".ball");
  const tip = host.locator(".ball-tip");
  await expect(host).toBeAttached();
  await expect(ball).toBeVisible();
  await expect
    .poll(() =>
      worker.evaluate(
        async () =>
          (
            await (globalThis as any).chrome.runtime.getContexts({
              contextTypes: ["SIDE_PANEL"],
            })
          ).length,
      ),
    )
    .toBe(1);
  await closeNativePanel(panel);
  await expect
    .poll(() =>
      worker.evaluate(
        async () =>
          (
            await (globalThis as any).chrome.runtime.getContexts({
              contextTypes: ["SIDE_PANEL"],
            })
          ).length,
      ),
    )
    .toBe(0);
  await expect(ball).toBeVisible();
  await expect(tip).toBeHidden();
  const before = await article.evaluate(() => ({
    html: document.getElementById("line")!.outerHTML,
    text: document.body.innerText,
  }));
  // 原生侧栏收起后阅读页宽度会异步变化；先等浮球几何稳定，再按当前位置拖拽。
  await expect
    .poll(async () => {
      const first = await ball.boundingBox();
      await article.waitForTimeout(100);
      const second = await ball.boundingBox();
      return (
        !!first &&
        !!second &&
        Math.abs(first.x - second.x) < 1 &&
        Math.abs(first.y - second.y) < 1
      );
    })
    .toBe(true);
  await ball.hover();
  await expect(tip).toHaveText("单击开关遇见 · 拖拽采词 · 右键打开侧栏");
  // 悬停入口只给提示，单击、拖拽与右键由球本身承担。
  await expect(tip.getByRole("button")).toHaveCount(0);
  await article.mouse.down();
  await article.mouse.move(36, 180, { steps: 12 });
  await article.mouse.up();
  const afterBox = await ball.boundingBox();
  expect(afterBox).toBeTruthy();
  expect(afterBox!.x).toBeLessThan(24);
  const after = await article.evaluate(() => ({
    html: document.getElementById("line")!.outerHTML,
    text: document.body.innerText,
  }));
  expect(after.html).toEqual(before.html);
  await ball.focus();
  await expect(ball).toBeFocused();
  // 用布局位置比较键盘移动，避免把半隐藏动画的中间帧当作目标坐标。
  const beforeLeft = await ball.evaluate((el) => (el as HTMLElement).offsetLeft);
  await article.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => (await ball.boundingBox())!.x)
    .toBeLessThanOrEqual(beforeLeft);
  await expect(tip).toBeVisible();
  await expect(article.getByRole("link", { name: "ordinary link" })).toBeVisible();
  await article.close();
});

test("SPA 软导航与往返缓存恢复后结束采集锁，常规链接和编辑区仍可用", async ({
  extension,
}) => {
  const { context, worker } = extension;
  const article = await context.newPage();
  await article.route("https://reading.example.test/**", (route) => {
    const other = route.request().url().endsWith("/other");
    return route.fulfill({
      contentType: "text/html",
      body: other
        ? "<!doctype html><title>Other</title><p>moved</p>"
        : `<!doctype html><title>SPA fixture</title>
<p id="line">A book remains readable.</p>
<p><a href="/other">ordinary link</a></p>
<textarea id="editor">keep typing</textarea>
<button id="go-spa" type="button">go spa</button>
<script>
  document.getElementById("go-spa").onclick = () => {
    history.pushState({}, "", "/spa-two");
  };
</script>`,
    });
  });
  await article.goto("https://reading.example.test/spa");
  const panel = await extension.openPanel(article);
  const tab = await worker.evaluate(async () => {
    const [current] = await (globalThis as any).chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    await (globalThis as any).chrome.scripting.executeScript({
      target: { tabId: current.id },
      files: ["content-scripts/page.js"],
    });
    return { id: current.id, windowId: current.windowId };
  });
  const call = (action: string, data: Record<string, unknown> = {}) =>
    panel.evaluate(
      async (payload) =>
        (globalThis as any).chrome.runtime.sendMessage({
          channel: "leximeet",
          ...payload,
        }),
      { action, data: { windowId: tab.windowId, ...data } },
    );
  await expect.poll(async () => !!(await call("state")).result?.page).toBe(true);
  await article.getByRole("button", { name: "go spa" }).click();
  await expect.poll(async () => (await call("state")).result.page?.phase).toBe("idle");
  await expect
    .poll(async () => String((await call("state")).result.page?.message || ""))
    .toMatch(/软导航|往返缓存|重新分析/);
  await article.locator("#editor").fill("still editable");
  await expect(article.locator("#editor")).toHaveValue("still editable");
  await article.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect.poll(async () => (await call("state")).result.page?.phase).toBe("idle");
  // 网页往返恢复后先核实原生侧栏仍在、球可见；实际关闭后仍保留球恢复断言。
  await expect(article.locator("leximeet-page-ui")).toBeAttached();
  await expect(article.locator("leximeet-page-ui .ball")).toBeVisible();
  await expect
    .poll(() =>
      worker.evaluate(
        async () =>
          (
            await (globalThis as any).chrome.runtime.getContexts({
              contextTypes: ["SIDE_PANEL"],
            })
          ).length,
      ),
    )
    .toBe(1);
  await closeNativePanel(panel);
  await expect
    .poll(() =>
      worker.evaluate(
        async () =>
          (
            await (globalThis as any).chrome.runtime.getContexts({
              contextTypes: ["SIDE_PANEL"],
            })
          ).length,
      ),
    )
    .toBe(0);
  await expect(article.locator("leximeet-page-ui").locator(".ball")).toBeVisible();
  await article.getByRole("link", { name: "ordinary link" }).click();
  await expect(article).toHaveURL("https://reading.example.test/other");
  await article.close();
});

test("隔离 HTTP 阅读页真实前进后退产生 BFCache persisted", async ({}, testInfo) => {
  const extension = await launchExtension({
    chromium,
    expect,
    testInfo,
    manageTrace: false,
    enableBackForwardCache: true,
  });
  const { context } = extension;
  const events: { path: string; persisted: boolean; id: string }[] = [];
  const server = await readingServer(
    (url) => {
      if (url.startsWith("/event?")) {
        const params = new URL(url, "http://127.0.0.1").searchParams;
        events.push({
          path: params.get("path") || "",
          persisted: params.get("persisted") === "true",
          id: params.get("id") || "",
        });
        return "ok";
      }
      return `<!doctype html><title>bfcache</title>
        <p>Cacheable body with a <a href="${url === "/cache-a" ? "/cache-b" : "/cache-a"}">next</a> link.</p>
        <textarea id="editor"></textarea>
        <script>
          window.__leximeetPageId = crypto.randomUUID();
          window.addEventListener("pageshow", (event) => {
            fetch("/event?path=" + encodeURIComponent(location.pathname)
              + "&persisted=" + event.persisted
              + "&id=" + window.__leximeetPageId).catch(() => {});
          });
        </script>`;
    },
    { cacheControl: "public, max-age=3600" },
  );
  const page = await context.newPage();
  try {
    await page.goto(`${server.url}/cache-a`);
    const initialId = await page.evaluate(() => (window as any).__leximeetPageId);
    const panel = await extension.openPanel(page);
    await extension.worker.evaluate(async (url) => {
      const tab = (await (globalThis as any).chrome.tabs.query({})).find(
        (item: any) => item.url === url,
      );
      if (!tab?.id) throw new Error("找不到本例阅读标签");
      await (globalThis as any).chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-scripts/page.js"],
      });
    }, page.url());
    await expect(page.locator("leximeet-page-ui")).toBeAttached();
    await expect(page.locator("leximeet-page-ui .ball")).toBeVisible();
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
    await page.locator("#editor").fill("往返前的输入");
    await page.getByRole("link", { name: "next" }).click();
    await expect(page).toHaveURL(`${server.url}/cache-b`);
    // Playwright 的 goBack 会等待一次网络主请求；BFCache 恢复没有该请求。
    // 从页面发起真实 history.back，并让恢复页把 pageshow 事实报给本例回环服务。
    await page.evaluate(() => {
      history.back();
      return true;
    });
    await expect
      .poll(() => events.some((event) => event.path === "/cache-a" && event.persisted), {
        timeout: 10000,
      })
      .toBe(true);
    const restored = events.find((event) => event.path === "/cache-a" && event.persisted);
    const report = {
      persistedObserved: !!restored,
      sameDocument: restored?.id === initialId,
      events,
    };
    await testInfo.attach("bfcache-real.json", {
      body: Buffer.from(
        JSON.stringify({ ...report, chromium: context.browser()?.version() }, null, 2),
      ),
      contentType: "application/json",
    });
    expect(report.persistedObserved).toBe(true);
    expect(report.sameDocument).toBe(true);
    await expect(page.locator("#editor")).toHaveValue("往返前的输入");
    await expect(page.locator("leximeet-page-ui .ball")).toBeVisible();
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
    await closeNativePanel(panel);
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
      .toBe(0);
    await expect(page.locator("leximeet-page-ui").locator(".ball")).toBeVisible();
  } finally {
    await page.close();
    await server.close();
    await extension.close();
  }
});
