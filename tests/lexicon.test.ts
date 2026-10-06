import { meaningChoices } from "../lib/practice-session.ts";
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { CoreLexiconProvider } from "../lib/lexicon.ts";

const root = resolve("public/dictionaries/core");
const fetchLocal: typeof fetch = async (url) => {
  const name = String(url).replace("local://core/", "");
  if (
    !/^(dictionary-manifest\.json|(?:entries|forms)\/[a-z_]{2}\.jsonl|catalogs\/(?:index|\d{2}|all)\.json)$/.test(
      name,
    )
  )
    return new Response("", { status: 404 });
  try {
    return new Response(await readFile(resolve(root, name)));
  } catch {
    return new Response("", { status: 404 });
  }
};

test("核心词包离线读取完整逐义词卡、IPA、来源，文字包不附带录音", async () => {
  const dictionary = new CoreLexiconProvider("local://core/", fetchLocal);
  assert.equal((await fetchLocal("local://core/manifest.json")).status, 404);
  const entry = await dictionary.lookup("Resilient");
  assert.equal(entry?.normalized, "resilient");
  assert.equal(entry?.source.id, "leximeet-dictionary");
  assert.equal(entry?.source.revision, "0.0.3");
  assert.equal(entry?.raw.schema_version, "leximeet.entry.v2");
  assert.equal(entry?.translation.includes("resilient 是"), false);
  assert.ok(entry?.translation.includes("有韧性的"));
  assert.ok(entry?.senses.length);
  assert.equal(entry?.audio, null);
  assert.equal((await dictionary.allMembers()).length, 26417);
  assert.equal(await dictionary.lookup("notawordleximeetzz"), null);
});

test("首次冷正文通过词头与词形匹配，不读取释义分片，保留大小写同形词与词形回退", async () => {
  const requested: string[] = [];
  const headFetch: typeof fetch = async (url) => {
    const name = String(url).replace("local://core/", "");
    requested.push(name);
    assert.equal(name.startsWith("entries/"), false, "正文候选匹配不得解析完整释义分片");
    return fetchLocal(url);
  };
  // 新提供者与空缓存模拟首次扫描，而不是靠前一遍完整词卡读取暖缓存。
  const cold = new CoreLexiconProvider("local://core/", headFetch);
  const tokens =
    "Building a reliable system Resilient SYSTEM network connects resources and carries data between them leximeetnovelword share one context Keep design clear start with simple plan give every resource purpose make operation easy to understand small change can improve whole when its effect measured carefully learner encounter an unfamiliar word capture original return idea tomorrow read another Node js documentation".split(
      " ",
    );
  const found = await Promise.all(tokens.map((word) => cold.resolveHeadword(word)));
  assert.equal(found[tokens.indexOf("system")], "system");
  assert.equal(found[tokens.indexOf("SYSTEM")], "system");
  assert.equal(found[tokens.indexOf("Resilient")], "resilient");
  assert.equal(found[tokens.indexOf("leximeetnovelword")], null);
  assert.equal(await cold.resolveHeadword("CORE"), "CORE");
  assert.equal(await cold.resolveHeadword("core"), "core");
  const full = new CoreLexiconProvider("local://core/", fetchLocal);
  for (const word of ["books", "cancelled", "running", "US", "us", "CORE", "core"])
    assert.equal(
      await cold.resolveHeadword(word),
      (await full.lookup(word))?.word || null,
    );
  assert.equal(requested.filter((name) => name === "dictionary-manifest.json").length, 1);
  assert.equal(requested.includes("manifest.json"), false);
  assert.equal(requested.filter((name) => name === "catalogs/all.json").length, 1);
});

test("真实目录按发布包词序读取，区分考试与专业并保持词条 ID", async () => {
  const dictionary = new CoreLexiconProvider("local://core/", fetchLocal);
  const catalogs = await dictionary.listCatalogs();
  assert.equal(catalogs.length, 23);
  assert.ok(catalogs.some((catalog) => catalog.category === "exam"));
  assert.ok(catalogs.some((catalog) => catalog.category === "subject"));
  const members = await dictionary.catalogMembers("book:qwerty:CET4_T");
  assert.equal(
    members.length,
    catalogs.find((catalog) => catalog.id === "book:qwerty:CET4_T")?.count,
  );
  const first = await dictionary.lookup(members[0]!.word);
  assert.equal(first?.entryId, members[0]!.entryId);
  const computing = await dictionary.catalogMembers("subject:topic:computing");
  const technical = computing.find((member) => member.senseIds.length && member.meaning);
  assert.ok(technical, "专业词书应保留义项级命中");
  const technicalEntry = await dictionary.lookup(technical.word);
  assert.ok(
    technicalEntry?.senses.some(
      (sense) =>
        technical.senseIds.includes(sense.sense_id) &&
        technical.meaning.includes(sense.short_gloss || "不存在的释义"),
    ),
    "专业目录须显示命中义项的短释义",
  );
  await assert.rejects(dictionary.catalogMembers("unknown"), /不存在/);
});

test("损坏词卡和目录分片按哈希拒绝，不能显示伪内容或播放错误字节", async () => {
  const corruptEntry: typeof fetch = async (url) =>
    String(url).endsWith("entries/re.jsonl")
      ? new Response(new Uint8Array([1, 2, 3]))
      : fetchLocal(url);
  await assert.rejects(
    new CoreLexiconProvider("local://core/", corruptEntry).lookup("resilient"),
    /校验失败/,
  );
  const corruptCatalog: typeof fetch = async (url) =>
    /catalogs\/\d{2}\.json$/.test(String(url))
      ? new Response(new Uint8Array([1, 2, 3]))
      : fetchLocal(url);
  await assert.rejects(
    new CoreLexiconProvider("local://core/", corruptCatalog).catalogMembers(
      "book:qwerty:CET4_T",
    ),
    /校验失败/,
  );
});

