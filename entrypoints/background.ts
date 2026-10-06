import { prepareSafeCapture, type CapturePolicy } from "../lib/capture-policy.ts";
import { browser } from "wxt/browser";
import { DesktopConnection, IndexedConnectionStore } from "../lib/desktop-connection.ts";
import { DesktopDiscovery, IndexedDiscoveryStore } from "../lib/desktop-discovery.ts";
import { DesktopReading } from "../lib/desktop-reading.ts";
import { desktopProjectionExpired } from "../lib/desktop-projection.ts";
import { pickedWord } from "../lib/capture-pick.ts";
import { validCaptureSwitch, type PendingCaptureSwitch } from "../lib/page-session.ts";
import { trustedSender, contentSender } from "../lib/security.ts";
import {
  documentSession,
  restoredPageDrafts,
  assertDraftOwner,
  type DocumentIdentity,
  sameDocument,
  helloProjection,
} from "../lib/page-session.ts";
import { learningEvents } from "../lib/learning-repository.ts";
import { projectLearning, type LearningEvent } from "../lib/learning.ts";
import { localLibrary as browserLibrary } from "../lib/local-database.ts";
import { CoreLexiconProvider, publicDictionary } from "../lib/lexicon.ts";
import {
  defaultWorkspacePreferences,
  type WorkspacePreferences,
} from "../lib/workspace-model.ts";
import { createApplicationServices } from "../lib/application-services.ts";
import {
  ballStorageKey,
  parseBallPosition,
  snapBallPosition,
} from "../lib/page-overlay.ts";
import { locationChanged } from "../lib/page-navigation.ts";
import {
  encodedSize,
  encounterWord,
  normalize,
  publicWord,
  rangesFor,
  sanitizeUrl,
} from "../lib/pure.ts";
import type { Draft, PageState } from "../lib/types.ts";
import { replyAsync } from "../lib/runtime-reply.ts";
import { sitePattern, type CurrentPage } from "../lib/site-access.ts";
import {
  FLOATING_STORAGE_KEY,
  floatingPlacement,
  floatingProjection,
  parseFloatingPreferences,
  type FloatingPreferences,
} from "../lib/floating-preferences.ts";

import {
  GUIDE_STORAGE_KEY,
  OnboardingGuide,
  guideStep,
} from "../lib/onboarding-guide.ts";
import {
  TUTORIAL_PATH,
  TUTORIAL_SOURCE,
  isTutorialPage,
  readingSourceUrl,
} from "../lib/tutorial-page.ts";
type PanelPort = ReturnType<typeof browser.runtime.connect>;

