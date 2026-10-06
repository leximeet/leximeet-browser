import { Decompress } from "fzstd";
import type { CoreEntry } from "./lexicon.ts";
import { CORE_DELTA, DictionaryCache, dictionaryCache } from "./dictionary-cache.ts";
export type InstallProgress = {
  phase: "checking" | "installing" | "complete";
  count: number;
  total: number;
};
// 先验证原始压缩资产，再流式解码、分批建索引，最后在单个事务切换指针。
export async function installCoreText(
  file: Blob,
  liteIds: Set<string>,
  progress: (p: InstallProgress) => void = () => {},
  cache: DictionaryCache = dictionaryCache,
) {
  if (file.size !== CORE_DELTA.bytes)
    throw new Error("请选择 0.0.3 的 entries-core-delta.jsonl.zst（50,843,911 字节）");
  progress({ phase: "checking", count: 0, total: CORE_DELTA.count });
  const compressed = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", compressed);
  const hash = [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== CORE_DELTA.sha256)
    throw new Error("增量包哈希不符，原生效词典与个人资料未修改");
  let text = "",
    batch: CoreEntry[] = [],
    rawLines: string[] = [],
    batchCharacters = 0,
    count = 0;
  const ids = new Set<string>(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  const unzip = new Decompress((b, last) => {
    text += decoder.decode(b, { stream: !last });
  });
  async function drain(final = false) {
    let index;
    while ((index = text.indexOf("\n")) >= 0 || (final && text.length)) {
      const line = index >= 0 ? text.slice(0, index) : text;
      text = index >= 0 ? text.slice(index + 1) : "";
      if (!line.trim()) continue;
      const e = JSON.parse(line) as CoreEntry;
      if (
        e.schema_version !== "leximeet.entry.v2" ||
        !e.entry_id ||
        !e.lookup_key ||
        !e.headword ||
        !Array.isArray(e.senses) ||
        !Array.isArray(e.forms) ||
        !e.ecdict ||
        ids.has(e.entry_id) ||
        liteIds.has(e.entry_id)
      )
        throw new Error("增量词条格式或身份重复，未切换词典");
      ids.add(e.entry_id);
      batch.push(e);
      rawLines.push(line);
      batchCharacters += line.length;
      count++;
      // 合并小事务，同时限制每批文本约 8 MiB；较大词卡不会无限积累。
      if (batch.length >= 1000 || batchCharacters >= 4 * 1024 * 1024) {
        await cache.stage(batch, rawLines);
        batch = [];
        rawLines = [];
        batchCharacters = 0;
        progress({ phase: "installing", count, total: CORE_DELTA.count });
      }
    }
  }
  for (let i = 0; i < compressed.length; i += 65536) {
    unzip.push(compressed.subarray(i, i + 65536));
    await drain();
  }
  unzip.push(new Uint8Array(), true);
  await drain(true);
  if (batch.length) await cache.stage(batch, rawLines);
  if (count !== CORE_DELTA.count) throw new Error("增量数量不符，未切换词典");
  await cache.finish();
  progress({ phase: "complete", count, total: count });
}
