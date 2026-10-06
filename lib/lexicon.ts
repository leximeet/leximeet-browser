import { dictionaryCache, type DictionaryState } from "./dictionary-cache.ts";
import type { Dictionary } from "./types.ts";

export type CoreSense = {
  sense_id: string;
  display_order: number;
  pos: string;
  priority: string;
  short_gloss: string | null;
  learner_explanation_zh: string | null;
  english_gloss: string | null;
  usage_note_zh: string | null;
  examples: { text: string; translation: string | null; source: string }[];
  labels: { code: string; scope: "sense"; source: string }[];
  topics: { code: string; scope: "sense"; source: string }[];
  source_ref: Record<string, unknown>;
};

// 0.0.3 词条原样保留在只读 raw 中，个人资料不持有整张公共词卡。
export type CoreEntry = {
  schema_version: "leximeet.entry.v2";
  entry_id: string;
  headword: string;
  lookup_key: string;
  origin: "curated" | "ecdict-fallback";
  headword_summary_zh: string | null;
  memory_hook_zh: string | null;
  study_notes_zh: string[];
  forms: { text: string; tags: string[]; source: string }[];
  pronunciations: {
    notation: "IPA" | "ARPABET";
    text: string;
    region: string | null;
    pos: string | null;
    source: string;
  }[];
  senses: CoreSense[];
  ecdict: {
    zh_fallback: string | null;
    en_fallback: string | null;
    exam_tags: {
      code: string;
      scope: "entry";
      source: string;
      status: string;
    }[];
    frequency_ranks: Record<string, number>;
    legacy_phonetic: string | null;
  };
  editorial?: { display_zh: string | null; source: string };
  learning?: {
    schema_version: string;
    mnemonics: {
      content: string;
      kind: string;
      source: string;
      format?: "plain" | "markdown";
    }[];
    lexical: {
      phrases: unknown[];
      synonyms: unknown[];
      antonyms: unknown[];
      related_words: unknown[];
    };
    practice: { attested_examples: unknown[]; questions: unknown[] };
    collections: unknown[];
  };
};

export type CoreCatalog = {
  id: string;
  title: string;
  category: "exam" | "subject";
  source: string;
  method: string;
  count: number;
  previewWords: string[];
};
export type CatalogMember = {
  entryId: string;
  word: string;
  meaning: string;
  position: number;
  senseIds: string[];
  matchMethod: string;
  pos?: string;
  sourcePosition?: number;
};

export type AudioLocator = {
  entry_id: string;
  shard: string;
  offset: number;
  bytes: number;
  sha256: string;
  format: "audio/ogg";
  kind: "human" | "synthetic";
  style: "headword" | "spelled-characters";
  source_ref: string;
};

export type LexiconEntry = {
  entryId: string;
  word: string;
  normalized: string;
  translation: string;
  definition: string;
  phonetic: string;
  possiblePos: string[];
  tags: string[];
  senses: CoreSense[];
  audio: AudioLocator | null;
  raw: CoreEntry;
  source: {
    id: "leximeet-dictionary";
    revision: "0.0.3";
    edition: "lite-text" | "core-text";
    origin: CoreEntry["origin"];
    releaseSha256: string;
  };
};

// 内容提供者可替换；词条、遇见、复习只依赖个人资料 ID，不依赖词包行号。
export interface LexiconProvider {
  // 正文匹配只需要原词头；不应为了每个候选词解压完整释义分片。
  resolveHeadword(word: string): Promise<string | null>;
  lookup(word: string): Promise<LexiconEntry | null>;
  lookupAll(word: string): Promise<LexiconEntry[]>;
  suggest(prefix: string, limit?: number): Promise<LexiconEntry[]>;
  listCatalogs(): Promise<CoreCatalog[]>;
  catalogMembers(catalogId: string): Promise<CatalogMember[]>;
  allMembers?(): Promise<CatalogMember[]>;
  state?(): Promise<DictionaryState>;
}

