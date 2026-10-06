export const GUIDE_STORAGE_KEY = "leximeet-onboarding-v2";
export const GUIDE_STEPS = [
  "pin",
  "panel",
  "plan",
  "encounter",
  "capture",
  "floating",
] as const;
export type GuideStep = (typeof GUIDE_STEPS)[number];
export type GuideLocation = { windowId: number; tabId?: number };
export type GuideEvent =
  | "toolbar"
  | "workspace"
  | "plan"
  | "encounter"
  | "word-card"
  | "capture"
  | "closed"
  | "hovered"
  | "analyzed"
  | "deactivated"
  | "reopened"
  | "collector-captured";
export type GuideState = {
  schema: "leximeet.onboarding/2";
  active: boolean;
  advancedAt?: number;
  completed: GuideStep[];
  windowId: number | null;
  readingTabId: number | null;
  workspaceOpened: boolean;
  encounterAnalyzed?: boolean;
  pinSkipped?: boolean; // 明确记录略过固定，不把略过伪装成 Chrome 已固定。
  floating: {
    closed: boolean;
    hovered: boolean;
    analyzed: boolean;
    deactivated?: boolean;
    reopened: boolean;
    reclosed: boolean; // 右键打开后，再右键实际收起原生侧栏。
    captured?: boolean;
    managed?: boolean; // 旧教学完成信息，仅兼容读取；新教学以再次右键收起侧栏为最后一步。
  };
};
export function emptyGuide(active = false): GuideState {
  return {
    schema: "leximeet.onboarding/2",
    active,
    advancedAt: 0,
    completed: [],
    windowId: null,
    readingTabId: null,
    workspaceOpened: false,
    encounterAnalyzed: false,
    pinSkipped: false,
    floating: {
      closed: false,
      hovered: false,
      analyzed: false,
      deactivated: false,
      reopened: false,
      reclosed: false,
      captured: false,
      managed: false,
    },
  };
}
export function validGuide(value: unknown): value is GuideState {
  const x = value as GuideState;
  return (
    !!x &&
    x.schema === "leximeet.onboarding/2" &&
    typeof x.active === "boolean" &&
    (x.advancedAt === undefined ||
      (Number.isFinite(x.advancedAt) && x.advancedAt >= 0)) &&
    Array.isArray(x.completed) &&
    x.completed.length <= GUIDE_STEPS.length &&
    x.completed.every((step, index) => step === GUIDE_STEPS[index]) &&
    [x.windowId, x.readingTabId].every(
      (id) => id === null || (Number.isInteger(id) && id >= 0),
    ) &&
    typeof x.workspaceOpened === "boolean" &&
    (x.pinSkipped === undefined || typeof x.pinSkipped === "boolean") &&
    (x.encounterAnalyzed === undefined || typeof x.encounterAnalyzed === "boolean") &&
    (x.floating?.deactivated === undefined ||
      typeof x.floating.deactivated === "boolean") &&
    [x.floating?.captured, x.floating?.managed].every(
      (v) => v === undefined || typeof v === "boolean",
    ) &&
    !!x.floating &&
    ["closed", "hovered", "analyzed", "reopened", "reclosed"].every(
      (k) => typeof x.floating[k as keyof GuideState["floating"]] === "boolean",
    )
  );
}
export function guideStep(state: GuideState): GuideStep | "complete" {
  return GUIDE_STEPS[state.completed.length] || "complete";
}
type GuidePorts = {
  load(): Promise<unknown>;
  save(state: GuideState): Promise<void>;
  pinned(): Promise<boolean>;
  planReady(): Promise<boolean>;
  finish(): Promise<void>;
};

