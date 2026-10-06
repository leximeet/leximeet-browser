import path from "node:path";
import { verifyConnectorSnapshot } from "./lib/connector-snapshot.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { snapshot, manifest } = verifyConnectorSnapshot(
  path.join(root, "lib/connector/contracts"),
);
console.log(
  `LMCP ${snapshot.contractVersion}：${manifest.files.length} 份规范 / ${snapshot.files.length} 份冻结文件通过，摘要 ${snapshot.contractDigest}`,
);