test("选义使用 2–4 个不同的真实短义，只有一个选项时不出题", async () => {
  const dictionary = new CoreLexiconProvider("local://core/", fetchLocal);
  const own = (await dictionary.lookup("system"))!;
  const other = (await dictionary.lookup("ability"))!;
  const choices = meaningChoices(own, [other]);
  assert.equal(choices.length, 2);
  assert.equal(new Set(choices.map((c) => c.text)).size, 2);
  assert.equal(choices.filter((c) => c.correct).length, 1);
  assert.deepEqual(meaningChoices(own, [own]), []);
});

test("连续选义确定性轮换真实干扰项，不重复固定前三义且保留同词性优先", async () => {
  const dictionary = new CoreLexiconProvider("local://core/", fetchLocal);
  const own = (await dictionary.lookup("system"))!;
  const pool = (
    await Promise.all(
      ["ability", "action", "attention", "data", "network", "resource", "accept"].map(
        (w) => dictionary.lookup(w),
      ),
    )
  ).filter((e): e is NonNullable<typeof e> => !!e);
  const first = meaningChoices(own, pool, 0),
    next = meaningChoices(own, pool, 1);
  assert.deepEqual(first, meaningChoices(own, pool, 0));
  assert.equal(first.filter((c) => c.correct).length, 1);
  assert.notDeepEqual(
    first
      .filter((c) => !c.correct)
      .map((c) => c.id)
      .sort(),
    next
      .filter((c) => !c.correct)
      .map((c) => c.id)
      .sort(),
  );
  for (const c of first.filter((c) => !c.correct))
    assert.equal(
      pool.find((e) => e.entryId === c.id)?.possiblePos[0],
      own.possiblePos[0],
    );
});

test("明文词包拒绝旧压缩布局与越界资产路径，不能额外读取页面或录音", async () => {
  const source = JSON.parse(
    await readFile(resolve(root, "dictionary-manifest.json"), "utf8"),
  );
  for (const file of [
    "entries/re.jsonl.gz",
    "../entries/re.jsonl",
    "https://example.com/re.jsonl",
    "entries/re.jsonl?download=1",
    "entries/re.jsonl#part",
    "audio/0000.bin",
    "audio-index/00.jsonl",
    "entries/re.jsonl\n",
  ]) {
    const manifest = structuredClone(source);
    manifest.entries.re.file = file;
    const requests: string[] = [];
    const guardedFetch: typeof fetch = async (url) => {
      requests.push(String(url));
      return String(url).endsWith("dictionary-manifest.json")
        ? Response.json(manifest)
        : fetchLocal(url);
    };
    await assert.rejects(
      new CoreLexiconProvider("local://core/", guardedFetch).lookup("resilient"),
      /资产路径无效/,
    );
    assert.deepEqual(requests, ["local://core/dictionary-manifest.json"]);
  }
  source.generatorRevision = 2;
  const oldFetch: typeof fetch = async (url) =>
    String(url).endsWith("dictionary-manifest.json")
      ? Response.json(source)
      : fetchLocal(url);
  await assert.rejects(
    new CoreLexiconProvider("local://core/", oldFetch).lookup("resilient"),
    /版本或来源不受支持/,
  );
});

test("明文词典保留逐片条数检查和严格 UTF-8，校验正确也不接受损坏编码", async () => {
  const source = JSON.parse(
    await readFile(resolve(root, "dictionary-manifest.json"), "utf8"),
  );
  const badCount = structuredClone(source);
  badCount.entries.re.entries += 1;
  const countedFetch: typeof fetch = async (url) =>
    String(url).endsWith("dictionary-manifest.json")
      ? Response.json(badCount)
      : fetchLocal(url);
  await assert.rejects(
    new CoreLexiconProvider("local://core/", countedFetch).lookup("resilient"),
    /分片条数不符/,
  );

  const invalidUtf8 = new Uint8Array([0xff]);
  source.entries.re.bytes = invalidUtf8.length;
  source.entries.re.sha256 = createHash("sha256").update(invalidUtf8).digest("hex");
  source.entries.re.entries = 1;
  const encodingFetch: typeof fetch = async (url) =>
    String(url).endsWith("dictionary-manifest.json")
      ? Response.json(source)
      : String(url).endsWith("entries/re.jsonl")
        ? new Response(invalidUtf8)
        : fetchLocal(url);
  await assert.rejects(
    new CoreLexiconProvider("local://core/", encodingFetch).lookup("resilient"),
    /encoded data|encoding/i,
  );
});

test("全部 23 份明文学习目录均保留顺序、中文释义和原始词条身份", async () => {
  const dictionary = new CoreLexiconProvider("local://core/", fetchLocal);
  for (const catalog of await dictionary.listCatalogs()) {
    const members = await dictionary.catalogMembers(catalog.id);
    assert.equal(members.length, catalog.count);
    assert.equal(new Set(members.map((member) => member.entryId)).size, members.length);
    assert.ok(
      members.some((member) => /[\u3400-\u9fff]/u.test(member.meaning)),
      catalog.id,
    );
    assert.ok(members.every((member, index) => member.position === index + 1));
  }
});
