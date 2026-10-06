import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

/** 只接收本轮完整独立 CI 验证的两份安装包；发布阶段不重新执行 WXT 构建。 */
export function verifyPackages(directory, evidence, tag, commit) {
  if (
    !/^\d+\.\d+\.\d+$/.test(tag) ||
    evidence.version !== tag ||
    evidence.sourceCommit !== commit ||
    evidence.sourceDirty !== false ||
    evidence.equivalence !== true ||
    !/^[a-f0-9]{64}$/.test(evidence.productionDigest) ||
    !(evidence.productionFiles > 0)
  )
    throw new Error("发行包必须对应本标签的干净源码与完整等价检查");
  const files = [];
  for (const browser of ["chrome", "edge"]) {
    const item = evidence.packages?.[browser];
    if (
      item?.file !== `leximeet-browser-${tag}-${browser}.zip` ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error("缺少同版本 Chrome/Edge 安装包");
    const location = path.join(directory, item.file);
    const stat = fs.lstatSync(location);
    if (
      !stat.isFile() ||
      stat.size !== item.bytes ||
      sha256(fs.readFileSync(location)) !== item.sha256
    )
      throw new Error(`安装包大小或 SHA-256 不符：${item.file}`);
    files.push(item);
  }
  return files;
}

export function packageRelease(directory, output, tag = process.env.GITHUB_REF_NAME) {
  const commit = git("rev-parse", "HEAD");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const evidence = JSON.parse(
    fs.readFileSync(path.join(directory, "store-packages.json"), "utf8"),
  );
  const files = verifyPackages(directory, evidence, tag, commit);
  if (pkg.version !== tag || git("status", "--porcelain"))
    throw new Error("正式发行要求已提交且版本一致的源码");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  for (const item of files)
    fs.copyFileSync(path.join(directory, item.file), path.join(output, item.file));
  fs.copyFileSync(
    path.join(directory, "store-packages.json"),
    path.join(output, "store-packages.json"),
  );
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
  const archive = `leximeet-browser-source-${tag}.tar.gz`;
  git(
    "archive",
    "--format=tar.gz",
    "--prefix=leximeet-browser/",
    `--output=${path.join(output, archive)}`,
    commit,
  );
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, "lib/connector/contracts/contract.json"), "utf8"),
  );
  const source = {
    format: "leximeet.browser-release/1",
    version: tag,
    releaseTag: tag,
    sourceCommit: commit,
    sourceDirty: false,
    protocol: { version: contract.apiVersion, digest: contract.contractDigest },
    dictionaryLockSha256: sha256(
      fs.readFileSync(path.join(root, "dictionary-text.lock.json")),
    ),
    productionDigest: evidence.productionDigest,
    productionFiles: evidence.productionFiles,
    verification: {
      standalone: "passed",
      connected: "separate-workflow",
      edgeBrowser: "manual",
      stores: "separate-publication",
    },
  };
  fs.writeFileSync(
    path.join(output, "SOURCE.json"),
    JSON.stringify(source, null, 2) + "\n",
  );
  const checksums = fs
    .readdirSync(output)
    .sort()
    .map((file) => `${sha256(fs.readFileSync(path.join(output, file)))}  ${file}\n`)
    .join("");
  fs.writeFileSync(path.join(output, "SHA256SUMS"), checksums);
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const source = packageRelease(
      path.resolve(process.argv[2] || ".output"),
      path.resolve(process.argv[3] || ".output/github-release"),
    );
    console.log(`正式发行附件已核验：${source.version} ${source.sourceCommit}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