type Asset = { file: string; entries?: number; bytes: number; sha256: string };
type CoreManifest = {
  schema: "leximeet.browser-text.v3";
  dictionaryVersion: "0.0.3";
  entrySchema: "leximeet.entry.v2";
  sourceEdition: "lite-text";
  sourceReleaseSha256: string;
  entryCount: number;
  audioCount: number;
  audioChunkBytes: number;
  sourcePackBytes: number;
  casefoldOverrides: Record<string, string>;
  entries: Record<string, Asset>;
  forms: Record<string, Asset>;
  audioIndex?: Record<string, Asset>;
  audioChunks?: Asset[];
  allMembers: Asset;
  catalogCount: number;
  catalogIndex: Asset;
  catalogMembers: Record<string, Asset>;
};
type FormRow = [
  lookupKey: string,
  formText: string,
  entryKey: string,
  headword: string,
  entryId: string,
];
const RELEASE_SHA256 = "8c9392ddf92c3bf3b0f471075b55c5042826a08129c4aa1efbbe9cd922926317";

function shardKey(value: string): string {
  return [...value]
    .slice(0, 2)
    .map((char) => (/^[a-z]$/.test(char) ? char : "_"))
    .join("")
    .padEnd(2, "_");
}
function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function headwordMeaning(entry: CoreEntry): string {
  const ordered = [...entry.senses].sort((a, b) => a.display_order - b.display_order);
  const core = ordered.filter((sense) => sense.priority === "lite-text");
  const brief = [
    ...new Set(
      (core.length ? core : ordered).map((sense) => sense.short_gloss).filter(Boolean),
    ),
  ]
    .slice(0, 2)
    .join("；");
  return (
    entry.editorial?.display_zh ||
    brief ||
    entry.headword_summary_zh ||
    ordered[0]?.learner_explanation_zh ||
    entry.ecdict.zh_fallback ||
    ""
  );
}

