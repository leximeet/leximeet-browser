import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
// 数字比较，避免把 1.0.10 排在 1.0.9 前面或丢失大整数精度。
export function compareVersions(left, right) {
  if (![left, right].every((value) => versionPattern.test(value ?? "")))
    throw new Error("正式版本须为无 v 前缀的三段数字");
  const a = left.split(".").map(BigInt),
    b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

// gh api --paginate --slurp 返回分页数组。只看已公开的正式发行，不依赖 Latest 标记或创建顺序。
export function verifyLatestStoreRelease(pages, version) {
  compareVersions(version, version);
  if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray))
    throw new Error("GitHub 正式发行列表无效，停止商店写入");
  const releases = pages.flat();
  if (
    releases.some(
      (item) =>
        !item ||
        typeof item.draft !== "boolean" ||
        typeof item.prerelease !== "boolean" ||
        typeof item.tag_name !== "string",
    )
  )
    throw new Error("GitHub 发行信息不完整，停止商店写入");
  const versions = releases
    .filter(
      (item) =>
        !item.draft &&
        !item.prerelease &&
        item.published_at &&
        versionPattern.test(item.tag_name),
    )
    .map((item) => item.tag_name);
  if (!versions.includes(version)) throw new Error("当前版本尚未正式发行，停止商店写入");
  if (versions.some((value) => compareVersions(value, version) > 0))
    throw new Error("已有更新的正式发行，停止旧工作流写入商店");
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [file, version] = process.argv.slice(2);
    if (!file || !version || process.argv.length !== 4)
      throw new Error(
        "用法：node scripts/verify-latest-store-release.mjs <分页发行列表 JSON> <版本>",
      );
    verifyLatestStoreRelease(JSON.parse(await readFile(file, "utf8")), version);
    console.log(`Chrome 最新正式发行校验通过：${version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
