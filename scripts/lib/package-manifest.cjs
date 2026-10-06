"use strict";
const fs = require("node:fs");
const path = require("node:path");

// 商店会递归识别安装清单；数据文件和其他资源目录也必须纳入检查。
function assertSingleExtensionManifest(output) {
  const manifests = [];
  function visit(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`生产包不能包含无法递归核验的符号链接：${name}`);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name);
      else if (entry.isFile() && entry.name.toLowerCase() === "manifest.json")
        manifests.push(name);
    }
  }
  visit(output);
  if (manifests.length !== 1 || manifests[0] !== "manifest.json")
    throw new Error(
      `生产包只能包含根目录 manifest.json，实际发现：${manifests.sort().join("、") || "无"}`,
    );
}

module.exports = { assertSingleExtensionManifest };
