#!/usr/bin/env node
// 构建期把固定 Lite Text 分成 gzip 小片。保留全部词条字段与原始来源，不附带录音。
import { createReadStream } from "node:fs";
import {
  readFile,
  writeFile,
  appendFile,
  mkdir,
  readdir,
  rename,
  rm,
  mkdtemp,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { resolve, join } from "node:path";
import { Decompress } from "fzstd";
const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(join(root, "dictionary-text.lock.json")));
let source = resolve(
  process.env.LEXIMEET_DICTIONARY_RELEASE_DIR ||
    join(root, "../../leximeet-dictionary/dist/v0.0.3"),
);
const output = join(root, "public/dictionaries/core");
// 词典数据清单使用独立文件名，避免商店将它识别成第二个扩展安装清单。
const manifestName = "dictionary-manifest.json";
const generatorRevision = 2;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asset = (name, bytes, count) => ({
  file: name,
  bytes: bytes.length,
  sha256: sha(bytes),
  ...(count === undefined ? {} : { entries: count }),
});
try {
  await readFile(join(source, "release.json"));
} catch {
  source = await (await import("./fetch-dictionary.mjs")).fetchDictionary();
}
const releaseBytes = await readFile(join(source, "release.json")).catch(() => {
  throw new Error(
    "请先取得 Dictionary v0.0.3 的 lite-text 发布资产，并用 LEXIMEET_DICTIONARY_RELEASE_DIR 指向解压目录；详见 docs/开发指南.md。",
  );
});
if (sha(releaseBytes) !== lock.releaseSha256)
  throw new Error("release.json 与锁定的 0.0.3 正式发布清单不符");
const release = JSON.parse(releaseBytes);
if (
  release.schema_version !== "leximeet.release.v3" ||
  release.editions["lite-text"].entry_count !== lock.entryCount
)
  throw new Error("文字包合同不符");
try {
  const manifest = JSON.parse(await readFile(join(output, manifestName)));
  const assets = [
    ...Object.values(manifest.entries),
    ...Object.values(manifest.forms),
    ...Object.values(manifest.catalogMembers),
    manifest.catalogIndex,
    manifest.allMembers,
    ...manifest.notices,
  ];
  if (
    manifest.schema === "leximeet.browser-text.v3" &&
    manifest.generatorRevision === generatorRevision &&
    !(await readdir(output)).includes("manifest.json") &&
    manifest.sourceReleaseSha256 === lock.releaseSha256 &&
    (await Promise.all(
      assets.map(async (a) => sha(await readFile(join(output, a.file))) === a.sha256),
    ).then((x) => x.every(Boolean)))
  ) {
    console.log(
      `Lite Text 已校验：${manifest.entryCount} 词 / ${manifest.catalogCount} 主题`,
    );
    process.exit(0);
  }
} catch {}
await mkdir(join(root, "public/dictionaries"), { recursive: true });
const stage = await mkdtemp(join(root, "public/dictionaries/.text-stage-"));
const key = (s) => s.normalize("NFC").toLowerCase();
const shard = (s) =>
  [...s]
    .slice(0, 2)
    .map((c) => (/^[a-z]$/.test(c) ? c : "_"))
    .join("")
    .padEnd(2, "_");
const concise = (senses) => {
  const s = [...senses].sort((a, b) => a.display_order - b.display_order);
  return [
    ...new Set(
      (s.filter((s) => s.priority === "core").length
        ? s.filter((s) => s.priority === "core")
        : s
      )
        .map((s) => s.short_gloss)
        .filter(Boolean),
    ),
  ]
    .slice(0, 2)
    .join("；");
};
const catalogData = JSON.parse(await readFile(join(source, "catalogs.json")));
const groups = new Map(catalogData.catalogs.map((c) => [c.catalog_id, []]));
const ids = new Set(),
  heads = [],
  overrides = {},
  counters = { entries: new Map(), forms: new Map() };