export default defineBackground(() => {
  const services = createApplicationServices({
    library: browserLibrary,
    lexicon: new CoreLexiconProvider(
      browser.runtime
        .getURL("/dictionaries/core/dictionary-manifest.json")
        .replace(/dictionary-manifest\.json$/, ""),
    ),
  });
  const { library: localLibrary, lexicon } = services;
  const connection = new DesktopConnection({
    store: new IndexedConnectionStore(),
    library: browserLibrary,
    changed: () => {
      void browser.runtime
        .sendMessage({ channel: "leximeet-connection-changed" })
        .catch(() => {});
      void broadcast().catch(() => {});
    },
  });
  const desktopReading = new DesktopReading(connection);
  // Worker 重启仅恢复原配对；短时失联不改资料归属。
  void connection.ready().catch(() => {});
  let lastConnectionPoll = 0;
  let ownerSwitching = false;
  // 控制视图先报告真实归属，再明确通知业务挂载已就绪，避免在切换闸门内初始化个人页。
  async function finishOwnerSwitch() {
    ownerSwitching = false;
    await browser.runtime
      .sendMessage({ channel: "leximeet-connection-changed" })
      .catch(() => {});
    await broadcast();
  }
  const desktopProjections = new Map<
    number,
    { ticket: string; revision: string; until: number }
  >();
  function assertOwnerAvailable(ticket = connection.ticket()) {
    if (ownerSwitching) throw new Error("正在切换资料，请稍候重试");
    connection.assertTicket(ticket);
  }
  function requireWebCapture(page: PageState) {
    if (connection.connectedMode && !/^https?:\/\//.test(page.url))
      throw new Error("连接桌面后请在普通英文网页采集；内置教学用于独立使用。");
  }
  async function refreshConnection() {
    if (
      !ownerSwitching &&
      connection.connectedMode &&
      Date.now() - lastConnectionPoll > 10_000
    ) {
      lastConnectionPoll = Date.now();
      await connection.heartbeat().catch(() => {});
    }
    const context = connection.readContext();
    for (const [tabId, snapshot] of desktopProjections) {
      if (desktopProjectionExpired(snapshot, connection.ticket(), context)) {
        desktopProjections.delete(tabId);
        const page = pages.get(tabId);
        if (!page) continue;
        // 只撤销过期投影；不重新读取网页，也不丢弃尚未加入的采集草稿。
        allowedCandidates.delete(tabId);
        nextOperation(tabId);
        page.occurrences = [];
        page.selectedId = null;
        if (page.phase !== "capture") page.phase = "idle";
        page.message = "桌面资料已变化或读取已过期，请重新分析";
        await pageCall(tabId, "end", { clearEncounter: true }).catch(() => {});
      }
    }
  }
  async function capturePolicy(ticket = connection.ticket()): Promise<CapturePolicy> {
    assertOwnerAvailable(ticket);
    const policy = connection.connectedMode
      ? await desktopReading.capturePolicy()
      : await localLibrary.capturePolicy();
    assertOwnerAvailable(ticket);
    return policy;
  }
  async function pickFingerprint(pick: unknown): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(pick)),
    );
    return Array.from(new Uint8Array(digest), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
  }
  async function readingDictionary(word: string, ticket = connection.ticket()) {
    await connection.ready();
    assertOwnerAvailable(ticket);
    const result = connection.connectedMode
      ? await desktopReading.dictionary(word)
      : publicDictionary(await lexicon.lookup(word));
    assertOwnerAvailable(ticket);
    return result;
  }
  // 先停网页动作和私人投影，保留草稿；断开落盘失败时仍可在原 B 重试。
  async function pauseReadingOwner() {
    for (const page of pages.values()) {
      nextOperation(page.tabId);
      await pageCall(page.tabId, "end", {
        clearEncounter: true,
        ownershipChanged: true,
      }).catch(() => {});
      page.phase = "idle";
      page.occurrences = [];
      page.selectedId = null;
    }
    allowedCandidates.clear();
    desktopProjections.clear();
    targetIndex = undefined;
    canonicalWords.clear();
  }
  async function switchReadingOwner(toDesktop: boolean, restore = !toDesktop) {
    await draftsReady;
    if (toDesktop) {
      await browser.storage.session.set({
        independentDraftsArchived: {
          drafts: Object.fromEntries(retainedDrafts),
          documents: Object.fromEntries(
            [...pages].map(([id, page]) => [
              id,
              {
                tabId: page.tabId,
                documentId: page.documentId,
                generation: page.generation,
              },
            ]),
          ),
        },
      });
    }
    await pauseReadingOwner();
    for (const page of pages.values()) page.drafts = [];
    retainedDrafts.clear();
    captureSwitches.clear();
    if (restore) {
      const archived = (await browser.storage.session.get("independentDraftsArchived"))
        .independentDraftsArchived as
        | {
            drafts?: Record<string, unknown>;
            documents?: Record<string, DocumentIdentity>;
          }
        | undefined;
      if (archived?.drafts && typeof archived.drafts === "object") {
        const ticket = connection.ticket();
        for (const [key, value] of Object.entries(archived.drafts))
          if (Array.isArray(value)) {
            const drafts = structuredClone(value as Draft[]).filter(
              (draft) => draft.ownerTicket === ticket,
            );
            retainedDrafts.set(Number(key), drafts);
            const page = pages.get(Number(key));
            if (page) {
              page.drafts = restoredPageDrafts(
                page,
                archived.documents?.[key] as DocumentIdentity | undefined,
                drafts,
                ticket,
              );
              if (page.drafts.length)
                page.message = "原独立采集草稿已恢复，仍待加入单词本";
            }
          }
      }
    }
    // 先可靠落盘，再移除封存副本；失败时原封存副本仍在。
    await persistDrafts();
    if (restore) await browser.storage.session.remove("independentDraftsArchived");
    if (!ownerSwitching) await broadcast();
  }

  const guide = new OnboardingGuide({
    load: async () =>
      (await browser.storage.local.get(GUIDE_STORAGE_KEY))[GUIDE_STORAGE_KEY],
    save: async (state) => {
      await browser.storage.local.set({ [GUIDE_STORAGE_KEY]: state });
      // 教学状态变化立即刷新批注，避免等待后台标签定时器；只发失效通知，不传个人数据。
      for (const page of pages.values())
        if (page.url === TUTORIAL_SOURCE)
          void pageCall(page.tabId, "guide-changed").catch(() => {});
    },
    pinned: async () => (await browser.action.getUserSettings()).isOnToolbar,
    planReady: async () => {
      const plan = await localLibrary.plan();
      return !!plan && plan.sourceVersion === "0.0.3" && !plan.paused;
    },
    finish: async () => {
      const prefs =
        (await localLibrary.workspaceMeta<WorkspacePreferences>("workspace")) ||
        defaultWorkspacePreferences();
      await localLibrary.saveWorkspaceMeta("workspace", {
        ...prefs,
        onboarding: { stage: 4, complete: true },
      });
    },
  });
  // 真实固定状态由 Chrome 提供；没有设置图钉状态或模拟用户同意的 API。
  browser.action.onUserSettingsChanged?.addListener(() => {
    void guide.status().catch(() => {});
  });
  const pages = new Map<number, PageState>();
  const panels = new Map<PanelPort, { windowId: number; visible: boolean }>();
  const visibility = new Map<number, boolean>();
  const operations = new Map<number, number>();
  const captureSwitches = new Map<number, PendingCaptureSwitch>();
  const workerEpoch = crypto.randomUUID();
  const allowedCandidates = new Map<
    number,
    Map<
      string,
      {
        normalized: string;
        wordId?: string;
        status?: string;
        origin?: "target" | "manual" | "both" | "other";
      }
    >
  >();
  const retainedDrafts = new Map<number, Draft[]>();
  const pageWindows = new Map<number, number>();
  let projectionRevision = 0;
  let lastTheme: string | undefined;
  let floatingWrites: Promise<unknown> = Promise.resolve();
  let siteRegistration: Promise<unknown> = Promise.resolve();

  // 每次设置变化使公共范围索引失效；网页只得到自己候选词的公开匹配结果。
  let targetIndex: Promise<Set<string>> | undefined;
  // 遇见只需要词形对应的主词，不必在每次开关时重新解压整张词卡。
  // 仅在本次 Worker 内缓存有限词键；换目标/词典后失效，不存网页原句或个人资料。
  const canonicalWords = new Map<string, string>();
  let canonicalGeneration = 0;
  async function canonicalWord(word: string) {
    const cached = canonicalWords.get(word);
    if (cached !== undefined) {
      canonicalWords.delete(word);
      canonicalWords.set(word, cached);
      return cached;
    }
    const generation = canonicalGeneration;
    // 冷扫描只查词头/词形索引；完整词卡在用户查看时才按需加载。
    const headword = await lexicon.resolveHeadword(word);
    const canonical = normalize(headword || word);
    if (generation === canonicalGeneration) {
      canonicalWords.set(word, canonical);
      if (canonicalWords.size > 512)
        canonicalWords.delete(canonicalWords.keys().next().value!);
    }
    return canonical;
  }

  function learningTarget() {
    return (targetIndex ??= (async () => {
      const plan = await localLibrary.plan();
      if (!plan || plan.sourceVersion !== "0.0.3" || plan.paused)
        return new Set<string>();
      const members =
        plan.sourceKind === "dictionary"
          ? await lexicon.allMembers!()
          : await lexicon.catalogMembers(plan.sourceId);
      return new Set(members.map((m) => normalize(m.word)));
    })().catch((e) => {
      targetIndex = undefined;
      throw e;
    }));
  }
  async function floatingConfig(): Promise<FloatingPreferences> {
    const saved = await browser.storage.local.get(FLOATING_STORAGE_KEY);
    return parseFloatingPreferences(saved[FLOATING_STORAGE_KEY]);
  }
  async function updateFloating(
    patch:
      | Partial<FloatingPreferences>
      | ((value: FloatingPreferences) => Partial<FloatingPreferences>),
  ) {
    // 两个标签页同时拖拽/隐藏时顺序合并，避免覆盖其他站点的隐藏选择。
    const next = floatingWrites
      .catch(() => {})
      .then(async () => {
        const current = await floatingConfig();
        const value = parseFloatingPreferences({
          ...current,
          ...(typeof patch === "function" ? patch(current) : patch),
        });
        await browser.storage.local.set({ [FLOATING_STORAGE_KEY]: value });
        await Promise.all(
          [...pages.values()].map((page) =>
            pageCall(
              page.tabId,
              "floating-preferences",
              floatingProjection(value, new URL(page.url).origin),
            ).catch(() => {}),
          ),
        );
        return value;
      });
    floatingWrites = next;
    return next;
  }
  // 静态脚本覆盖新网页；安装/权限变更时补上已有网页，并清理旧版的动态注册。
  function syncAuthorizedSites(inject = false) {
    const next = siteRegistration
      .catch(() => {})
      .then(async () => {
        const id = "leximeet-authorized-sites";
        if ((await browser.scripting.getRegisteredContentScripts({ ids: [id] })).length)
          await browser.scripting.unregisterContentScripts({ ids: [id] });
        if (inject)
          for (const tab of await browser.tabs.query({})) {
            const pattern = sitePattern(tab.url);
            if (
              tab.id &&
              pattern &&
              (await browser.permissions.contains({ origins: [pattern] }))
            )
              void ensurePage(tab.id).catch(() => {});
          }
      });
    siteRegistration = next;
    return next;
  }

  // 会话草稿与正式个人事实分离；worker 回收后只恢复草稿，不复活旧网页位置或采集锁。
  const draftsReady = browser.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .then(async () => {
      const stored = await browser.storage.session.get([
        "standaloneDrafts",
        "standaloneCaptureSwitches",
      ]);
      const rows = stored.standaloneDrafts;
      if (rows && typeof rows === "object")
        for (const [key, value] of Object.entries(rows))
          if (Array.isArray(value)) retainedDrafts.set(Number(key), value as Draft[]);
      const pending = stored.standaloneCaptureSwitches;
      if (pending && typeof pending === "object")
        for (const [key, value] of Object.entries(pending))
          if (
            Number.isInteger(Number(key)) &&
            Number(key) >= 0 &&
            validCaptureSwitch(value)
          )
            captureSwitches.set(Number(key), value);
    });
  async function persistDrafts() {
    await draftsReady;
    await browser.storage.session.set({
      standaloneDrafts: Object.fromEntries(retainedDrafts),
      standaloneCaptureSwitches: Object.fromEntries(captureSwitches),
    });
  }
  function retain(page: PageState) {
    retainedDrafts.set(page.tabId, structuredClone(page.drafts));
    void persistDrafts().catch(() => {});
  }
  function nextOperation(tabId: number): number {
    const next = (operations.get(tabId) || 0) + 1;
    operations.set(tabId, next);
    return next;
  }
  function assertCurrent(page: PageState, operation: number) {
    if (pages.get(page.tabId) !== page || (operations.get(page.tabId) || 0) !== operation)
      throw new Error("页面已变化，本次操作已取消");
  }
  async function pageCall(
    tabId: number,
    action: string,
    data: unknown = {},
    bind = true,
  ) {
    const reply = (await isTutorialTab(tabId))
      ? await browser.runtime.sendMessage({
          channel: "leximeet-page",
          action,
          data,
          targetTabId: tabId,
        })
      : await browser.tabs.sendMessage(
          tabId,
          { channel: "leximeet-page", action, data },
          {
            frameId: 0,
            ...(bind && pages.get(tabId)?.documentId
              ? { documentId: pages.get(tabId)!.documentId }
              : {}),
          },
        );
    if (!reply?.ok) throw new Error(reply?.error || "网页连接不可用，请重新分析");
    return reply.result;
  }
  // 无 tabs 权限时 tab.url 可能省略；只用 Chrome 的真实扩展上下文核实教学标签。
  async function isTutorialTab(tabId: number) {
    return (
      (
        await browser.runtime.getContexts({
          contextTypes: ["TAB"],
          tabIds: [tabId],
          documentUrls: [browser.runtime.getURL(TUTORIAL_PATH)],
        })
      ).length > 0
    );
  }
  async function currentTab(windowId: number) {
    const [tab] = await browser.tabs.query({ active: true, windowId });
    return tab;
  }
  function syncTheme(theme: string) {
    if (lastTheme === theme) return;
    lastTheme = theme;
    for (const id of pages.keys()) void pageCall(id, "theme", { theme }).catch(() => {});
  }
  async function state(windowId: number) {
    await draftsReady;
    await connection.ready();
    assertOwnerAvailable();
    await refreshConnection();
    const ticket = connection.ticket();
    const desktopMode = connection.connectedMode;
    const connectionState = await connection.view();
    const revision = ++projectionRevision;
    const [book, settings, words] = await Promise.all([
      desktopMode ? Promise.resolve(null) : localLibrary.book(),
      localLibrary.settings(), // 只读设备主题，连接期间禁止修改原偏好。
      desktopMode ? Promise.resolve([]) : localLibrary.listWords(),
    ]);
    const tab = Number.isInteger(windowId) ? await currentTab(windowId) : null;
    const page = tab?.id && tab.status !== "loading" ? pages.get(tab.id) : undefined;
    const url = readingSourceUrl(tab?.url || page?.url || "", browser.runtime.id);
    const pattern = sitePattern(url);
    const currentPage: CurrentPage = {
      tabId: tab?.id ?? null,
      title: tab?.title || page?.title || "当前标签页",
      url,
      sitePattern: pattern,
      siteEnabled:
        !!pattern && (await browser.permissions.contains({ origins: [pattern] })),
      access:
        tab?.status === "loading"
          ? "loading"
          : page
            ? "ready"
            : tab?.url && !pattern
              ? "restricted"
              : "permission-needed",
    };
    // 主题跟随共享设置；只把外观值发到网页，不把个人词库投影发到内容脚本。
    syncTheme(settings.theme);
    const pending = captureSwitches.get(windowId);
    if (pending)
      pending.unsavedCount =
        pages.get(pending.tabId)?.drafts.length ??
        retainedDrafts.get(pending.tabId)?.length ??
        pending.unsavedCount;
    const wordCount = desktopMode
      ? 0
      : new Set([
          ...(await learningTarget()),
          ...words.filter((w) => w.collected !== false).map((w) => w.normalized),
        ]).size;
    const tutorialPage = !!tab?.id && (await isTutorialTab(tab.id));
    const integration = await services.integrationStatus();
    assertOwnerAvailable(ticket);
    return {
      revision,
      workerEpoch,
      book,
      settings,
      connection: connectionState,
      wordCount,
      currentPage,
      tutorialPage,
      integration,
      captureSwitch: captureSwitches.get(windowId) || null,
      page: page || null,
      storage: desktopMode ? ("desktop" as const) : ("local" as const),
    };
  }
  async function broadcast() {
    for (const [port, info] of panels) {
      try {
        port.postMessage({ type: "state", state: await state(info.windowId) });
      } catch {
        // 模式切换中的投影可重试；不能因此永久移除仍然连接的真实侧栏。
      }
    }
  }
  async function end(
    tabId: number,
    reason = "采集已结束，草稿保留",
    clearEncounter = false,
  ) {
    const page = pages.get(tabId);
    if (!page) return;
    nextOperation(tabId);
    page.phase = "idle";
    page.message = reason;
    page.session = undefined;
    if (clearEncounter) {
      page.occurrences = [];
      page.selectedId = null;
    }
    try {
      await pageCall(tabId, "end", { reason, clearEncounter });
    } catch {
      // 页面可能已导航
    }
    await broadcast();
  }
  async function panelVisibility(windowId: number, visible: boolean) {
    const wasVisible = visibility.get(windowId);
    visibility.set(windowId, visible);
    // 同一次原生关闭可能同时收到 onClosed 和侧栏断连；只推进一次教学。
    if (!visible && wasVisible !== false)
      await guide.record("closed", { windowId }).catch(() => {});
    for (const info of panels.values())
      if (info.windowId === windowId) info.visible = visible;
    const tabs = await browser.tabs.query({ windowId });
    for (const tab of tabs) {
      if (!tab.id || !pages.has(tab.id)) continue;
      if (!visible && ["capture", "analyzing"].includes(pages.get(tab.id)!.phase))
        await end(tab.id, "侧栏已收起，网页已恢复，草稿保留");
      void pageCall(tab.id, "visibility", { visible }).catch(() => {});
    }
  }

  const workspaceUrl = browser.runtime.getURL("/options.html");
  const managementTabs = new Set<number>();
  const managementClosures = new Map<number, Promise<void>>();
  // 窗口级侧栏不会可靠地随 enabled:false 收回；进入前台管理页时实际关闭。
  async function closeReadingPanelForWorkspace(tabId: number) {
    const tab = await browser.tabs.get(tabId);
    if (
      !tab.active ||
      (await currentTab(tab.windowId))?.id !== tabId ||
      captureSwitches.has(tab.windowId)
    )
      return;
    if (
      !visibility.get(tab.windowId) &&
      ![...panels.values()].some((p) => p.windowId === tab.windowId)
    )
      return;
    const running = managementClosures.get(tab.windowId);
    if (running) return running;
    const closing = browser.sidePanel.close({ windowId: tab.windowId });
    managementClosures.set(tab.windowId, closing);
    try {
      await closing;
    } finally {
      if (managementClosures.get(tab.windowId) === closing)
        managementClosures.delete(tab.windowId);
    }
  }
  function isWorkspaceTab(tab: { url?: string }) {
    return tab.url?.split(/[?#]/, 1)[0] === workspaceUrl;
  }
  // 只在管理标签隐藏侧栏；不给阅读标签设置 path，保留窗口级共享实例。
  async function configureWorkspaceTab(tab: { id?: number; url?: string }) {
    if (tab.id === undefined) return;
    // 没有 tabs 权限时，旧管理标签的 URL 在 Worker 重启后不可见。
    // 只从 Chrome 的真实扩展上下文恢复身份，不能根据网页发来的名称猜测。
    let url = tab.url;
    if (!url) {
      const contexts = await browser.runtime.getContexts({
        contextTypes: ["TAB"],
        tabIds: [tab.id],
      });
      url = contexts.find((context) =>
        isWorkspaceTab({ url: context.documentUrl }),
      )?.documentUrl;
    }
    if (isWorkspaceTab({ url })) {
      const actual = await browser.tabs.get(tab.id);
      if (captureSwitches.has(actual.windowId)) return;
      managementTabs.add(tab.id);
      await browser.sidePanel.setOptions({ tabId: tab.id, enabled: false });
    } else if (managementTabs.delete(tab.id)) {
      // 用户在同一个管理标签导航到网页时，恢复继承窗口级侧栏。
      await browser.sidePanel.setOptions({ tabId: tab.id, enabled: true });
    }
  }
  browser.tabs.onCreated.addListener((tab) => {
    void configureWorkspaceTab(tab).catch(() => {});
  });
  // Worker 重启后重新识别已有管理标签，不读取或修改浏览器 profile。
  void browser.tabs.query({}).then((tabs) => {
    for (const tab of tabs) void configureWorkspaceTab(tab).catch(() => {});
  });

  browser.sidePanel.onOpened?.addListener(
    (info) => void panelVisibility(info.windowId, true),
  );
  browser.sidePanel.onClosed?.addListener((info) => {
    void panelVisibility(info.windowId, false);
  });
  browser.action.onClicked.addListener((tab) => {
    if (isWorkspaceTab(tab) || (tab.id !== undefined && managementTabs.has(tab.id))) {
      void configureWorkspaceTab(tab)
        .then(() =>
          tab.id === undefined ? undefined : closeReadingPanelForWorkspace(tab.id),
        )
        .catch(() => {});
      return;
    }
    void configureWorkspaceTab(tab).catch(() => {});
    // 保持 default_path 为窗口级面板；绝不能为每个 tab 设置同名 path，否则会产生独立实例。
    if (tab.windowId !== undefined)
      void browser.sidePanel
        .open({ windowId: tab.windowId })
        .then(async () => {
          if (tab.id && (await isTutorialTab(tab.id))) {
            await guide.status();
            await guide.record("toolbar", {
              windowId: tab.windowId!,
              tabId: tab.id,
            });
          }
        })
        .catch(() => {});
    if (tab.id && (sitePattern(tab.url) || isTutorialPage(tab.url, browser.runtime.id)))
      void ensurePage(tab.id).catch(() => {});
  });
  // 重用教学标签，重新开始只重置教学进度，不改词库、计划或已保存语境。
  async function openTutorial() {
    const url = browser.runtime.getURL(TUTORIAL_PATH);
    const contexts = await browser.runtime.getContexts({
      contextTypes: ["TAB"],
      documentUrls: [url],
    });
    const existing = contexts.find((c) => c.tabId >= 0);
    if (existing) {
      await browser.tabs.update(existing.tabId, { active: true });
      const tab = await browser.tabs.get(existing.tabId);
      await browser.windows.update(tab.windowId, { focused: true });
    } else await browser.tabs.create({ url });
  }
  browser.runtime.onInstalled.addListener((details) => {
    void syncAuthorizedSites(true).catch(() => {});
    if (details.reason === "install")
      void guide
        .initializeOnInstall()
        .then((created) => {
          if (created) return openTutorial();
        })
        .catch(() => {});
  });
  void syncAuthorizedSites().catch(() => {});
  browser.permissions.onAdded.addListener(() => {
    void syncAuthorizedSites(true).catch(() => {});
  });
  browser.runtime.onConnect.addListener((port) => {
    if (
      port.name !== "leximeet-panel" ||
      !port.sender ||
      !trustedSender(port.sender, browser.runtime.id)
    )
      return;
    port.onMessage.addListener((message) => {
      if (message?.type === "init" && Number.isInteger(message.windowId)) {
        panels.set(port, { windowId: message.windowId, visible: true });
        void panelVisibility(message.windowId, true);
        void broadcast();
      }
      if (message?.type === "visibility") {
        const panel = panels.get(port);
        if (panel) {
          panel.visible = message.visible === true;
          void panelVisibility(panel.windowId, panel.visible);
        }
      }
    });
    port.onDisconnect.addListener(() => {
      const panel = panels.get(port);
      panels.delete(port);
      if (
        panel &&
        ![...panels.values()].some(
          (item) => item.windowId === panel.windowId && item.visible,
        )
      )
        void panelVisibility(panel.windowId, false);
    });
  });
  browser.tabs.onActivated.addListener((info) => {
    void browser.runtime
      .sendMessage({
        channel: "leximeet-workspace",
        event: "activated",
        tabId: info.tabId,
      })
      .catch(() => {});
    void (async () => {
      await draftsReady;
      for (const page of pages.values()) {
        if (pageWindows.get(page.tabId) !== info.windowId || page.tabId === info.tabId)
          continue;
        if (page.phase === "capture") {
          // 浏览器标签已切换，先恢复原网页，保留未提交草稿并向真实侧栏请求决定。
          if (!captureSwitches.has(info.windowId))
            captureSwitches.set(info.windowId, {
              id: crypto.randomUUID(),
              tabId: page.tabId,
              title: page.title,
              destinationTabId: info.tabId,
              unsavedCount: page.drafts.length,
              generation: page.generation,
              documentId: page.documentId,
            });
          await persistDrafts();
          await end(page.tabId, "");
        } else if (page.phase === "analyzing") await end(page.tabId, "", true);
      }
      const tab = await browser.tabs.get(info.tabId);
      await configureWorkspaceTab(tab);
      if (managementTabs.has(info.tabId)) await closeReadingPanelForWorkspace(info.tabId);
      await broadcast();
      if (visibility.get(info.windowId) && !captureSwitches.has(info.windowId))
        await ensurePage(info.tabId).catch(() => {});
    })().catch(() => {});
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    for (const [windowId, pending] of captureSwitches)
      if (pending.tabId === tabId) captureSwitches.delete(windowId);
    managementTabs.delete(tabId);
    pages.delete(tabId);
    pageWindows.delete(tabId);
    retainedDrafts.delete(tabId);
    void persistDrafts().catch(() => {});
    void broadcast();
  });
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    // 导航后旧管理页身份失效；真实 options 页面加载会重新注册自己的 tab ID。
    if (change.status === "loading" && managementTabs.delete(tabId))
      void browser.sidePanel.setOptions({ tabId, enabled: true }).catch(() => {});
    if (change.url || change.status === "complete")
      void configureWorkspaceTab(tab).catch(() => {});
    const page = pages.get(tabId);
    if (change.status === "complete") {
      void broadcast();
      if (
        visibility.get(tab.windowId) &&
        (sitePattern(tab.url) || isTutorialPage(tab.url, browser.runtime.id))
      )
        void ensurePage(tabId).catch(() => {});
    }
    if (!page) return;
    if (change.status === "loading") {
      retain(page);
      // 导航开始立即撤掉旧来源与位置，不能在侧栏继续呈现上一页的词卡。
      pages.delete(tabId);
      nextOperation(tabId);
      void pageCall(tabId, "end", { reason: "页面已导航，旧位置失效" }, false).catch(
        () => {},
      );
      void broadcast();
    } else if (change.url && locationChanged(page.url, change.url)) {
      page.url = sanitizeUrl(change.url);
      page.occurrences = [];
      page.selectedId = null;
      void end(tabId, "页面已软导航，请重新分析");
    }
  });
  browser.permissions.onRemoved.addListener(() => {
    for (const page of pages.values()) void end(page.tabId, "网站权限已变更，网页已恢复");
    void syncAuthorizedSites().catch(() => {});
  });

  async function ensurePage(tabId: number): Promise<PageState> {
    try {
      await pageCall(tabId, "ping", {}, false);
    } catch {
      const tab = await browser.tabs.get(tabId);
      if (await isTutorialTab(tabId)) {
        for (let i = 0; !pages.has(tabId) && i < 30; i++)
          await new Promise((resolve) => setTimeout(resolve, 25));
      } else
        await browser.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          files: ["/content-scripts/page.js"],
        });
      await pageCall(tabId, "ping", {}, false);
    }
    for (let attempt = 0; !pages.has(tabId) && attempt < 20; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const page = pages.get(tabId);
    if (!page) throw new Error("此页面不支持分析，请从浏览器工具栏重新授权当前页");
    return page;
  }

  async function analyze(
    tabId: number,
    mode: "encounter" | "capture",
    ticket = connection.ticket(),
  ) {
    await connection.ready();
    assertOwnerAvailable(ticket);
    if (connection.connectedMode) await connection.active();
    const page = await ensurePage(tabId);
    assertOwnerAvailable(ticket);
    if (mode === "capture") requireWebCapture(page);
    if (page.phase === "capture") throw new Error("请先完成或取消当前采集");
    const operation = nextOperation(tabId);
    desktopProjections.delete(tabId);
    page.phase = "analyzing";
    page.resultMode = mode;
    page.occurrences = [];
    page.selectedId = null;
    page.message = mode === "capture" ? "正在进入采集…" : "正在分析当前已加载正文…";
    allowedCandidates.set(tabId, new Map());
    await broadcast();
    try {
      if (mode === "capture") {
        const tab = await browser.tabs.get(tabId);
        assertCurrent(page, operation);
        if (visibility.get(tab.windowId) === false)
          throw new Error("请先打开词遇侧栏再采集");
      }
      await pageCall(tabId, mode === "capture" ? "capture-start" : "scan", {
        mode,
        preserveSurface: connection.connectedMode,
      });
      assertCurrent(page, operation);
      page.phase = mode;
      await broadcast();
      return true;
    } catch (error) {
      // 较旧分析的晚到回执不能撤销更新的操作，也不显示取消提示。
      if (operations.get(tabId) !== operation || pages.get(tabId) !== page) return false;
      await end(tabId, (error as Error).message);
      throw error;
    }
  }

  const collectorLookups = new WeakMap<PageState, number>();
  const collectorSaves = new WeakMap<PageState, Promise<unknown>>();
  async function content(message: any, sender: any) {
    if (!contentSender(sender, browser.runtime.id)) throw new Error("内容脚本身份无效");
    await connection.ready();
    assertOwnerAvailable();
    const contentTicket = connection.ticket();
    const tabId = sender.tab.id as number;
    const data = message.data || {};
    let page = pages.get(tabId);
    if (message.action === "hello") {
      if (typeof data.generation !== "string" || data.generation.length > 100)
        throw new Error("页面代次无效");
      const identity = {
        tabId,
        documentId: sender.documentId,
        generation: data.generation,
      };
      const theme = (await localLibrary.settings()).theme;
      if (!visibility.has(sender.tab.windowId)) {
        const contexts = await browser.runtime.getContexts({
          contextTypes: ["SIDE_PANEL"],
        });
        if (contexts.length) {
          // 只接受当前窗口真实面板的回执；全局 SIDE_PANEL 的 context.windowId 可为 -1。
          const presence = await browser.runtime
            .sendMessage({
              channel: "leximeet-panel-presence",
              windowId: sender.tab.windowId,
            })
            .catch(() => null);
          if (presence) visibility.set(sender.tab.windowId, presence.visible === true);
        }
      }
      assertOwnerAvailable(contentTicket);
      if (sameDocument(page, identity))
        return helloProjection(visibility.get(sender.tab.windowId) === true, theme);
      if (page) {
        retain(page);
        await end(tabId, "页面文档已更新");
      }
      assertOwnerAvailable(contentTicket);
      if (sameDocument(pages.get(tabId), identity))
        return helloProjection(visibility.get(sender.tab.windowId) === true, theme);
      page = documentSession(undefined, identity, {
        title: String(sender.tab.title || "").slice(0, 300),
        url: readingSourceUrl(sender.url, browser.runtime.id),
      });
      assertOwnerAvailable(contentTicket);
      page.drafts = structuredClone(retainedDrafts.get(tabId) || []).filter(
        (draft) => !draft.ownerTicket || draft.ownerTicket === contentTicket,
      );
      if (retainedDrafts.has(tabId))
        page.message = "网页会话已恢复，请重新分析；草稿保留";
      pages.set(tabId, page);
      pageWindows.set(tabId, sender.tab.windowId);
      await broadcast();
      return {
        ...helloProjection(visibility.get(sender.tab.windowId) === true, theme),
        resetSession: true,
      };
    }
    // MV3 休眠后由当前文档重新握手；再核对请求代次，旧文档不能借恢复绕过身份校验。
    if (!page) page = await ensurePage(tabId);
    assertOwnerAvailable(contentTicket);
    if (
      !sameDocument(page, {
        tabId,
        documentId: sender.documentId,
        generation: message.generation,
      })
    )
      throw new Error("页面会话已失效，请重新分析");
    if (!page) throw new Error("页面会话不存在");
    const operation = operations.get(tabId) || 0;
    const assert = () => {
      assertOwnerAvailable(contentTicket);
      assertCurrent(page!, operation);
    };
    switch (message.action) {
      case "resolve": {
        if (
          page.phase !== "analyzing" ||
          !Array.isArray(data.words) ||
          data.words.length > 100 ||
          data.words.some(
            (word: unknown) => typeof word !== "string" || !encounterWord(word),
          )
        )
          throw new Error("候选词查询无效");
        const candidates = allowedCandidates.get(tabId)!;
        if (candidates.size + data.words.length > 500)
          throw new Error("本轮候选超过 500 词预算");
        if (connection.connectedMode) {
          const ticket = connection.ticket();
          const remote = await desktopReading.matches(data.words);
          assert();
          connection.assertTicket(ticket);
          const previous = desktopProjections.get(tabId);
          const until = Date.now() + Math.min(remote.refreshAfterMs, 30_000);
          desktopProjections.set(tabId, {
            ticket,
            revision: remote.workspaceRevision,
            until:
              previous && previous.ticket === ticket
                ? Math.min(previous.until, until)
                : until,
          });
          const result = [];
          for (const item of remote.results) {
            const token = data.words[item.inputIndex];
            const eligible = item.matches.filter(
              (match) => match.inTarget || match.collected,
            );
            if (!item.complete || !eligible.length) continue;
            const selected = eligible.length === 1 ? eligible[0] : null;
            const candidate = {
              normalized: normalize(token),
              matchKey: token,
              wordId:
                selected?.word.kind === "dictionary"
                  ? selected.word.entryId
                  : selected?.word.kind === "custom"
                    ? selected.word.customId
                    : undefined,
              refreshAfterMs: Math.max(1, until - Date.now()),
              status: selected?.learningStatus,
              origin:
                eligible.some((m) => m.inTarget) && eligible.some((m) => m.collected)
                  ? ("both" as const)
                  : eligible.some((m) => m.inTarget)
                    ? ("target" as const)
                    : ("manual" as const),
            };
            candidates.set(token, candidate);
            result.push(candidate);
          }
          return result;
        }
        const words = await localLibrary.listWords();
        const saved = new Map(words.map((word) => [word.normalized, word]));
        const learningByWord = new Map<string, LearningEvent[]>();
        for (const event of learningEvents(await localLibrary.practice())) {
          const group = learningByWord.get(event.wordId) || [];
          group.push(event);
          learningByWord.set(event.wordId, group);
        }
        const target = await learningTarget();
        assert();
        const result = [];
        for (const word of data.words as string[]) {
          const normalized = normalize(word);
          let canonical = normalized;
          let personal = saved.get(normalized);
          if (!target.has(canonical) && !personal) {
            canonical = await canonicalWord(word);
            assert();
            personal = saved.get(canonical);
          }
          const inTarget = target.has(canonical),
            manual = !!personal && personal.collected !== false;
          if (page.resultMode === "encounter" && !inTarget && !manual) continue;
          if (
            page.resultMode === "capture" &&
            (!publicWord(word) || word.length < 3 || word.length > 40)
          )
            continue;
          const origin =
            inTarget && manual
              ? "both"
              : inTarget
                ? "target"
                : manual
                  ? "manual"
                  : "other";
          const candidate = {
            normalized,
            wordId: personal?.id,
            status: projectLearning(personal ? learningByWord.get(personal.id) || [] : [])
              .status,
            origin,
          } as const;
          candidates.set(normalized, candidate);
          result.push(candidate);
        }
        return result;
      }
      case "scan-complete": {
        if (
          page.phase !== "analyzing" ||
          !Array.isArray(data.occurrences) ||
          data.occurrences.length > 10000 ||
          data.occurrences.some(
            (item: any) =>
              !encounterWord(item.surface) ||
              !allowedCandidates
                .get(tabId)
                ?.has(connection.connectedMode ? item.surface : normalize(item.surface)),
          )
        )
          throw new Error("网页分析结果超出预算");
        const candidates = allowedCandidates.get(tabId)!;
        const candidateFor = (surface: string) =>
          candidates.get(connection.connectedMode ? surface : normalize(surface));
        page.occurrences = data.occurrences.map((item: any) => ({
          id: String(item.id),
          surface: item.surface,
          normalized: normalize(item.surface),
          wordId: candidateFor(item.surface)?.wordId,
          status: candidateFor(item.surface)?.status,
          origin: candidateFor(item.surface)?.origin,
          start: 0,
          end: 0,
          sentence: "",
          sentenceStart: 0,
        }));
        page.partial = !!data.partial;
        page.selectedId =
          page.resultMode === "capture" ? null : page.occurrences[0]?.id || null;
        page.message = page.partial
          ? "已分析部分正文，达到本轮预算"
          : `找到 ${new Set(page.occurrences.map((item) => item.normalized)).size} 个词、${page.occurrences.length} 处位置`;
        await broadcast();
        return true;
      }
      case "select": {
        if (!page.occurrences.some((item) => item.id === data.id))
          throw new Error("位置已失效");
        page.selectedId = data.id;
        await broadcast();
        return true;
      }
      case "lookup": {
        if (
          !publicWord(data.word) ||
          !page.occurrences.some((item) => item.normalized === normalize(data.word))
        )
          throw new Error("仅可查询当前页已分析词项");
        return readingDictionary(data.word);
      }
      case "pronunciation": {
        if (
          !publicWord(data.word) ||
          !page.occurrences.some((i) => i.normalized === normalize(data.word))
        )
          throw new Error("仅可朗读当前页词项");
        if (connection.connectedMode) return defaultWorkspacePreferences().pronunciation;
        const pref = await localLibrary.workspaceMeta<WorkspacePreferences>("workspace");
        return (pref || defaultWorkspacePreferences()).pronunciation;
      }
      case "collector-lookup": {
        if (!publicWord(data.word)) throw new Error("单词无效");
        const now = Date.now();
        if (now - (collectorLookups.get(page) || 0) < 100)
          throw new Error("请稍候再查词");
        collectorLookups.set(page, now);
        return readingDictionary(data.word);
      }
      case "collector-capture": {
        requireWebCapture(page);
        const pick = pickedWord(data);
        if (!/^[a-f0-9-]{36}$/.test(data.eventId || "")) throw new Error("采集事件无效");
        // 单次拖拽只保存松手时的一词。与侧栏草稿隔离，绝不顺带提交其他待加入内容。
        const previous = collectorSaves.get(page) || Promise.resolve();
        const saved = previous
          .catch(() => {})
          .then(async () => {
            assert();
            const ticket = contentTicket;
            const fingerprint = await pickFingerprint(pick);
            const original = page!.drafts.find((item) => item.eventId === data.eventId);
            if (
              original &&
              (original.ownerTicket !== ticket ||
                original.surface !== pick.surface ||
                (original.pickFingerprint
                  ? original.pickFingerprint !== fingerprint
                  : original.originalSentence !== pick.sentence ||
                    original.occurrenceRanges?.[0]?.start !== pick.start))
            )
              throw new Error("原采集意图的归属或语境已变化，请在侧栏查看原草稿");
            // 失败后的同一事件复用 Desktop 身份，尤其自定义词不能每次重建 customId。
            const dictionary =
              original?.dictionary ?? (await readingDictionary(pick.surface, ticket));
            const desktopWord =
              original?.desktopWord ??
              (connection.connectedMode
                ? (await desktopReading.prepareSelection(pick.surface)).word || undefined
                : undefined);
            connection.assertTicket(ticket);
            assert();
            const ranges = [{ start: pick.start, end: pick.start + pick.surface.length }];
            const policy = original?.capturePolicy ?? (await capturePolicy(ticket));
            const capture = prepareSafeCapture(
              {
                eventId: data.eventId,
                surface: pick.surface,
                originalSentence: pick.sentence,
                savedExcerpt: pick.sentence,
                occurrenceRanges: ranges,
                excerptRanges: ranges,
                annotation: { note: "" },
                source: {
                  title: page!.title,
                  url: sanitizeUrl(page!.url) || page!.url,
                },
                occurredAt: new Date().toISOString(),
                timeZone:
                  typeof data.timeZone === "string" ? data.timeZone.slice(0, 80) : "UTC",
                dictionary,
              },
              policy,
            );
            let status: "created" | "duplicate-context" = "created";
            if (connection.connectedMode) {
              const draft: Draft = original ?? {
                ...capture,
                source: { ...capture.source, type: "browser" },
                occurrenceId: pick.id,
                desktopWord,
                ownerTicket: ticket,
                pickFingerprint: fingerprint,
                capturePolicy: policy,
              };
              const retainUnconfirmed = () => {
                assertOwnerAvailable(ticket);
                assert();
                if (!page!.drafts.some((item) => item.eventId === draft.eventId))
                  page!.drafts.push(draft);
                page!.selectedId = pick.id;
                retain(page!);
              };
              if (!desktopWord) {
                retainUnconfirmed();
                await broadcast();
                return {
                  saved: false,
                  message:
                    "这个拼写有多个词条，已保留草稿；右键打开侧栏，选择词条后加入。",
                };
              }
              try {
                status =
                  (await desktopReading.save(draft, null, ticket)).captureStatus ??
                  "created";
              } catch (error) {
                retainUnconfirmed();
                await broadcast();
                throw new Error(
                  "采集未确认，原草稿已保留；请在侧栏重试加入。" +
                    (error as Error).message,
                );
              }
            } else status = (await localLibrary.capture(capture)).captureStatus;
            assertOwnerAvailable(ticket);
            assert();
            if (status === "created")
              await guide.record("collector-captured", {
                windowId: sender.tab.windowId,
                tabId,
              });
            await broadcast();
            return {
              saved: true,
              captureStatus: status,
              message:
                status === "duplicate-context"
                  ? `相同语境已记录，${policy.duplicateWindowDays}天内不再新增`
                  : `已将 ${pick.surface} 加入单词本`,
            };
          });
        collectorSaves.set(page, saved);
        return saved;
      }
      case "collect": {
        if (page.phase !== "capture") throw new Error("当前没有采集会话");
        requireWebCapture(page);
        const pick = pickedWord(data);
        const occurrence = page.occurrences.find((item) => item.id === pick.id);
        if (occurrence && occurrence.surface !== pick.surface)
          throw new Error("点选位置身份不一致");
        const existing = () =>
          page!.drafts.find((draft) => draft.occurrenceId === pick.id);
        if (existing()) return { collected: true, eventId: existing()!.eventId };
        const ownerTicket = connection.ticket();
        const dictionary = await readingDictionary(pick.surface);
        const desktopWord = connection.connectedMode
          ? (await desktopReading.prepareSelection(pick.surface)).word || undefined
          : undefined;
        connection.assertTicket(ownerTicket);
        assert();
        // 异步查词后重新检查，连续点同一处只产生一个不可变事件。
        if (existing()) return { collected: true, eventId: existing()!.eventId };
        if (page.drafts.length >= 50) throw new Error("每批最多收取 50 条语境");
        const ranges = [{ start: pick.start, end: pick.start + pick.surface.length }];
        const policy = await capturePolicy(ownerTicket);
        const draft: Draft = {
          ...prepareSafeCapture(
            {
              eventId: crypto.randomUUID(),
              surface: pick.surface,
              originalSentence: pick.sentence,
              savedExcerpt: pick.sentence,
              occurrenceRanges: ranges,
              excerptRanges: ranges,
              annotation: { note: "" },
              source: {
                type: "browser",
                title: page.title,
                url: sanitizeUrl(page.url) || page.url,
              },
              occurredAt: new Date().toISOString(),
              timeZone:
                typeof data.timeZone === "string" ? data.timeZone.slice(0, 80) : "UTC",
              occurrenceId: pick.id,
              dictionary,
            },
            policy,
          ),
          desktopWord,
          ownerTicket,
          capturePolicy: policy,
          pickFingerprint: await pickFingerprint(pick),
        };
        if (!occurrence)
          page.occurrences.push({
            id: pick.id,
            surface: pick.surface,
            normalized: normalize(pick.surface),
            start: 0,
            end: 0,
            sentence: "",
            sentenceStart: 0,
          });
        page.drafts.push(draft);
        page.selectedId = pick.id;
        retain(page);
        await broadcast();
        return { collected: true, eventId: draft.eventId };
      }
      case "projection-expired":
        desktopProjections.delete(tabId);
        page.occurrences = [];
        page.selectedId = null;
        await end(tabId, "桌面结果已过期，请重新分析", true);
        return true;
      case "invalidated":
        page.occurrences = [];
        page.selectedId = null;
        await end(tabId, "网页正文已变更，请重新分析");
        return true;
      case "navigated":
        page.title = String(data.title || page.title).slice(0, 300);
        page.url = readingSourceUrl(sender.url, browser.runtime.id);
        page.occurrences = [];
        page.selectedId = null;
        await end(tabId, "页面已导航，请重新分析");
        return true;
      case "cancel":
        await end(tabId, "采集已取消，草稿保留");
        return true;
      case "open":
        void browser.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
        return true;
      case "open-options":
        await browser.runtime.openOptionsPage();
        return true;
      case "set-encounter": {
        if (typeof data.enabled !== "boolean") throw new Error("遇见开关无效");
        if (data.enabled) {
          const done = await analyze(tabId, "encounter", contentTicket);
          if (done)
            await guide
              .record("analyzed", { windowId: sender.tab.windowId, tabId })
              .catch(() => {});
          return { enabled: done && page.phase === "encounter" };
        }
        if (page.phase === "capture") throw new Error("请在侧栏结束采集");
        await end(tabId, "", true);
        await guide
          .record("deactivated", { windowId: sender.tab.windowId, tabId })
          .catch(() => {});
        return { enabled: false };
      }
      case "guide-view": {
        const g = await guide.status();
        const active =
          g.active &&
          isTutorialPage(sender.url, browser.runtime.id) &&
          (g.readingTabId === tabId || g.readingTabId === null);
        // 网页仅得到引导阶段；不包含个人本、语境、账号、绑定标签身份。
        return {
          active,
          step: guideStep(g),
          floating: g.floating,
          encounterAnalyzed: g.encounterAnalyzed === true,
          advancedAt: g.advancedAt || 0,
        };
      }
      case "guide-dismiss": {
        const g = await guide.status();
        if (
          isTutorialPage(sender.url, browser.runtime.id) &&
          (g.readingTabId === tabId || g.readingTabId === null)
        )
          await guide.pause();
        return true;
      }
      case "guide-pinning":
        if (!isTutorialPage(sender.url, browser.runtime.id))
          throw new Error("仅教学页可以打开固定帮助");
        await browser.tabs.create({
          url: `chrome://extensions/?id=${browser.runtime.id}`,
        });
        return true;
      case "guide-workspace":
        if (!isTutorialPage(sender.url, browser.runtime.id))
          throw new Error("仅教学页可以结束教学");
        await browser.runtime.openOptionsPage();
        return true;
      case "guide-word-card":
        if (
          isTutorialPage(sender.url, browser.runtime.id) &&
          page.phase === "encounter" &&
          page.occurrences.some((item) => item.id === data.id)
        )
          await guide.record("word-card", {
            windowId: sender.tab.windowId,
            tabId,
          });
        return true;
      case "guide-floating-hover":
        await guide
          .record("hovered", { windowId: sender.tab.windowId, tabId })
          .catch(() => {});
        return true;
      case "ball-position": {
        const origin = new URL(sender.url).origin;
        const key = ballStorageKey(origin);
        if (data.position) {
          const result = snapBallPosition(
            Number(data.position.left),
            Number(data.position.top),
            data.viewport || { width: 1280, height: 800 },
          );
          await browser.storage.local.set({ [key]: result });
          await updateFloating(
            floatingPlacement(result, data.viewport || { width: 1280, height: 800 }),
          );
          return result;
        }
        const saved = await browser.storage.local.get(key);
        return parseBallPosition(saved[key]) || null;
      }
      case "floating-config":
        return floatingProjection(await floatingConfig(), new URL(sender.url).origin);
      case "floating-update": {
        const patch: Partial<FloatingPreferences> = {};
        if (typeof data.locked === "boolean") patch.locked = data.locked;
        const origin = new URL(sender.url).origin;
        return floatingProjection(
          await updateFloating((config) => ({
            ...patch,
            ...(data.hideSite === true
              ? { hiddenOrigins: [...config.hiddenOrigins, origin] }
              : {}),
          })),
          origin,
        );
      }
      default:
        throw new Error("内容脚本无权调用此操作");
    }
  }

  async function trusted(
    action: string,
    data: any,
    sender: { url?: string; tab?: { id?: number } },
  ) {
    await connection.ready();
    // 控制状态必须在配对/断开期间可读；业务读取、采集仍走下面的归属闸门。
    // 切换期间只返回脱敏控制视图，避免心跳与投影清理竞争正在切换的资料。
    if (action === "connection-state") {
      if (!ownerSwitching) await refreshConnection();
      return { ...(await connection.view()), ownerReady: !ownerSwitching };
    }
    const confirmationOnly =
      new URL(sender.url || "https://invalid.invalid").pathname ===
      "/connection-confirmation.html";
    if (action === "desktop-discovery-state") return discovery.view();
    if (action === "desktop-check") {
      await discovery.poll();
      return discovery.view();
    }
    if (action === "desktop-request-connection") {
      if (!isWorkspaceTab(sender)) throw new Error("请从管理页发起连接");
      return discovery.request();
    }
    if (["desktop-confirm-connection", "desktop-cancel-connection"].includes(action)) {
      if (!confirmationOnly) throw new Error("请在真实连接确认窗口操作");
      return action === "desktop-confirm-connection"
        ? discovery.confirm(String(data.invitationId || ""))
        : discovery.cancel(String(data.invitationId || ""));
    }
    if (confirmationOnly) throw new Error("连接确认窗口只能操作连接邀请");
    assertOwnerAvailable();
    const requestTicket = connection.ticket();
    const windowId = data.windowId;
    const tab = Number.isInteger(windowId) ? await currentTab(windowId) : null;
    assertOwnerAvailable(requestTicket);
    const page = tab?.id ? pages.get(tab.id) : undefined;
    if (Number.isInteger(data.expectedTabId) && data.expectedTabId !== tab?.id)
      throw new Error("标签页已经变化，请在当前页重试");
    switch (action) {
      case "desktop-disconnect":
        if (!isWorkspaceTab(sender)) throw new Error("仅管理页可以断开连接");
        ownerSwitching = true;
        try {
          await discovery.suppress();
          await pauseReadingOwner();
          await connection.disconnect();
        } finally {
          try {
            // 断开可能已恢复 A，但清理归属记录时失败。按真实归属隔离 C，
            // 不能因 Promise 报错就把桌面未决草稿展示或保存到独立资料。
            if (!connection.connectedMode) await switchReadingOwner(false, true);
          } finally {
            await finishOwnerSwitch();
          }
        }
        return connection.view();
      case "desktop-card":
        return desktopReading.card(String(data.word || ""));
      case "desktop-select-word": {
        const ticket = connection.ticket();
        const surface = String(data.surface || "");
        await desktopReading.select(surface, data.word);
        assertOwnerAvailable(ticket);
        for (const draftPage of pages.values()) {
          for (const draft of draftPage.drafts)
            if (
              draft.surface === surface &&
              draft.ownerTicket === ticket &&
              !draft.desktopWord
            )
              draft.desktopWord = structuredClone(data.word);
          retain(draftPage);
        }
        await broadcast();
        return true;
      }
      case "desktop-notebooks": {
        const ticket = connection.ticket();
        const items = await desktopReading.notebooks();
        assertOwnerAvailable(ticket);
        const context = connection.readContext();
        if (!context) throw new Error("桌面只读租期已失效，请恢复连接");
        return {
          items,
          refreshAfterMs: Math.max(
            1,
            Math.min(30_000, Date.parse(context.readLeaseUntil) - Date.now()),
          ),
        };
      }
      case "desktop-open": {
        if (!["library", "plan", "settings", "word"].includes(data.target))
          throw new Error("桌面导航目标无效");
        return (await connection.active()).openInDesktop(
          data.target,
          crypto.randomUUID(),
          data.word,
        );
      }
      case "workspace-ready":
        // 无 tabs 权限时不能依赖 tabs.query 的 URL；管理页以自己的真实 tab ID 注册。
        // 入口已由 trustedSender 校验，内容脚本和侧栏不能禁用任意标签。
        if (
          !isWorkspaceTab(sender) ||
          !Number.isInteger(data.tabId) ||
          (sender.tab && sender.tab.id !== data.tabId)
        )
          throw new Error("仅管理页可以配置自己的阅读侧栏");
        await configureWorkspaceTab({ id: data.tabId, url: sender.url });
        await closeReadingPanelForWorkspace(data.tabId);
        return true;
      // 账号/桌面状态只在可信扩展页面查询；网页内容脚本没有此消息入口。
      case "guide-state":
        return guide.status();
      case "guide-start": {
        const state = await guide.start();
        await openTutorial();
        return state;
      }
      case "guide-resume":
        return guide.resume();
      case "guide-pause":
        return guide.pause();
      case "guide-pinning":
        await browser.tabs.create({
          url: `chrome://extensions/?id=${browser.runtime.id}`,
        });
        return true;
      case "guide-overview":
        await openTutorial();
        return true;
      case "guide-reading": {
        const state = await guide.status();
        const reading =
          state.readingTabId === null
            ? null
            : await browser.tabs.get(state.readingTabId).catch(() => null);
        if (reading?.id && (await isTutorialTab(reading.id))) {
          await browser.tabs.update(reading.id, { active: true });
          await browser.windows.update(reading.windowId, { focused: true });
        } else await openTutorial();
        return true;
      }
      case "integration-status":
        return services.integrationStatus();
      case "state":
        return state(windowId);
      case "analyze":
        if (captureSwitches.has(windowId)) throw new Error("请先选择是否继续原页采集");
        if (!tab?.id || !(sitePattern(tab.url) || (await isTutorialTab(tab.id))))
          throw new Error("请先点击工具栏的词遇，在当前网页启用阅读功能");
        await analyze(
          tab.id,
          data.mode === "capture" ? "capture" : "encounter",
          requestTicket,
        );
        if (data.mode !== "capture" && pages.get(tab.id)?.occurrences.length)
          await guide
            .record("encounter", { windowId: tab.windowId, tabId: tab.id })
            .catch(() => {});
        return true;
      case "collect":
        if (!tab?.id || page?.phase !== "capture") throw new Error("请先开始采集");
        return pageCall(tab.id, "collect", { id: data.id });
      case "capture-switch-decision": {
        const pending = captureSwitches.get(windowId);
        if (
          !pending ||
          pending.id !== data.decisionId ||
          typeof data.continue !== "boolean"
        )
          throw new Error("采集切换确认已失效");
        const original =
          pages.get(pending.tabId) ||
          (data.continue
            ? await ensurePage(pending.tabId).catch(() => undefined)
            : undefined);
        assertOwnerAvailable(requestTicket);
        if (data.continue) {
          if (
            !original ||
            original.generation !== pending.generation ||
            original.documentId !== pending.documentId
          )
            throw new Error("原网页已变化，请选择退出采集；原草稿仍保留");
          captureSwitches.delete(windowId);
          await persistDrafts();
          await browser.tabs.update(pending.tabId, { active: true });
          await analyze(pending.tabId, "capture", requestTicket);
        } else {
          if (original) {
            original.drafts = [];
            retain(original);
            await end(original.tabId, "", true);
          } else {
            retainedDrafts.delete(pending.tabId);
            await persistDrafts();
          }
          captureSwitches.delete(windowId);
          await persistDrafts();
          const current = await currentTab(windowId);
          if (current) {
            await configureWorkspaceTab(current);
            if (current.id && managementTabs.has(current.id))
              await closeReadingPanelForWorkspace(current.id);
          }
        }
        await broadcast();
        return true;
      }
      case "discard-capture":
        if (page && tab?.id) {
          page.drafts = [];
          retain(page);
          await end(tab.id, "", true);
        }
        return true;
      case "cancel":
        if (tab?.id) await end(tab.id);
        return true;
      case "close":
        if (tab?.id && page && ["capture", "analyzing"].includes(page.phase))
          await end(tab.id);
        await browser.sidePanel.close({ windowId });
        await panelVisibility(windowId, false);
        return true;
      case "select":
        if (!page || !tab?.id) throw new Error("页面已变化");
        page.selectedId = data.id;
        await pageCall(tab.id, "select", { id: data.id });
        await broadcast();
        return true;
      case "edit-draft": {
        if (!page) throw new Error("页面草稿已失效");
        const draft = page.drafts.find((item) => item.eventId === data.eventId);
        if (!draft) throw new Error("草稿不存在");
        if (
          connection.connectedMode &&
          connection.captureSubmitted(draft.eventId, requestTicket)
        )
          throw new Error("原采集结果尚未确认，请先重试原草稿");
        const savedExcerpt = String(data.savedExcerpt || "").slice(0, 4000);
        const next = prepareSafeCapture(
          {
            ...draft,
            savedExcerpt,
            excerptRanges: rangesFor(savedExcerpt, draft.surface),
            annotation: {
              note: String(data.note || "").slice(0, 4000),
            },
          },
          await capturePolicy(requestTicket),
        );
        Object.assign(draft, next);
        retain(page);
        await broadcast();
        return true;
      }
      case "remove-draft": {
        if (!page) return true;
        page.drafts = page.drafts.filter((item) => item.eventId !== data.eventId);
        retain(page);
        if (tab?.id) await pageCall(tab.id, "removed", { id: data.occurrenceId });
        await broadcast();
        return true;
      }
      case "clear-drafts":
        if (page) {
          page.drafts = [];
          retain(page);
          await broadcast();
        }
        return true;
      case "submit": {
        if (!page?.drafts.length || !tab?.id) throw new Error("请先从网页收取单词");
        // 逐条事务保存；任一失败时草稿保持不变，重试依事件 ID 幂等完成剩余条目。
        const ticket = requestTicket;
        const operation = operations.get(tab.id) || 0;
        const submission = structuredClone(page.drafts);
        let created = 0,
          duplicates = 0;
        for (const draft of submission) {
          assertOwnerAvailable(ticket);
          assertDraftOwner(draft, ticket);
          if (connection.connectedMode) {
            const result = await desktopReading.save(
              draft,
              typeof data.notebookId === "string" && data.notebookId
                ? data.notebookId
                : null,
              ticket,
            );
            if (result.captureStatus === "duplicate-context") duplicates++;
            else created++;
            continue;
          }
          if (draft.desktopWord)
            throw new Error("这是原桌面采集草稿，不能保存到独立资料");
          const result = await localLibrary.capture({
            eventId: draft.eventId,
            surface: draft.surface,
            originalSentence: draft.originalSentence,
            savedExcerpt: draft.savedExcerpt,
            occurrenceRanges: draft.occurrenceRanges,
            excerptRanges: draft.excerptRanges,
            annotation: draft.annotation,
            source: draft.source,
            occurredAt: draft.occurredAt,
            timeZone: draft.timeZone,
            dictionary: draft.dictionary,
            notebookId: typeof data.notebookId === "string" ? data.notebookId : undefined,
          });
          if (result.captureStatus === "duplicate-context") duplicates++;
          else created++;
        }
        assertOwnerAvailable(ticket);
        assertCurrent(page, operation);
        const submitted = new Set(submission.map((draft) => draft.eventId));
        const saved = created;
        const message = duplicates
          ? `已新增 ${created} 条语境，${duplicates} 条相同语境已记录`
          : `已将 ${saved} 条语境加入单词本`;
        page.drafts = page.drafts.filter((draft) => !submitted.has(draft.eventId));
        retain(page);
        if (!page.drafts.length) {
          await end(tab.id, message);
          await pageCall(tab.id, "capture-result", {
            status: "confirmed",
          }).catch(() => {});
        } else {
          page.message = message + `；新采集的 ${page.drafts.length} 条仍待加入`;
          await broadcast();
        }
        if (saved > 0)
          await guide
            .record("capture", { windowId: tab.windowId, tabId: tab.id })
            .catch(() => {});
        return { saved, duplicates, message };
      }
      case "lease":
        if (tab?.id && page?.phase === "capture") await pageCall(tab.id, "lease");
        return true;
      case "lookup":
        return connection.connectedMode
          ? (await desktopReading.card(String(data.word || ""))).entry
          : lexicon.lookup(String(data.word || ""));
      case "plan-saved":
        if (!isWorkspaceTab(sender)) throw new Error("仅管理页可以确认学习规划");
        await guide.record("plan");
        return true;
      case "capture-policy":
        if (!isWorkspaceTab(sender)) throw new Error("仅管理页可以设置采集策略");
        return capturePolicy(requestTicket);
      case "update-capture-policy":
        if (!isWorkspaceTab(sender) || connection.connectedMode)
          throw new Error("请到桌面端调整采集设置");
        return localLibrary.updateCapturePolicy(data.policy);
      case "settings-changed":
        targetIndex = undefined;
        canonicalGeneration++;
        canonicalWords.clear();
        syncTheme((await localLibrary.settings()).theme);
        await broadcast();
        return true;
      case "enable-site":
        if (
          !tab?.id ||
          !sitePattern(tab.url) ||
          !(await browser.permissions.contains({
            origins: [sitePattern(tab.url)!],
          }))
        )
          throw new Error("请先允许当前网站权限");
        await syncAuthorizedSites(true);
        await ensurePage(tab.id);
        return true;
      case "floating-config":
        return floatingConfig();
      case "floating-update": {
        const patch: Partial<FloatingPreferences> = {};
        if (typeof data.enabled === "boolean") patch.enabled = data.enabled;
        if (typeof data.locked === "boolean") patch.locked = data.locked;
        if (data.restoreHiddenSites === true) patch.hiddenOrigins = [];
        if (typeof data.hideOrigin === "string") {
          const origin = new URL(data.hideOrigin).origin;
          if (!sitePattern(origin)) throw new Error("网站地址无效");
          patch.hiddenOrigins = [...(await floatingConfig()).hiddenOrigins, origin];
        }
        return updateFloating(patch);
      }
      case "open-source": {
        const href =
          data.url === TUTORIAL_SOURCE
            ? browser.runtime.getURL(TUTORIAL_PATH)
            : sanitizeUrl(String(data.url || ""));
        if (!href) throw new Error("仅可打开已清理的 HTTP/HTTPS 来源");
        await browser.tabs.create({ url: href });
        return { opened: href };
      }
      case "open-workspace": {
        const state = await guide.status();
        const fromPanel = new URL(sender.url || "").pathname === "/sidepanel.html";
        await browser.tabs.create({
          url:
            browser.runtime.getURL("/options.html") +
            (state.active && state.completed.length === 2 ? "#/plan" : ""),
          ...(tab ? { windowId: tab.windowId } : {}),
        });
        if (fromPanel && tab)
          await guide.record("workspace", { windowId: tab.windowId }).catch(() => {});
        return true;
      }
      default:
        throw new Error("未知扩展操作");
    }
  }

  let confirmationWindow: number | undefined;
  const discovery = new DesktopDiscovery({
    store: new IndexedDiscoveryStore(),
    createClient: () => connection.createControlClient(),
    query: (client, invitationId) => connection.queryControl(client, invitationId),
    connection: () => connection.view(),
    changed: () => {
      void browser.runtime
        .sendMessage({ channel: "leximeet-connection-changed" })
        .catch(() => {});
    },
    async notify(displayName) {
      try {
        if ((await browser.notifications.getPermissionLevel()) !== "granted")
          return "denied";
        await browser.notifications.create("leximeet-desktop-available", {
          type: "basic",
          iconUrl: browser.runtime.getURL("/assets/brand/icon-128.png"),
          title: "发现词遇桌面端",
          message: `${displayName} 已就绪。点击后确认连接，原浏览器资料会保持封存。`,
        });
        return "enabled";
      } catch {
        return "unavailable";
      }
    },
    async showConfirmation() {
      const saved = await browser.storage.session.get("connectionConfirmationWindow");
      confirmationWindow =
        typeof saved.connectionConfirmationWindow === "number"
          ? saved.connectionConfirmationWindow
          : undefined;
      if (confirmationWindow !== undefined) {
        try {
          await browser.windows.update(confirmationWindow, { focused: true });
          return;
        } catch {
          confirmationWindow = undefined;
        }
      }
      // URL 固定，邀请 secret 只由受信窗口通过后台控制消息确认。
      const created = await browser.windows.create({
        url: browser.runtime.getURL("/connection-confirmation.html"),
        type: "popup",
        width: 520,
        height: 460,
        focused: true,
      });
      if (!created?.id) throw new Error("未能打开连接确认窗口，请在设置中重试");
      confirmationWindow = created.id;
      await browser.storage.session.set({
        connectionConfirmationWindow: created.id,
      });
    },
    async confirm(invitation) {
      if (ownerSwitching) throw new Error("正在切换资料");
      ownerSwitching = true;
      try {
        await guide.pause();
        await switchReadingOwner(true);
        await connection.connect(invitation);
      } catch (error) {
        if (!connection.connectedMode) await switchReadingOwner(false, true);
        throw error;
      } finally {
        await finishOwnerSwitch();
      }
    },
    async desktopDisconnected(status) {
      if (ownerSwitching) return;
      ownerSwitching = true;
      try {
        await pauseReadingOwner();
        await connection.acceptDesktopDisconnect(status);
      } finally {
        try {
          if (!connection.connectedMode) await switchReadingOwner(false, true);
        } finally {
          await finishOwnerSwitch();
        }
      }
    },
  });
  browser.notifications.onClicked.addListener((id) => {
    if (id === "leximeet-desktop-available") void discovery.request().catch(() => {});
  });
  browser.windows.onRemoved.addListener((id) => {
    if (id !== confirmationWindow) return;
    confirmationWindow = undefined;
    void browser.storage.session.remove("connectionConfirmationWindow");
    void discovery
      .view()
      .then((view) => {
        if (view.invitation && view.connection.mode === "independent")
          return discovery.cancel(view.invitation.invitationId);
      })
      .catch(() => {});
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "leximeet-desktop-discovery")
      void discovery.poll().catch(() => {});
  });
  // 每次 Worker 启动重建 alarm；无通道时靠 30 秒 alarm，活跃通道控制轮询限为 5 秒。
  void browser.alarms.create("leximeet-desktop-discovery", {
    periodInMinutes: 0.5,
  });
  queueMicrotask(() => void discovery.start().catch(() => {}));
  setInterval(() => {
    void discovery
      .view()
      .then((view) => {
        if (view.available) return discovery.poll();
      })
      .catch(() => {});
  }, 5000);
  browser.runtime.onMessage.addListener((message: any, sender: any, sendResponse) => {
    if (message?.channel !== "leximeet") return;
    // sidePanel.open 必须紧跟真实用户动作；不能在打开前等待词库或 storage 初始化。
    if (
      (message.action === "open" ||
        message.action === "close" ||
        (message.action === "guide-next" &&
          isTutorialPage(sender.url, browser.runtime.id))) &&
      contentSender(sender, browser.runtime.id) &&
      (!pages.has(sender.tab.id) ||
        sameDocument(pages.get(sender.tab.id), {
          tabId: sender.tab.id,
          documentId: sender.documentId,
          generation: message.generation,
        }))
    ) {
      return replyAsync(
        sendResponse,
        (message.action === "close"
          ? browser.sidePanel.close({ windowId: sender.tab.windowId })
          : browser.sidePanel.open({ windowId: sender.tab.windowId })
        ).then(
          async () => {
            if (message.action === "close") {
              // 收栏属于阅读入口控制；断线也能收起，草稿仍按原归属保留。
              await panelVisibility(sender.tab.windowId, false);
              return { ok: true, result: true };
            }
            await ensurePage(sender.tab.id).catch(() => {});
            // 教学页的打开按钮也必须等原生侧栏打开成功，不能由展示动作跳关。
            if (isTutorialPage(sender.url, browser.runtime.id)) {
              await guide.status();
              const location = {
                windowId: sender.tab.windowId,
                tabId: sender.tab.id,
              };
              if (message.action === "guide-next")
                await guide.continueWithPanel(location);
              else await guide.record("toolbar", location);
            }
            await guide
              .record("reopened", {
                windowId: sender.tab.windowId,
                tabId: sender.tab.id,
              })
              .catch(() => {});
            return { ok: true, result: true };
          },
          (error) => ({ ok: false, error: error.message }),
        ),
      );
    }
    return replyAsync(
      sendResponse,
      (async () => {
        try {
          if (encodedSize(message) > 262144) throw new Error("扩展消息过大");
          await draftsReady;
          const result = trustedSender(sender, browser.runtime.id)
            ? await trusted(message.action, message.data || {}, sender)
            : await content(message, sender);
          return { ok: true, result };
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      })(),
    );
  });
});
