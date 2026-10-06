"use strict";
const fs = require("node:fs");
const path = require("node:path");

function visitFiles(directory, visit, relative = "") {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`生产包不能包含无法递归核验的符号链接：${name}`);
    if (entry.isDirectory()) visitFiles(file, visit, name);
    else if (entry.isFile()) visit(file, name);
  }
}

// 商店会递归识别安装清单；数据文件和其他资源目录也必须纳入检查。
function assertSingleExtensionManifest(output) {
  const manifests = [];
  visitFiles(output, (_file, name) => {
    if (path.basename(name).toLowerCase() === "manifest.json") manifests.push(name);
  });
  if (manifests.length !== 1 || manifests[0] !== "manifest.json")
    throw new Error(
      `生产包只能包含根目录 manifest.json，实际发现：${manifests.sort().join("、") || "无"}`,
    );
}

// Edge 拒绝安装 ZIP 内的压缩档案；词典使用明文，由外层 ZIP 统一压缩。
// 同时核对常见文件头，避免将 gzip 等简单改名为 json 后漏过发布门禁。
function assertNoEmbeddedArchives(output) {
  const extensions =
    /\.(?:zip|gz|gzip|tgz|bz2|bzip2|tbz2?|xz|txz|zst|zstd|br|7z|rar|tar|lz|lzma|lzip|z)$/i;
  const signatures = [
    "504b0304",
    "504b0506",
    "504b0708", // ZIP
    "1f8b",
    "425a68",
    "fd377a585a00", // GZIP、BZIP2、XZ
    "28b52ffd",
    "377abcaf271c",
    "526172211a07",
    "4c5a4950", // ZSTD、7Z、RAR、LZIP
  ].map((hex) => Buffer.from(hex, "hex"));
  visitFiles(output, (file, name) => {
    if (extensions.test(name)) throw new Error(`生产包禁止内嵌压缩档案：${name}`);
    const descriptor = fs.openSync(file, "r");
    const header = Buffer.alloc(262);
    let size;
    try {
      size = fs.readSync(descriptor, header, 0, header.length, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    const startsWith = (signature) =>
      size >= signature.length && header.subarray(0, signature.length).equals(signature);
    const skippableZstd =
      size >= 4 &&
      header[0] >= 0x50 &&
      header[0] <= 0x5f &&
      header.subarray(1, 4).equals(Buffer.from("2a4d18", "hex"));
    const tar = size >= 262 && header.subarray(257, 262).equals(Buffer.from("ustar"));
    if (signatures.some(startsWith) || skippableZstd || tar)
      throw new Error(`生产包文件头是压缩档案，不可通过改名绕过：${name}`);
  });
}

module.exports = { assertSingleExtensionManifest, assertNoEmbeddedArchives };