// 只读 Lite Text 按需解压；Core 的已核验增量由独立缓存提供。
export class CoreLexiconProvider implements LexiconProvider {
  private manifestPromise?: Promise<CoreManifest>;
  private readonly cache = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    baseUrl: string,
    fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
  }

  private async manifest(): Promise<CoreManifest> {
    this.manifestPromise ??= (async () => {
      const response = await this.fetcher(`${this.baseUrl}dictionary-manifest.json`);
      if (!response.ok) throw new Error("内置核心词包清单不可读取");
      const manifest = (await response.json()) as CoreManifest;
      if (
        manifest.schema !== "leximeet.browser-text.v3" ||
        manifest.dictionaryVersion !== "0.0.3" ||
        manifest.entrySchema !== "leximeet.entry.v2" ||
        manifest.sourceEdition !== "lite-text" ||
        manifest.sourceReleaseSha256 !== RELEASE_SHA256 ||
        manifest.entryCount !== 26417 ||
        manifest.audioCount !== 0 ||
        manifest.catalogCount !== 23
      )
        throw new Error("内置核心词包版本或来源不受支持");
      return manifest;
    })().catch((error) => {
      this.manifestPromise = undefined;
      throw error;
    });
    return this.manifestPromise;
  }

  private async bytes(asset: Asset): Promise<ArrayBuffer> {
    if (
      !/^(?:(?:entries|forms)\/[a-z_]{2}|audio-index\/[0-9a-f]{2})\.jsonl\.gz$|^audio\/\d{4}\.bin$|^catalogs\/(?:index\.json|(?:\d{2}|all)\.json\.gz)$/.test(
        asset.file,
      )
    )
      throw new Error("核心词包资产路径无效");
    const response = await this.fetcher(`${this.baseUrl}${asset.file}`);
    if (!response.ok) throw new Error(`核心词包资产不可读取：${asset.file}`);
    const bytes = await response.arrayBuffer();
    if (
      bytes.byteLength !== asset.bytes ||
      hex(await crypto.subtle.digest("SHA-256", bytes)) !== asset.sha256
    )
      throw new Error(`核心词包资产校验失败：${asset.file}`);
    return bytes;
  }

  private async lines(asset: Asset): Promise<string[]> {
    const compressed = await this.bytes(asset);
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const content = await new Response(stream).text();
    const rows = content.trimEnd().split("\n");
    if (rows.length !== asset.entries)
      throw new Error(`核心词包分片条数不符：${asset.file}`);
    return rows;
  }

  private async cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    if (this.cache.has(key)) {
      const value = this.cache.get(key) as T;
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    if (!this.inFlight.has(key))
      this.inFlight.set(
        key,
        read()
          .then((value) => {
            this.cache.set(key, value);
            while (this.cache.size > 12)
              this.cache.delete(this.cache.keys().next().value!);
            return value;
          })
          .finally(() => this.inFlight.delete(key)),
      );
    return this.inFlight.get(key) as Promise<T>;
  }

  private async lookupKey(word: string): Promise<string> {
    const overrides = (await this.manifest()).casefoldOverrides;
    return this.foldKey(word, overrides);
  }

  private foldKey(word: string, overrides: Record<string, string>): string {
    return [...word.normalize("NFC")]
      .map((char) => overrides[char] || char.toLocaleLowerCase("en"))
      .join("");
  }

  private liteHeadIndex?: Promise<Map<string, string[]>>;
  // Lite 固定发布包的词头键已经过核验；Core 只使用正式 lookup 索引，不重造其键。
  private async headIndex(): Promise<Map<string, string[]>> {
    return (this.liteHeadIndex ??= (async () => {
      const overrides = (await this.manifest()).casefoldOverrides;
      const result = new Map<string, string[]>();
      for (const member of await this.liteMembers()) {
        const key = this.foldKey(member.word, overrides);
        const group = result.get(key) || [];
        group.push(member.word);
        result.set(key, group);
      }
      return result;
    })().catch((error) => {
      this.liteHeadIndex = undefined;
      throw error;
    }));
  }

  async resolveHeadword(word: string): Promise<string | null> {
    if (!word || word.length > 120) return null;
    const key = await this.lookupKey(word);
    // Core 增量沿用正式索引的优先顺序，只读词头元数据，不解析词卡 entryJson。
    const extra = await dictionaryCache.headwords(key);
    if (extra.length) return extra[0]!;
    const direct = (await this.headIndex()).get(key);
    if (direct?.length) return direct.find((headword) => headword === word) || direct[0]!;
    const forms = (await this.formsFor(key))
      .filter((row) => row[0] === key)
      .sort((a, b) => Number(b[1] === word) - Number(a[1] === word));
    return forms[0]?.[3] || null;
  }

  private async entriesFor(key: string): Promise<CoreEntry[]> {
    const asset = (await this.manifest()).entries[shardKey(key)];
    if (!asset) return [];
    return this.cached(`entry:${asset.file}`, async () =>
      (await this.lines(asset)).map((line) => {
        const entry = JSON.parse(line) as CoreEntry;
        if (
          entry.schema_version !== "leximeet.entry.v2" ||
          !entry.entry_id ||
          !entry.lookup_key
        )
          throw new Error("核心词条格式无效");
        return entry;
      }),
    );
  }

  private async formsFor(key: string): Promise<FormRow[]> {
    const asset = (await this.manifest()).forms[shardKey(key)];
    return asset
      ? this.cached(`form:${asset.file}`, async () =>
          (await this.lines(asset)).map((line) => JSON.parse(line) as FormRow),
        )
      : [];
  }

  private async project(entry: CoreEntry): Promise<LexiconEntry> {
    const ordered = [...entry.senses].sort((a, b) => a.display_order - b.display_order);
    const ipa = entry.pronunciations.find((item) => item.notation === "IPA")?.text || "";
    const source = await this.manifest();
    return {
      entryId: entry.entry_id,
      word: entry.headword,
      normalized: entry.lookup_key,
      translation: headwordMeaning(entry),
      definition: ordered[0]?.english_gloss || entry.ecdict.en_fallback || "",
      phonetic: ipa,
      possiblePos: [...new Set(ordered.map((item) => item.pos).filter(Boolean))],
      tags: entry.ecdict.exam_tags.map((item) => item.code),
      senses: ordered,
      audio: null,
      raw: entry,
      source: {
        id: "leximeet-dictionary",
        revision: "0.0.3",
        edition: (await dictionaryCache.state()).active,
        origin: entry.origin,
        releaseSha256: source.sourceReleaseSha256,
      },
    };
  }

  async lookupAll(word: string): Promise<LexiconEntry[]> {
    if (!word || word.length > 120) return [];
    const key = await this.lookupKey(word);
    const supplement = await dictionaryCache.lookup(key);
    if (supplement.length) return Promise.all(supplement.map((e) => this.project(e)));
    const direct = (await this.entriesFor(key)).filter(
      (entry) => entry.lookup_key === key,
    );
    if (direct.length)
      return Promise.all(
        direct
          .sort((a, b) => Number(b.headword === word) - Number(a.headword === word))
          .map((entry) => this.project(entry)),
      );
    const forms = (await this.formsFor(key))
      .filter((row) => row[0] === key)
      .sort((a, b) => Number(b[1] === word) - Number(a[1] === word));
    const found: CoreEntry[] = [];
    const ids = new Set<string>();
    for (const [, , entryKey, , entryId] of forms) {
      if (ids.has(entryId)) continue;
      const entry = (await this.entriesFor(entryKey)).find(
        (item) => item.entry_id === entryId,
      );
      if (entry) {
        found.push(entry);
        ids.add(entryId);
      }
    }
    return Promise.all(found.map((entry) => this.project(entry)));
  }

  async lookup(word: string): Promise<LexiconEntry | null> {
    return (await this.lookupAll(word))[0] || null;
  }

  async suggest(prefix: string, limit = 20): Promise<LexiconEntry[]> {
    if (prefix.length < 2 || prefix.length > 120) return [];
    const key = await this.lookupKey(prefix);
    const matched = (await this.entriesFor(key)).filter((entry) =>
      entry.lookup_key.startsWith(key),
    );
    return Promise.all(
      matched
        .slice(0, Math.min(50, Math.max(1, limit)))
        .map((entry) => this.project(entry)),
    );
  }

  // 目录与成员按需读取；调用方不得把只读资源自动写入个人词库。
  async listCatalogs(): Promise<CoreCatalog[]> {
    const manifest = await this.manifest();
    return this.cached("catalog:index", async () => {
      const rows = JSON.parse(
        new TextDecoder().decode(await this.bytes(manifest.catalogIndex)),
      ) as CoreCatalog[];
      if (
        rows.length !== manifest.catalogCount ||
        new Set(rows.map((row) => row.id)).size !== rows.length ||
        rows.some(
          (row) =>
            !["exam", "subject"].includes(row.category) ||
            !row.title ||
            !Array.isArray(row.previewWords) ||
            row.previewWords.length > 3 ||
            row.previewWords.some((word) => typeof word !== "string" || !word),
        )
      )
        throw new Error("学习目录索引无效");
      return rows;
    });
  }

  async catalogMembers(catalogId: string): Promise<CatalogMember[]> {
    const manifest = await this.manifest();
    const asset = manifest.catalogMembers[catalogId];
    if (
      !asset ||
      !(await this.listCatalogs()).some((catalog) => catalog.id === catalogId)
    )
      throw new Error("学习目录不存在");
    return this.cached(`catalog:${catalogId}`, async () => {
      const data = await this.bytes(asset);
      const plain = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
      const members = JSON.parse(await new Response(plain).text()) as CatalogMember[];
      if (
        members.length !== asset.entries ||
        members.some(
          (member, index) =>
            !member.entryId || !member.word || member.position !== index + 1,
        )
      )
        throw new Error("学习目录成员无效");
      return members;
    });
  }

  async state(): Promise<DictionaryState> {
    return dictionaryCache.state();
  }
  private memberCache: Partial<
    Record<"lite-text" | "core-text", Promise<CatalogMember[]>>
  > = {};
  private liteMemberPromise?: Promise<CatalogMember[]>;
  private liteMembers(): Promise<CatalogMember[]> {
    return (this.liteMemberPromise ??= (async () => {
      const manifest = await this.manifest();
      const lite = JSON.parse(
        await new Response(
          new Blob([await this.bytes(manifest.allMembers)])
            .stream()
            .pipeThrough(new DecompressionStream("gzip")),
        ).text(),
      ) as CatalogMember[];
      if (lite.length !== 26417 || new Set(lite.map((m) => m.entryId)).size !== 26417)
        throw new Error("内置词典成员不完整");
      return lite;
    })().catch((error) => {
      this.liteMemberPromise = undefined;
      throw error;
    }));
  }
  async allMembers(): Promise<CatalogMember[]> {
    const active = (await dictionaryCache.state()).active;
    return (this.memberCache[active] ??= (async () => {
      const lite = await this.liteMembers();
      const extra = active === "core-text" ? await dictionaryCache.heads() : [];
      return [...lite, ...extra].map((row, index) => ({
        ...row,
        position: index + 1,
      }));
    })().catch((e) => {
      delete this.memberCache[active];
      throw e;
    }));
  }
}

export function publicDictionary(entry: LexiconEntry | null): Dictionary {
  return entry
    ? {
        word: entry.word,
        entryId: entry.entryId,
        meaning: entry.translation || entry.definition,
        phonetic: entry.phonetic,
        possiblePos: entry.possiblePos,
        source: "leximeet-dictionary",
        version: entry.source.revision,
      }
    : null;
}
