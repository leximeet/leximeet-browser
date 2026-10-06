import { defaultRules, normalize } from "./pure.ts";
import type { PageState, Settings } from "./types.ts";
export type DocumentIdentity = {
  tabId: number;
  documentId: string;
  generation: string;
};
export type RetainedDrafts = Pick<PageState, "drafts" | "target" | "draftIdentity">;
// Chrome documentId 和每次注入的 generation 同时一致，才是同一个可继续使用的页面。
export function sameDocument(page: PageState | undefined, identity: DocumentIdentity) {
  return (
    !!page &&
    page.tabId === identity.tabId &&
    page.documentId === identity.documentId &&
    page.generation === identity.generation
  );
}
// 幂等握手不重置分析/选择/草稿；worker 重建时只恢复会话草稿，旧 Range 不可复用。
export function documentSession(
  previous: PageState | undefined,
  identity: DocumentIdentity,
  source: { title: string; url: string },
  retained?: RetainedDrafts,
): PageState {
  if (sameDocument(previous, identity)) return previous!;
  return {
    ...identity,
    ...source,
    phase: "idle",
    occurrences: [],
    selectedId: null,
    drafts: [],
    partial: false,
    message: "点击分析本页，网页可继续阅读",
    target: { kind: "library" },
    browserRules: defaultRules(),
    ...(retained ? structuredClone(retained) : {}),
  };
}
// 此回复可发到网页：明确列出字段，绝不把重建的私人草稿/索引投影 spread 出去。
export function helloProjection(visible: boolean, theme: Settings["theme"]) {
  return { visible, theme };
}

// Tab 只选择结果投影，不修改页面会话或持久化草稿。未知/异模式结果必须保持为空。
export function occurrencesForMode(
  page: PageState | null | undefined,
  mode: "encounter" | "capture",
) {
  return page?.resultMode === mode ? page.occurrences : [];
}
/**
 * 遇见列表展示词，而不是逐个网页位置；Node/Node、The/the 各占一行。
 * 原 occurrence、原拼写和 Desktop 权威身份不改写。用户选中另一处时，
 * 该词的一行跟随所选位置，词卡/采集仍使用那一处的真实语境。
 */
export function encounterRows(
  occurrences: PageState["occurrences"],
  selectedId?: string | null,
) {
  const words = new Map<string, PageState["occurrences"][number]>();
  for (const occurrence of occurrences) {
    const key = normalize(occurrence.surface);
    if (!words.has(key) || occurrence.id === selectedId) words.set(key, occurrence);
  }
  return [...words.values()];
}
// 网页只接收固定回执状态，不接收历史、用户笔记或后台错误详情。
export function captureResultNotice(status: "confirmed" | "partial" | "pending") {
  return {
    confirmed: "已加入单词本；网页已恢复",
    partial: "部分条目未保存，请查看词遇侧栏草稿",
    pending: "正在保存到本机词本，请查看词遇侧栏",
  }[status];
}

// 只在可信侧栏呈现；切换浏览器标签时先停锁，再由用户决定是否返回原页继续。
export type CaptureSwitch = {
  id: string;
  tabId: number;
  title: string;
  destinationTabId: number;
  unsavedCount: number;
};

export type PendingCaptureSwitch = CaptureSwitch & {
  generation: string;
  documentId: string;
};
// 会话存储也需校验；损坏元数据不能指定任意标签或假装恢复采集。
export function validCaptureSwitch(value: unknown): value is PendingCaptureSwitch {
  const x = value as PendingCaptureSwitch;
  return (
    !!x &&
    typeof x.id === "string" &&
    x.id.length > 0 &&
    x.id.length <= 100 &&
    [x.tabId, x.destinationTabId].every((n) => Number.isInteger(n) && n >= 0) &&
    Number.isInteger(x.unsavedCount) &&
    x.unsavedCount >= 0 &&
    x.unsavedCount <= 50 &&
    typeof x.title === "string" &&
    x.title.length <= 300 &&
    [x.generation, x.documentId].every(
      (s) => typeof s === "string" && s.length > 0 && s.length <= 100,
    )
  );
}

// 封存草稿只装回原文档与原归属，不重新打开采集锁或复活 Range。
export function restoredPageDrafts(
  page: PageState,
  identity: DocumentIdentity | undefined,
  drafts: import("./types.ts").Draft[],
  ownerTicket: string,
) {
  if (!identity || !sameDocument(page, identity)) return [];
  return structuredClone(drafts).filter((draft) => draft.ownerTicket === ownerTicket);
}

// 未决多义草稿可能没有 desktopWord，归属须按 ticket 而非词条字段判断。
export function assertDraftOwner(draft: import("./types.ts").Draft, ticket: string) {
  if (draft.ownerTicket !== ticket)
    throw new Error("采集草稿不属于当前资料，请切回原连接或重新采集");
}
