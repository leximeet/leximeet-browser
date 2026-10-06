import type { CoreEntry, CatalogMember } from "./lexicon.ts";

export const TEXT_RELEASE_HASH =
  "8c9392ddf92c3bf3b0f471075b55c5042826a08129c4aa1efbbe9cd922926317";
export const CORE_DELTA = {
  file: "entries-core-delta.jsonl.zst",
  bytes: 50843911,
  sha256: "274efc2428571b4a770c770e2f2fe4844e4ce75259d89ecbfc5b19b135c8047a",
  count: 91485,
};
export const CORE_PACKAGE = `0.0.3/core-text/${TEXT_RELEASE_HASH}`;
export type TextEdition = "lite-text" | "core-text";
export type DictionaryState = {
  active: TextEdition;
  coreInstalled: boolean;
  version: "0.0.3";
  releaseHash: string;
};
type Form = { packageId: string; key: string; entryId: string; text: string };
type CachedEntry = {
  packageId: string;
  entry_id: string;
  lookup_key: string;
  headword: string;
  entryJson: string;
};
// 复杂词卡按原始 JSON 存储；只读取当前格式，损坏公共缓存可重新安装文字包。
function unpackEntry(row: CachedEntry): CoreEntry {
  if (typeof row.entryJson !== "string")
    throw new Error("词典缓存格式无效，请重新安装文字包");
  return JSON.parse(row.entryJson) as CoreEntry;
}

export const idbRequest = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error || new Error("词典缓存事务失败，原生效词典保留"));
  });
