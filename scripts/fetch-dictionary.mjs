#!/usr/bin/env node
// 固定版本/清单/每个资产 SHA；此工具只下载公开文字包，不下载 Full 和音频。
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const run = promisify(execFile),
  root = resolve(import.meta.dirname, "..");
const hash = (b) => createHash("sha256").update(b).digest("hex");
export async function fetchDictionary(
  directory = resolve(
    process.env.LEXIMEET_DICTIONARY_RELEASE_DIR ||
      join(root, ".dictionary-release/v0.0.3"),
  ),
  withCore = false,
) {
  const lock = JSON.parse(
    await readFile(join(root, "dictionary-text.lock.json"), "utf8"),
  );
  await mkdir(directory, { recursive: true });
  let reused = 0,
    downloaded = 0;
  async function asset(name, expected) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === "." || name === "..")
      throw new Error("不允许的发布资产路径");
    const path = join(directory, name);
    try {
      const b = await readFile(path);
      if (hash(b) === expected) {
        reused++;
        return b;
      }
    } catch {}
    const temp = path + ".pending";
    try {
      await run("curl", [
        "--fail",
        "--location",
        "--retry",
        "2",
        "--connect-timeout",
        "15",
        "--max-time",
        "240",
        lock.releaseBaseUrl + name,
        "--output",
        temp,
      ]);
      const bytes = await readFile(temp);
      if (hash(bytes) !== expected) throw new Error(`发布资产哈希不符：${name}`);
      await rename(temp, path);
      downloaded++;
      return bytes;
    } finally {
      await rm(temp, { force: true });
    }
  }
  const raw = await asset("release.json", lock.releaseSha256),
    release = JSON.parse(raw);
  if (
    release.schema_version !== "leximeet.release.v3" ||
    release.dictionary_version !== "0.0.3"
  )
    throw new Error("发布合同不符");
  const names = [
    ...new Set([
      ...release.editions["lite-text"].assets,
      ...(withCore ? ["entries-core-delta.jsonl.zst"] : []),
    ]),
  ];
  for (const name of names) {
    const b = await asset(name, release.assets[name].sha256);
    if (b.length !== release.assets[name].bytes) throw new Error(`资产长度不符：${name}`);
  }
  console.log(
    `Dictionary 0.0.3 Lite Text ${withCore ? "及 Core 增量 " : ""}已逐文件校验：${directory}（复用 ${reused} / 下载 ${downloaded}）`,
  );
  return directory;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await fetchDictionary(undefined, process.argv.includes("--with-core"));
