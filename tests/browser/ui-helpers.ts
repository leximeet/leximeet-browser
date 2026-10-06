import { expect, type Page, type BrowserContext, type Worker } from "@playwright/test";
export async function workspace(extension: any) {
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.extensionId}/options.html`);
  await page.bringToFront();
  await expect(page.getByRole("navigation", { name: "工作区导航" })).toBeVisible();
  return page;
}
export async function navigate(page: Page, name: string) {
  const button =
    name === "设置" || name === "回收站"
      ? page.getByRole("button", { name, exact: true })
      : page
          .getByRole("navigation", { name: "工作区导航" })
          .getByRole("button", { name: new RegExp("^" + name) });
  await button.click();
}
export async function addWord(page: Page, word: string) {
  await navigate(page, "我的词库");
  await page.getByRole("button", { name: "添加单词", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "查词与添加" });
  await dialog.getByRole("textbox", { name: "输入英文单词" }).fill(word);
  await expect(dialog.getByRole("heading", { name: word, exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "加入我的词库", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
export async function setTarget(page: Page, count = 12) {
  await navigate(page, "学习规划");
  // 新管理页先加载资料；即时 count=0 不代表已有目标。等待任一真实入口，
  // 避免把加载中的空 DOM 误判成“更换目标”，又不替测试创建计划或延长超时。
  await page.getByRole("button", { name: /^(设置学习规划|更换学习目标)$/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "四级词汇", exact: false }).first().click();
  await dialog.getByRole("button", { name: "下一步：每天学多少", exact: false }).click();
  await dialog.getByRole("spinbutton", { name: "每天学习新词数" }).fill(String(count));
  await dialog.getByRole("spinbutton", { name: "每天复习词数" }).fill("30");
  await dialog.getByRole("button", { name: "保存学习规划", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
// 只读正式 IndexedDB；写操作仍由产品 UI 执行。
export async function facts(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("leximeet-personal-v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const names = ["meta", "words", "encounters", "reviews", "practice", "notebooks"];
    const tx = db.transaction(names);
    const get = (name: string, key?: string) =>
      new Promise<any>((resolve, reject) => {
        const r = key ? tx.objectStore(name).get(key) : tx.objectStore(name).getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    const [
      book,
      settings,
      workspace,
      checkpoints,
      plan,
      words,
      encounters,
      reviews,
      practice,
      notebooks,
    ] = await Promise.all([
      get("meta", "book"),
      get("meta", "settings"),
      get("meta", "workspace"),
      get("meta", "checkpoints"),
      get("meta", "studyPlan"),
      ...names.slice(1).map((n) => get(n)),
    ]);
    db.close();
    return {
      book,
      settings,
      workspace,
      checkpoints,
      plan,
      words,
      encounters,
      reviews,
      practice,
      notebooks,
    };
  });
}
export async function editWord(page: Page, word: string) {
  await navigate(page, "我的词库");
  await page.locator(".v3-table-body button").filter({ hasText: word }).first().click();
  await page.getByRole("button", { name: "编辑个人内容" }).click();
}
export async function practiceSettings(page: Page, repeat = 1, autoNext = false) {
  await page.getByRole("button", { name: "拼写设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "拼写设置" });
  await dialog.getByRole("spinbutton").fill(String(repeat));
  await dialog
    .getByRole("checkbox", { name: "自动下一个", exact: true })
    .setChecked(autoNext);
  await dialog.getByRole("button", { name: "保存拼写设置" }).click();
  await expect(dialog).toHaveCount(0);
}

// 调用方先核对 SIDE_PANEL；等待 Chromium 的原生 target 真正附着后再操作页面。
export async function nativePanel(context: BrowserContext): Promise<Page> {
  await expect
    .poll(() => context.pages().some((p) => p.url().endsWith("/sidepanel.html")))
    .toBe(true);
  const panel = context.pages().find((p) => p.url().endsWith("/sidepanel.html"))!;
  await expect(panel.locator(".lm-panel")).toBeVisible();
  return panel;
}

// 只读实际正文以定位点击坐标；不依赖产品高亮、词典查询或候选列表。
export async function wordPoint(page: Page, word: string, occurrence = 0) {
  return page.evaluate(
    ({ word, occurrence }) => {
      let found = 0;
      const blocks = document.querySelectorAll("p,li,h1,h2,h3,h4,blockquote,td,th");
      for (const block of blocks) {
        if (block.closest("code,pre,[contenteditable],[hidden]")) continue;
        const nodes: Text[] = [],
          walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let text = "";
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          nodes.push(node);
          text += node.data;
        }
        const pattern = new RegExp("\\b" + word + "\\b", "gi");
        for (const match of text.matchAll(pattern)) {
          if (found++ !== occurrence) continue;
          const range = document.createRange();
          let offset = 0;
          for (const node of nodes) {
            if (offset <= match.index! && offset + node.length > match.index!)
              range.setStart(node, match.index! - offset);
            if (
              offset < match.index! + match[0].length &&
              offset + node.length >= match.index! + match[0].length
            ) {
              range.setEnd(node, match.index! + match[0].length - offset);
              break;
            }
            offset += node.length;
          }
          const first = range.getBoundingClientRect();
          if (first.top < 20 || first.bottom > innerHeight - 20)
            window.scrollBy({
              top: first.top - innerHeight / 3,
              behavior: "instant",
            });
          const rect = range.getClientRects()[0];
          if (!rect?.width) throw new Error("实际正文词项不可见");
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      throw new Error("实际正文没有指定单词");
    },
    { word, occurrence },
  );
}
export async function pickWord(page: Page, word: string, occurrence = 0) {
  const point = await wordPoint(page, word, occurrence);
  await page.mouse.click(point.x, point.y);
}

// 仅测试驱动触发正式 toolbar action；启动器本身不替用户点击或提前打开侧栏。
export async function toolbarAction(
  context: BrowserContext,
  extensionId: string,
  page: Page,
) {
  await page.bringToFront();
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send("Target.getTargets", {
      filter: [{ type: "tab", exclude: false }],
    });
    const targets = targetInfos.filter(
      (item: { url: string }) => item.url === page.url(),
    );
    expect(targets).toHaveLength(1);
    await cdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: targets[0]!.targetId,
    });
  } finally {
    await cdp.detach();
  }
  return nativePanel(context);
}

// 标题不占侧栏 UI；只读正式状态继续验证跨 tab 的绑定，绝不写入或模拟状态。
export async function panelTitle(panel: Page): Promise<string> {
  return panel.evaluate(async () => {
    const chrome = (globalThis as any).chrome;
    const windowId = (await chrome.windows.getCurrent()).id;
    const result = await chrome.runtime.sendMessage({
      channel: "leximeet",
      action: "state",
      data: { windowId },
    });
    if (!result.ok) throw new Error(result.error);
    return result.result.currentPage.title;
  });
}
// 调用真正的 Chrome close API，模拟原生 X 的关闭结果；不新增产品内部关闭入口。
export async function closeNativePanel(panel: Page) {
  const windowId = await panel.evaluate(
    async () => (await (globalThis as any).chrome.windows.getCurrent()).id,
  );
  const worker = panel
    .context()
    .serviceWorkers()
    .find((w) => w.url().endsWith("/background.js"));
  if (!worker) throw new Error("真实扩展 worker 尚未就绪");
  await worker.evaluate(
    (id) => (globalThis as any).chrome.sidePanel.close({ windowId: id }),
    windowId,
  );
  // Chrome API 回执先于文档结束；等待真正关闭，不能把已关闭侧栏留给最终截图的竞态窗口。
  await expect.poll(() => panel.isClosed()).toBe(true);
}
// 离线业务用例通过实际设置关闭联网朗读；默认发音另有独立播放用例覆盖。
export async function mutePractice(page: Page) {
  await navigate(page, "设置");
  await page.getByRole("checkbox", { name: "拼写完成后发音", exact: true }).uncheck();
  await expect(
    page.getByRole("checkbox", { name: "拼写完成后发音", exact: true }),
  ).not.toBeChecked();
  await expect
    .poll(async () => (await facts(page)).workspace.practice.autoPronounce)
    .toBe(false);
}

// 只读 Chrome 实际选中标签，确认右键没有跳转到管理页。
export async function activeTabUrl(worker: Worker): Promise<string | undefined> {
  return worker.evaluate(async () => {
    const [tab] = await (globalThis as any).chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return tab?.url;
  });
}

// 只用真实列表自评触发学习：新一轮是新尝试，同轮重试不会重复计分。
export async function familiarCurrent(page: Page, expectedScore: number) {
  await navigate(page, "练习中心");
  await page.getByRole("button", { name: "单词列表", exact: true }).click();
  await page
    .locator(".v3-practice-list-row.selected")
    .getByRole("button", { name: "熟悉 +1", exact: true })
    .click();
  await expect(page.locator(".v3-learning-score")).toContainText(
    `${expectedScore} / 30 分`,
  );
}
export async function graduateCurrent(page: Page) {
  for (let score = 11; score <= 20; score++) {
    await familiarCurrent(page, score);
    if (score < 20)
      await page.getByRole("button", { name: "重新开始", exact: true }).click();
  }
}

// 只读正式题目，不注入答案/成绩；答题仍点击产品 UI。
export async function frozenChoice(page: Page) {
  const attemptId = await page
    .locator(".v3-practice-stage")
    .getAttribute("data-attempt-id");
  if (!attemptId) throw new Error("当前画面尚未绑定冻结题目");
  return page.evaluate(async (attemptId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("leximeet-personal-v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const values = await new Promise<any[]>((resolve, reject) => {
      const r = db.transaction("meta").objectStore("meta").getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return values.find((q) => q?.attemptId === attemptId && q.mode === "meaning-choice");
  }, attemptId);
}