// 公共缓存与个人资料完全分库。仅 ready 包可成为 active，半包绝不会用于查词。
export class DictionaryCache {
  private opening?: Promise<IDBDatabase>;
  private readonly name: string;
  constructor(name = "leximeet-text-cache-v1") {
    this.name = name;
  }
  private db(): Promise<IDBDatabase> {
    return (this.opening ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("meta");
        const entries = d.createObjectStore("entries", {
          keyPath: ["packageId", "entry_id"],
        });
        entries.createIndex("lookup", ["packageId", "lookup_key"]);
        const forms = d.createObjectStore("forms", {
          keyPath: ["packageId", "key", "entryId", "text"],
        });
        forms.createIndex("lookup", ["packageId", "key"]);
        const heads = d.createObjectStore("heads", {
          keyPath: ["packageId", "entryId"],
        });
        heads.createIndex("package", "packageId");
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => {
          r.result.close();
          this.opening = undefined;
        };
        resolve(r.result);
      };
      r.onerror = () => {
        this.opening = undefined;
        reject(r.error);
      };
      r.onblocked = () => reject(new Error("词典缓存正被其他窗口升级"));
    }));
  }
  async state(): Promise<DictionaryState> {
    const d = await this.db(),
      s = d.transaction("meta").objectStore("meta");
    const [active, ready] = await Promise.all([
      idbRequest(s.get("active")),
      idbRequest(s.get(`ready:${CORE_PACKAGE}`)),
    ]);
    return {
      active: active === "core-text" && ready === 117902 ? "core-text" : "lite-text",
      coreInstalled: ready === 117902,
      version: "0.0.3",
      releaseHash: TEXT_RELEASE_HASH,
    };
  }
  async activate(edition: TextEdition): Promise<void> {
    if (!["lite-text", "core-text"].includes(edition))
      throw new Error("浏览器只支持 Lite Text 和 Core Text");
    const d = await this.db(),
      tx = d.transaction("meta", "readwrite"),
      done = transactionDone(tx),
      s = tx.objectStore("meta");
    if (edition === "core-text") {
      const r = s.get(`ready:${CORE_PACKAGE}`);
      r.onsuccess = () => {
        if (r.result !== 117902) tx.abort();
        else s.put(edition, "active");
      };
    } else s.put(edition, "active");
    await done;
  }
  async lookup(key: string): Promise<CoreEntry[]> {
    if ((await this.state()).active !== "core-text") return [];
    const d = await this.db();
    const direct = await idbRequest(
      d
        .transaction("entries")
        .objectStore("entries")
        .index("lookup")
        .getAll([CORE_PACKAGE, key]),
    );
    if (direct.length) return direct.map(unpackEntry);
    const forms = await idbRequest<Form[]>(
      d
        .transaction("forms")
        .objectStore("forms")
        .index("lookup")
        .getAll([CORE_PACKAGE, key]),
    );
    const ids = [...new Set(forms.map((f) => f.entryId))];
    const store = d.transaction("entries").objectStore("entries");
    return (
      await Promise.all(
        ids.map((id) =>
          idbRequest<CachedEntry | undefined>(store.get([CORE_PACKAGE, id])),
        ),
      )
    )
      .filter((x): x is CachedEntry => !!x)
      .map(unpackEntry);
  }
  // 正文批量匹配不复制或解析整张 Core 词卡，只通过索引取轻量词头记录。
  async headwords(key: string): Promise<string[]> {
    if ((await this.state()).active !== "core-text") return [];
    const d = await this.db();
    const keys = await idbRequest(
      d
        .transaction("entries")
        .objectStore("entries")
        .index("lookup")
        .getAllKeys([CORE_PACKAGE, key]),
    );
    let ids: string[];
    if (keys.length) {
      ids = keys.map((value) => {
        if (!Array.isArray(value) || typeof value[1] !== "string")
          throw new Error("词典词头索引身份无效");
        return value[1];
      });
    } else {
      const forms = await idbRequest<Form[]>(
        d
          .transaction("forms")
          .objectStore("forms")
          .index("lookup")
          .getAll([CORE_PACKAGE, key]),
      );
      ids = [...new Set(forms.map((form) => form.entryId))];
    }
    if (!ids.length) return [];
    const heads = d.transaction("heads").objectStore("heads");
    const rows = await Promise.all(
      ids.map((id) =>
        idbRequest<CatalogMember | undefined>(heads.get([CORE_PACKAGE, id])),
      ),
    );
    if (rows.some((row) => !row?.word)) throw new Error("词典词头索引缺失");
    return rows.map((row) => row!.word);
  }
  async heads(): Promise<CatalogMember[]> {
    if ((await this.state()).active !== "core-text") return [];
    const d = await this.db();
    return idbRequest(
      d.transaction("heads").objectStore("heads").index("package").getAll(CORE_PACKAGE),
    );
  }
  // 每批原子落盘但仍不可见；重复导入同一正式增量以稳定 ID 幂等覆盖。
  async stage(entries: CoreEntry[], rawLines?: string[]): Promise<void> {
    const d = await this.db(),
      tx = d.transaction(["entries", "forms", "heads"], "readwrite"),
      done = transactionDone(tx);
    const entryStore = tx.objectStore("entries"),
      headStore = tx.objectStore("heads"),
      formStore = tx.objectStore("forms");
    for (const [index, e] of entries.entries()) {
      entryStore.put({
        packageId: CORE_PACKAGE,
        entry_id: e.entry_id,
        lookup_key: e.lookup_key,
        headword: e.headword,
        // 安装器提供已经校验/解析的原文；其他内部调用同样保留全部 JSON 字段。
        entryJson: rawLines?.[index] ?? JSON.stringify(e),
      });
      const ordered = [...e.senses].sort((a, b) => a.display_order - b.display_order);
      const primary = ordered.filter((s) => s.priority === "core");
      headStore.put({
        packageId: CORE_PACKAGE,
        entryId: e.entry_id,
        word: e.headword,
        meaning:
          [
            ...new Set(
              (primary.length ? primary : ordered)
                .map((s) => s.short_gloss)
                .filter(Boolean),
            ),
          ]
            .slice(0, 2)
            .join("；") ||
          e.ecdict.zh_fallback ||
          "",
        position: 0,
        senseIds: [],
        matchMethod: "dictionary",
        pos: ordered[0]?.pos || "",
      });
      const seenForms = new Set<string>();
      for (const f of e.forms) {
        const key = f.text.normalize("NFC").toLowerCase();
        // 主词已经在 entries.lookup 索引中；仅给额外词形建倒排，避免重复写入三个索引。
        // 原始 forms 仍完整保留在 entryJson 中，词卡展示及未来字段不会丢失。
        if (key === e.lookup_key || seenForms.has(f.text)) continue;
        seenForms.add(f.text);
        formStore.put({
          packageId: CORE_PACKAGE,
          key,
          entryId: e.entry_id,
          text: f.text,
        });
      }
    }
    // 本批请求已全部入队，直接开始提交，避免等数千个 success 事件派发后才自动提交。
    // 仍等待完整事务完成；任一写入失败会整批回滚，不提前公布进度或 ready。
    tx.commit();
    await done;
  }
  async finish(expected = 91485): Promise<void> {
    const d = await this.db();
    const count = await idbRequest(
      d.transaction("heads").objectStore("heads").index("package").count(CORE_PACKAGE),
    );
    if (count !== expected) throw new Error("Core 增量词条数不符，未切换词典");
    const tx = d.transaction("meta", "readwrite"),
      done = transactionDone(tx);
    tx.objectStore("meta").put(117902, `ready:${CORE_PACKAGE}`);
    tx.objectStore("meta").put("core-text", "active");
    await done;
  }
  async close() {
    (await this.opening)?.close();
    this.opening = undefined;
  }
}
export const dictionaryCache = new DictionaryCache();