const buffers = new Map();
function add(kind, s, line) {
  const name = `${kind}/${shard(s)}.jsonl`;
  if (!buffers.has(name)) buffers.set(name, []);
  buffers.get(name).push(line);
  counters[kind].set(shard(s), (counters[kind].get(shard(s)) || 0) + 1);
}
async function flush() {
  for (const [name, lines] of buffers)
    await appendFile(join(stage, name), lines.join("\n") + "\n");
  buffers.clear();
}
async function* lines(file) {
  let text = "",
    final = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const unzip = new Decompress((chunk, last) => {
    text += decoder.decode(chunk, { stream: !last });
    final = last;
  });
  for await (const b of createReadStream(file, { highWaterMark: 65536 })) {
    unzip.push(b);
    let i;
    while ((i = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, i);
      text = text.slice(i + 1);
      if (line) yield line;
    }
  }
  unzip.push(new Uint8Array(), true);
  if (text.trim()) yield text;
  if (!final) throw new Error("文字包解压未完成");
}
try {
  for (const name of release.editions["lite-text"].assets) {
    const b = await readFile(join(source, name));
    const a = release.assets[name];
    if (!a || b.length !== a.bytes || sha(b) !== a.sha256)
      throw new Error(`发布资产校验失败：${name}`);
  }
  for (const folder of ["entries", "forms", "catalogs"]) await mkdir(join(stage, folder));
  for await (const line of lines(join(source, "entries-lite.jsonl.zst"))) {
    const e = JSON.parse(line);
    if (e.schema_version !== "leximeet.entry.v2" || ids.has(e.entry_id) || !e.lookup_key)
      throw new Error("词条格式或身份不符");
    ids.add(e.entry_id);
    for (const c of e.headword)
      if (c.toLowerCase() !== e.lookup_key && c === "ß") overrides[c] = "ss";
    add("entries", e.lookup_key, line);
    for (const f of new Map((e.forms || []).map((f) => [f.text, f])).values())
      add(
        "forms",
        key(f.text),
        JSON.stringify([key(f.text), f.text, e.lookup_key, e.headword, e.entry_id]),
      );
    const summary =
      concise(e.senses) || e.ecdict?.zh_fallback || e.headword_summary_zh || "";
    const member = {
      entryId: e.entry_id,
      word: e.headword,
      meaning: summary,
      position: heads.length + 1,
      senseIds: [],
      matchMethod: "dictionary",
      pos: e.senses?.find((s) => s.priority === "core")?.pos || e.senses?.[0]?.pos || "",
    };
    heads.push(member);
    for (const c of e.learning?.collections || []) {
      if (!groups.has(c.catalog_id)) throw new Error("未声明的主题目录");
      const senses = e.senses.filter((s) => c.sense_ids?.includes(s.sense_id));
      groups.get(c.catalog_id).push({
        ...member,
        meaning: concise(senses) || summary,
        position: c.position,
        senseIds: c.sense_ids,
        matchMethod: c.match_method,
      });
    }
    if (heads.length % 500 === 0) await flush();
  }
  await flush();
  if (heads.length !== lock.entryCount) throw new Error("Lite 词条数不符");
  const sections = {};
  for (const kind of ["entries", "forms"]) {
    sections[kind] = {};
    for (const name of (await readdir(join(stage, kind))).sort()) {
      const bytes = gzipSync(await readFile(join(stage, kind, name)), {
        level: 6,
      });
      const path = `${kind}/${name}.gz`;
      await writeFile(join(stage, path), bytes);
      await rm(join(stage, kind, name));
      sections[kind][name.slice(0, 2)] = asset(
        path,
        bytes,
        counters[kind].get(name.slice(0, 2)),
      );
    }
  }
  const catalogIndex = [],
    catalogMembers = {};
  for (const [i, c] of catalogData.catalogs.entries()) {
    const members = groups.get(c.catalog_id).sort((a, b) => a.position - b.position);
    if (
      members.length !== c.entry_count ||
      new Set(members.map((m) => m.entryId)).size !== members.length
    )
      throw new Error(`主题成员不完整：${c.catalog_id}`);
    members.forEach((m, i) => {
      m.sourcePosition = m.position;
      m.position = i + 1;
    });
    const name = `catalogs/${String(i).padStart(2, "0")}.json.gz`;
    const bytes = gzipSync(JSON.stringify(members));
    await writeFile(join(stage, name), bytes);
    catalogMembers[c.catalog_id] = asset(name, bytes, members.length);
    catalogIndex.push({
      id: c.catalog_id,
      title: c.title_zh,
      category: c.category,
      source: c.source,
      method: c.method,
      count: members.length,
      previewWords: members.slice(0, 3).map((m) => m.word),
    });
  }
  const indexBytes = Buffer.from(JSON.stringify(catalogIndex));
  await writeFile(join(stage, "catalogs/index.json"), indexBytes);
  const all = gzipSync(JSON.stringify(heads));
  await writeFile(join(stage, "catalogs/all.json.gz"), all);
  const notices = [];
  for (const name of [
    "release.json",
    ...release.editions["lite-text"].assets.filter(
      (n) => !n.startsWith("entries-") && !n.startsWith("audio-"),
    ),
  ]) {
    const b = await readFile(join(source, name));
    await writeFile(join(stage, name), b);
    notices.push(asset(name, b));
  }
  const manifest = {
    schema: "leximeet.browser-text.v3",
    generatorRevision,
    dictionaryVersion: "0.0.3",
    entrySchema: "leximeet.entry.v2",
    sourceEdition: "lite-text",
    sourceReleaseSha256: lock.releaseSha256,
    entryCount: heads.length,
    audioCount: 0,
    catalogCount: catalogIndex.length,
    catalogIndex: asset("catalogs/index.json", indexBytes, catalogIndex.length),
    catalogMembers,
    allMembers: asset("catalogs/all.json.gz", all, heads.length),
    casefoldOverrides: overrides,
    ...sections,
    notices,
  };
  await writeFile(join(stage, manifestName), JSON.stringify(manifest) + "\n");
  // 只替换本脚本管理的生成目录；原词包保存在 previous，直到新产物完整落位。
  let previous;
  try {
    await readFile(join(output, manifestName)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      // 旧名称仅用于识别本脚本的历史生成目录；整目录替换后不再留入生产包。
      return readFile(join(output, "manifest.json"));
    });
    previous = output + ".previous";
    await rename(output, previous);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    await rename(stage, output);
  } catch (e) {
    if (previous) await rename(previous, output);
    throw e;
  }
  if (previous) await rm(previous, { recursive: true });
  console.log(
    `已生成 Lite Text：${heads.length} 词 / ${catalogIndex.length} 主题 / 不包含音频`,
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
