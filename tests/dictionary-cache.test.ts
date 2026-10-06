import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { DictionaryCache, CORE_PACKAGE, idbRequest } from "../lib/dictionary-cache.ts";
import type { CoreEntry } from "../lib/lexicon.ts";

async function sampleEntry() {
  // 使用正式 v2 样例，并补充未来字段，验证缓存不会丢掉词卡的嵌套信息。
  const text = gunzipSync(
    await readFile("public/dictionaries/core/entries/re.jsonl.gz"),
  ).toString("utf8");
  const entry = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((e) => e.lookup_key === "resilient") as CoreEntry & {
    future_field: unknown;
  };
  assert.ok(entry);
  entry.future_field = {
    text: "中文与 emoji 🌿\n第二行",
    nested: [null, { number: 0, flag: false }],
  };
  entry.forms.push({
    text: "resilient-cache-form",
    tags: ["fixture"],
    source: "test:cache",
  });
  return entry;
}

test("公共词卡原始 JSON 完整保留 v2 字段、词形和重开后的身份，损坏记录拒绝", async () => {
  const name = "cache-current-" + crypto.randomUUID(),
    entry = await sampleEntry();
  let cache = new DictionaryCache(name);
  await cache.stage([entry], [JSON.stringify(entry)]);
  // 这里只使用 Node 的 fake-indexeddb 验证格式；正式数量和原生事务由浏览器套件验证。
  await cache.finish(1);
  assert.deepEqual(await cache.lookup("resilient"), [entry]);
  assert.deepEqual(await cache.lookup("resilient-cache-form"), [entry]);
  assert.deepEqual(await cache.headwords("resilient"), ["resilient"]);
  assert.deepEqual(await cache.headwords("resilient-cache-form"), ["resilient"]);
  await cache.close();
  cache = new DictionaryCache(name);
  assert.deepEqual(await cache.lookup("resilient"), [entry]);
  await cache.close();

  // 独立测试库破坏当前记录，验证不会把缺失原始JSON的资料猜成有效词卡。
  const db = await idbRequest(indexedDB.open(name, 1));
  const tx = db.transaction("entries", "readwrite");
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  tx.objectStore("entries").put({
    packageId: CORE_PACKAGE,
    entry_id: entry.entry_id,
    lookup_key: entry.lookup_key,
    headword: entry.headword,
  });
  await done;
  db.close();
  cache = new DictionaryCache(name);
  await assert.rejects(cache.lookup("resilient"), /缓存格式无效/);
  await assert.rejects(cache.lookup("resilient-cache-form"), /缓存格式无效/);
  assert.equal((await cache.state()).active, "core-text");
  await cache.close();
});

test("批量显式提交遇到异步写入错误时，词卡、词形与列表整体回滚", async () => {
  const name = "cache-atomic-" + crypto.randomUUID(),
    entry = await sampleEntry(),
    opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore("meta");
    const entries = db.createObjectStore("entries", {
      keyPath: ["packageId", "entry_id"],
    });
    entries.createIndex("lookup", ["packageId", "lookup_key"]);
    // 此独立测试库的额外约束只用于产生异步写入失败，不改正式缓存的索引合同。
    entries.createIndex("failSameHeadword", "headword", { unique: true });
    const forms = db.createObjectStore("forms", {
      keyPath: ["packageId", "key", "entryId", "text"],
    });
    forms.createIndex("lookup", ["packageId", "key"]);
    const heads = db.createObjectStore("heads", {
      keyPath: ["packageId", "entryId"],
    });
    heads.createIndex("package", "packageId");
  };
  const db = await idbRequest(opening),
    cache = new DictionaryCache(name);
  try {
    await assert.rejects(
      cache.stage([entry, { ...entry, entry_id: crypto.randomUUID() }]),
      { name: "Error", message: "词典缓存事务失败，原生效词典保留" },
    );
    const tx = db.transaction(["entries", "forms", "heads", "meta"]);
    const counts = await Promise.all(
      ["entries", "forms", "heads", "meta"].map((store) =>
        idbRequest(tx.objectStore(store).count()),
      ),
    );
    assert.deepEqual(counts, [0, 0, 0, 0]);
    assert.equal((await cache.state()).coreInstalled, false);
  } finally {
    await cache.close();
    db.close();
  }
});

test("轻量 Core 匹配依赖正式 lookup_key，不能根据显示词头重造匹配键", async () => {
  const cache = new DictionaryCache("cache-head-identity-" + crypto.randomUUID());
  const entry = {
    ...(await sampleEntry()),
    headword: "witneßes",
    lookup_key: "witnesses",
    forms: [],
  };
  try {
    await cache.stage([entry]);
    await cache.finish(1);
    assert.deepEqual(await cache.headwords("witnesses"), ["witneßes"]);
    assert.deepEqual(await cache.headwords("witneßes"), []);
    assert.deepEqual(
      (await cache.lookup("witnesses")).map((row) => row.headword),
      ["witneßes"],
    );
  } finally {
    await cache.close();
  }
});
