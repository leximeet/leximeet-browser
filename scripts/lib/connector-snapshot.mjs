import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// 合同配置只含 JSON 值。递归排序对象键，数组保留顺序，按协议的 JCS 摘要规则核验。
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * 本端冻结副本覆盖完整规范、Schema 和参考样例；不能只验证两个旧客户端碰巧一致。
 * 文件在本端按 basename 存放，snapshot.path 保留上游路径，禁止同名覆盖或漏掉规范。
 */
export function verifyConnectorSnapshot(directory) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
  const snapshot = read("snapshot.json");
  // 来源必须是完整提交，避免本地短 SHA 能构建但 Desktop 正式门禁拒绝。
  if (!/^[a-f0-9]{40}$/.test(snapshot.sourceCommit || ""))
    throw new Error("LMCP 冻结来源必须是完整 40 位提交 SHA");
  const contract = read("contract.json");
  const manifest = read("contract-manifest.json");
  const names = snapshot.files.map((item) => path.basename(item.path));
  if (new Set(names).size !== names.length) throw new Error("LMCP 冻结副本存在同名文件");
  for (const item of snapshot.files) {
    if (
      sha256(fs.readFileSync(path.join(directory, path.basename(item.path)))) !==
      item.sha256
    )
      throw new Error(`LMCP 冻结字节已变化：${item.path}`);
  }
  const { contractDigest, ...configuration } = contract;
  if (
    manifest.algorithm !== "sha256-jcs-manifest/1" ||
    manifest.configurationSha256 !== sha256(canonicalJson(configuration)) ||
    contractDigest !== sha256(canonicalJson(manifest)) ||
    snapshot.contractVersion !== contract.packageVersion ||
    manifest.contractVersion !== contract.packageVersion ||
    snapshot.contractDigest !== contractDigest
  )
    throw new Error("LMCP 合同、规范清单与固定摘要不一致");
  const byPath = new Map(snapshot.files.map((item) => [item.path, item.sha256]));
  for (const item of manifest.files)
    if (byPath.get(item.path) !== item.sha256)
      throw new Error(`LMCP 缺少同一来源的完整规范：${item.path}`);
  for (const name of [
    "contract.json",
    "contract-manifest.json",
    "fixtures/contracts.json",
  ])
    if (!byPath.has(name)) throw new Error(`LMCP 缺少消费物料：${name}`);
  return { snapshot, contract, manifest };
}