// 只接受实际功能完成后的事件，不接受网页发送“某步骤已完成”；串行写入防止多面板竞态。
export class OnboardingGuide {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ports: GuidePorts;
  constructor(ports: GuidePorts) {
    this.ports = ports;
  }
  private change(fn: (state: GuideState, initialized: boolean) => Promise<void>) {
    const pending = this.queue.then(async () => {
      const saved = await this.ports.load();
      const initialized = validGuide(saved);
      const state = initialized ? structuredClone(saved) : emptyGuide();
      const before = JSON.stringify(state);
      state.encounterAnalyzed ??= state.completed.includes("encounter");
      state.floating.deactivated ??= false; // 保留旧六步教学的完成事实，为未完成教学补上新的开关步骤。
      state.floating.captured ??= state.completed.includes("floating");
      // 旧版已完成教学保留；未采词前打开过侧栏不能跳过最后的右键教学。
      if (!state.completed.includes("floating") && !state.floating.captured)
        state.floating.reopened = false;
      const completedBefore = state.completed.length;
      const floatingBefore = JSON.stringify(state.floating);
      await fn(state, initialized);
      if (
        state.completed.length > completedBefore ||
        (guideStep(state) === "floating" &&
          floatingBefore !== JSON.stringify(state.floating) &&
          (state.floating.analyzed ||
            state.floating.deactivated ||
            state.floating.captured))
      )
        state.advancedAt = Date.now();
      if (JSON.stringify(state) !== before) await this.ports.save(state);
      return state;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  // 安装事件可能重复到达；只初始化一次，不覆盖已跳过、进行中或完成的教学。
  initializeOnInstall(): Promise<boolean> {
    let created = false;
    return this.change(async (state, initialized) => {
      if (initialized) return;
      created = true;
      Object.assign(state, emptyGuide(true));
    }).then(() => created);
  }
  start() {
    return this.change(async (state) => {
      Object.assign(state, emptyGuide(true));
    });
  }
  resume() {
    return this.change(async (state) => {
      if (guideStep(state) !== "complete") state.active = true;
    });
  }
  pause() {
    return this.change(async (state) => {
      state.active = false;
    });
  }
  status() {
    return this.change(async (state) => {
      if (state.active && guideStep(state) === "pin" && (await this.ports.pinned()))
        state.completed.push("pin");
    });
  }
  // 只在“下一步”实际打开原生侧栏成功后调用；略过的是固定说明，教学继续。
  continueWithPanel(location: GuideLocation) {
    return this.change(async (state) => {
      if (!state.active || !["pin", "panel"].includes(guideStep(state))) return;
      if (guideStep(state) === "pin") {
        state.pinSkipped = !(await this.ports.pinned());
        state.completed.push("pin");
      }
      state.windowId = location.windowId;
      state.readingTabId = location.tabId ?? null;
      state.completed.push("panel");
    });
  }
  record(event: GuideEvent, location?: GuideLocation) {
    return this.change(async (state) => {
      if (!state.active) return;
      const step = guideStep(state);
      // 首次真实工具栏动作可绑定阅读页，但固定前的动作不能算“已经学会打开侧栏”。
      if (event === "toolbar" && location && (step === "pin" || step === "panel")) {
        state.windowId = location.windowId;
        state.readingTabId = location.tabId ?? null;
        if (step === "panel") state.completed.push("panel");
        return;
      }
      if (location && state.windowId !== location.windowId) return;
      // 阅读步骤只属于绑定的内置教学标签，不能被另一网页的操作跳过。
      if (
        ["encounter", "capture", "floating"].includes(step) &&
        location?.tabId !== undefined &&
        location.tabId !== state.readingTabId
      )
        return;
      if (step === "plan" && event === "workspace") state.workspaceOpened = true;
      if (
        step === "plan" &&
        event === "plan" &&
        state.workspaceOpened &&
        (await this.ports.planReady())
      )
        state.completed.push("plan");
      else if (step === "encounter" && event === "encounter")
        state.encounterAnalyzed = true;
      else if (step === "encounter" && event === "word-card" && state.encounterAnalyzed)
        state.completed.push("encounter");
      else if (step === "capture" && event === "capture") state.completed.push("capture");
      else if (step === "floating") {
        if (event === "closed") {
          state.floating.closed = true;
          if (state.floating.reopened) state.floating.reclosed = true;
        }
        if (state.floating.closed) {
          if (event === "hovered") state.floating.hovered = true;
          if (event === "analyzed") state.floating.analyzed = true;
          if (event === "deactivated" && state.floating.analyzed)
            state.floating.deactivated = true;
          if (event === "collector-captured" && state.floating.deactivated)
            state.floating.captured = true;
          if (event === "reopened" && state.floating.captured)
            state.floating.reopened = true;
        }
        if (
          state.floating.closed &&
          state.floating.analyzed &&
          state.floating.deactivated &&
          state.floating.captured &&
          state.floating.reopened &&
          state.floating.reclosed
        ) {
          await this.ports.finish();
          state.completed.push("floating");
          state.active = false;
        }
      }
      if (
        location?.tabId !== undefined &&
        ["encounter", "capture", "floating"].includes(step)
      )
        state.readingTabId = location.tabId;
    });
  }
}
