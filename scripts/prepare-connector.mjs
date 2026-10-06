import fs from "node:fs";
import path from "node:path";
import { verifyConnectorSnapshot } from "./lib/connector-snapshot.mjs";
const root = path.resolve(import.meta.dirname, "..");
const directory = path.join(root, "lib/connector/contracts");
const { snapshot, contract } = verifyConnectorSnapshot(directory);
// 从实际冻结字节生成声明，不把客户端声明当作真实双端联调结果。
fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.writeFileSync(
  path.join(root, "public/lmcp-readiness.json"),
  JSON.stringify(
    {
      contractVersion: contract.packageVersion,
      contractDigest: contract.contractDigest,
      sourceCommit: snapshot.sourceCommit,
      apiVersion: contract.apiVersion,
      nativeHost: contract.browserBinding.nativeHostName,
      jointAcceptancePassed: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(`LMCP 客户端合同：${contract.packageVersion}（声明不等于联调通过）`);
