import { validCapturePolicy, type CapturePolicy } from "./capture-policy.ts";
import type { LmcpClient } from "./connector/client.ts";
import type { DesktopConnection } from "./desktop-connection.ts";
import type { CoreEntry, LexiconEntry } from "./lexicon.ts";
import type { Dictionary, Draft } from "./types.ts";
import type {
  WordRef,
  WordSummary,
  MatchResult,
  NotebookRecord,
} from "./connector/types.ts";
import { LmcpError, sameWord } from "./connector/types.ts";

type Match = MatchResult["results"][number]["matches"][number];
export type DesktopCard = {
  choices: Match[];
  selected: WordRef | null;
  summary: WordSummary | null;
  entry: LexiconEntry | null;
  resourceMessage: string;
  refreshAfterMs: number;
};
// 连接模式只读展示模型和采集入口；不让远端 DTO 流入独立学习算法。
export class DesktopReading {
  private selected = new Map<string, WordRef>();
  private generation = "";
  private connection: DesktopConnection;
  constructor(connection: DesktopConnection) {
    this.connection = connection;
  }
  private ticket() {
    const ticket = this.connection.ticket();
    if (ticket !== this.generation) {
      this.selected.clear();
      this.generation = ticket;
    }
    return ticket;
  }
  // 保留绝对截止时刻；到期即停止投影，不能把负预算钳成 1ms 的新租期。
  private remaining(client: LmcpClient, ticket: string, ...deadlines: number[]): number {
    this.connection.assertTicket(ticket);
    const now = Date.now(),
      leaseUntil = client.session ? Date.parse(client.session.readLeaseUntil) : NaN;
    const remaining = Math.min(
      30_000,
      leaseUntil - now,
      ...deadlines.map((deadline) => deadline - now),
    );
    if (!client.connected || !Number.isFinite(remaining) || remaining <= 0)
      throw new Error("桌面只读租期或数据刷新期限已失效，请重新读取");
    return remaining;
  }
  private async match(client: LmcpClient, ticket: string, tokens: string[]) {
    this.remaining(client, ticket);
    const started = Date.now();
    const result = await client.matchWords({ kind: "tokens", tokens });
    const deadline = started + Math.min(result.refreshAfterMs, 30_000);
    this.remaining(client, ticket, deadline);
    return { result, deadline };
  }
  async matches(tokens: string[]) {
    const ticket = this.ticket(),
      client = await this.connection.active();
    const { result, deadline } = await this.match(client, ticket, tokens);
    return {
      ...result,
      refreshAfterMs: this.remaining(client, ticket, deadline),
    };
  }
  async select(surface: string, word: WordRef) {
    const ticket = this.ticket(),
      client = await this.connection.active();
    const { result, deadline } = await this.match(client, ticket, [surface]);
    const match = result.results[0]!;
    if (!match.complete || !match.matches.some((item) => sameWord(item.word, word)))
      throw new Error("所选词条不属于本次完整匹配");
    this.remaining(client, ticket, deadline);
    this.selected.set(surface, structuredClone(word));
  }
  private async resolve(
    client: LmcpClient,
    ticket: string,
    surface: string,
    allowCustom = false,
  ) {
    const { result, deadline } = await this.match(client, ticket, [surface]);
    const match = result.results[0]!;
    if (!match.complete) throw new Error("Desktop 匹配未完整返回，请缩小词条查询范围");
    const preferred = this.selected.get(surface);
    let selected: WordRef | null = null;
    if (preferred && match.matches.some((item) => sameWord(item.word, preferred)))
      selected = preferred;
    else if (match.matches.length === 1) selected = match.matches[0]!.word;
    else if (!match.matches.length && allowCustom)
      selected = {
        kind: "custom",
        customId: crypto.randomUUID(),
        headword: surface,
        language: "en",
      };
    this.remaining(client, ticket, deadline);
    return { choices: match.matches, selected, deadline };
  }
  async card(surface: string): Promise<DesktopCard> {
    const ticket = this.ticket(),
      client = await this.connection.active();
    const resolved = await this.resolve(client, ticket, surface);
    const { choices, selected } = resolved;
    if (!selected)
      return {
        choices,
        selected,
        summary: null,
        entry: null,
        refreshAfterMs: this.remaining(client, ticket, resolved.deadline),
        resourceMessage: choices.length
          ? "请选择要查看和采集的词条"
          : "桌面词典未收录，可作为自定义单词采集",
      };
    this.remaining(client, ticket, resolved.deadline);
    const started = Date.now();
    const summary = await client.getWord(selected);
    const summaryDeadline = started + Math.min(summary.refreshAfterMs, 30_000);
    this.remaining(client, ticket, resolved.deadline, summaryDeadline);
    let entry: LexiconEntry | null = null,
      resourceMessage = "";
    if (selected.kind === "dictionary" && summary.resourceStatus === "available") {
      try {
        const publicEntry = await client.getPublicEntry(selected);
        this.remaining(client, ticket, resolved.deadline, summaryDeadline);
        entry = projectDesktopEntry(publicEntry.entry as CoreEntry);
      } catch (error) {
        if (
          !(error instanceof LmcpError) ||
          !["RESOURCE_UNAVAILABLE", "PAYLOAD_TOO_LARGE"].includes(error.code)
        )
          throw error;
        resourceMessage = "桌面公共词卡暂不可用；保留原词条身份，请稍后重试。";
      }
    } else if (summary.resourceStatus !== "available")
      resourceMessage = "桌面词卡资源暂不可用。";
    const remaining = this.remaining(client, ticket, resolved.deadline, summaryDeadline);
    return {
      choices,
      selected,
      summary,
      entry,
      resourceMessage,
      refreshAfterMs: remaining,
    };
  }
  async dictionary(surface: string): Promise<Dictionary> {
    const card = await this.card(surface);
    // 未选择身份时不返回公开词卡，草稿仍可展示身份选择；不能随意采用第一条。
    const entry = card.entry;
    return entry
      ? {
          entryId: entry.entryId,
          word: entry.word,
          meaning: entry.translation,
          phonetic: entry.phonetic,
          possiblePos: entry.possiblePos,
          source: "leximeet-dictionary",
          version: entry.source.revision,
        }
      : null;
  }
  async prepareSelection(surface: string) {
    const ticket = this.ticket(),
      client = await this.connection.active();
    const resolved = await this.resolve(client, ticket, surface, true);
    return {
      word: resolved.selected,
      choices: resolved.choices,
      refreshAfterMs: this.remaining(client, ticket, resolved.deadline),
    };
  }
  async prepare(surface: string): Promise<WordRef> {
    const match = await this.prepareSelection(surface);
    if (!match.word) throw new Error("这个拼写对应多个词条，请先在侧栏选择要采集的词条");
    return match.word;
  }
  async notebooks(): Promise<NotebookRecord[]> {
    const ticket = this.ticket(),
      client = await this.connection.active();
    const deadline = Date.now() + this.remaining(client, ticket);
    if (!client.capabilities.includes("desktop.notebooks/1")) {
      this.remaining(client, ticket, deadline);
      return [];
    }
    const items: NotebookRecord[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null,
      revision: string | null = null;
    do {
      this.remaining(client, ticket, deadline);
      const page = await client.listNotebooks({ limit: 100, cursor });
      this.remaining(client, ticket, deadline);
      if (revision !== null && page.revision !== revision)
        throw new Error("桌面词本已变更，请重新读取");
      revision = page.revision;
      items.push(...page.items);
      if (page.complete) {
        const visible = items.filter((item) => item.deletedAt === null);
        this.remaining(client, ticket, deadline);
        return visible;
      }
      if (!page.nextCursor || cursors.has(page.nextCursor) || items.length > 10_000)
        throw new Error("桌面词本分页无效或超过读取预算");
      cursor = page.nextCursor;
      cursors.add(cursor);
    } while (true);
  }
  async capturePolicy(): Promise<CapturePolicy> {
    const ticket = this.ticket(),
      client = await this.connection.active();
    const workspace = await client.getWorkspace();
    this.remaining(client, ticket, Date.parse(workspace.readLeaseUntil));
    if (!validCapturePolicy(workspace.capturePolicy))
      throw new Error("桌面采集设置未完整返回，请重新读取");
    return workspace.capturePolicy;
  }
  async save(draft: Draft, notebookId: string | null, ticket: string) {
    if (!draft.desktopWord || draft.ownerTicket !== ticket)
      throw new Error("采集草稿不属于当前桌面连接，请重新采集");
    return this.connection.capture(
      {
        eventId: draft.eventId,
        mutationId: draft.eventId,
        data: {
          word: draft.desktopWord,
          surface: draft.surface,
          originalSentence: draft.originalSentence,
          savedExcerpt: draft.savedExcerpt,
          occurrenceRanges: draft.occurrenceRanges,
          excerptRanges: draft.excerptRanges,
          annotation: draft.annotation,
          source: {
            kind: "web",
            title: draft.source.title,
            url: draft.source.url,
          },
          collectionIntent: "collect",
        },
        notebookId,
      },
      ticket,
    );
  }
}
// 公共词卡只转换展示字段；私人释义、记分、词本始终由 Desktop 响应提供。
export function projectDesktopEntry(raw: CoreEntry): LexiconEntry {
  const senses = [...raw.senses].sort((a, b) => a.display_order - b.display_order);
  const translations = senses.map((s) => s.short_gloss).filter(Boolean);
  return {
    entryId: raw.entry_id,
    word: raw.headword,
    normalized: raw.lookup_key,
    translation:
      raw.headword_summary_zh ||
      [...new Set(translations)].join("；") ||
      raw.ecdict.zh_fallback ||
      "",
    definition: senses[0]?.english_gloss || raw.ecdict.en_fallback || "",
    phonetic:
      raw.pronunciations.find((p) => p.notation === "IPA")?.text ||
      raw.ecdict.legacy_phonetic ||
      "",
    possiblePos: [...new Set(senses.map((s) => s.pos).filter(Boolean))],
    tags: raw.ecdict.exam_tags.map((t) => t.code),
    senses,
    audio: null,
    raw,
    source: {
      id: "leximeet-dictionary",
      revision: "0.0.3",
      edition: "core-text",
      origin: raw.origin,
      releaseSha256: "",
    },
  };
}
