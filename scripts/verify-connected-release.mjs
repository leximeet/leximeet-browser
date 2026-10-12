import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ZIP 容器时间可以不同；真正发布的程序必须逐文件与连接验收生产目录一致。
export function verifyConnectedRelease(standalone, connected, tag, commit) {
  if (!/^\d+\.\d+\.\d+$/.test(tag) || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error("正式标签或提交无效");
  for (const evidence of [standalone, connected]) {
    if (
      evidence.version !== tag ||
      evidence.sourceCommit !== commit ||
      evidence.sourceDirty !== false ||
      evidence.equivalence !== true ||
      !/^[0-9a-f]{64}$/.test(evidence.productionDigest) ||
      !Number.isInteger(evidence.productionFiles) ||
      evidence.productionFiles < 1
    )
      throw new Error("独立与连接验收必须绑定同标签、干净提交和等价生产内容");
  }
  const sources = connected.connectedWith;
  if (
    sources?.verified !== true ||
    !/^[0-9a-f]{40}$/.test(sources.desktopCommit ?? "") ||
    !/^[0-9a-f]{40}$/.test(sources.coreCommit ?? "")
  )
    throw new Error("缺少成功连接验收的 Desktop/Core 来源");
  if (
    standalone.productionDigest !== connected.productionDigest ||
    standalone.productionFiles !== connected.productionFiles
  )
    throw new Error("独立与连接验收的生产字节不一致，禁止发布");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 6)
      throw new Error(
        "用法：node scripts/verify-connected-release.mjs <独立清单> <连接清单> <tag> <commit>",
      );
    verifyConnectedRelease(
      ...process.argv
        .slice(2, 4)
        .map((file) => JSON.parse(fs.readFileSync(file, "utf8"))),
      process.argv[4],
      process.argv[5],
    );
    console.log("同一标签的独立与连接生产内容已核验");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
