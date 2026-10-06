"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { assertSingleExtensionManifest } = require("./lib/package-manifest.cjs");

// 检查实际交给浏览器安装的 manifest，避免只修改 package.json 却沿用旧构建。
const root = path.resolve(__dirname, "..");
const expected = require(path.join(root, "package.json")).version;
const output = path.join(root, ".output/chrome-mv3");
assertSingleExtensionManifest(output);
const manifestPath = path.join(output, "manifest.json");
const actual = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
if (actual !== expected) {
  throw new Error(`扩展安装清单版本不一致：源码 ${expected}，构建 ${actual}`);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.manifest_version !== 3 || manifest.minimum_chrome_version !== "142")
  throw new Error("正式包必须使用 MV3 与最低 Chromium 142");
if (
  JSON.stringify([...manifest.permissions].sort()) !==
    JSON.stringify(
      [
        "activeTab",
        "scripting",
        "storage",
        "sidePanel",
        "nativeMessaging",
        "notifications",
        "alarms",
      ].sort(),
    ) ||
  (manifest.optional_permissions || []).length !== 0
) {
  throw new Error(
    "1.0.0 权限只允许七项：发现定时与连接通知已授权，不得额外声明下载或 tabs 权限",
  );
}
if (
  JSON.stringify(manifest.host_permissions) !==
    JSON.stringify(["http://*/*", "https://*/*"]) ||
  (manifest.optional_host_permissions || []).length ||
  manifest.content_scripts?.length !== 1 ||
  JSON.stringify(manifest.content_scripts[0].matches) !==
    JSON.stringify(["http://*/*", "https://*/*"]) ||
  JSON.stringify(manifest.content_scripts[0].js) !==
    JSON.stringify(["content-scripts/page.js"]) ||
  manifest.content_scripts[0].all_frames !== false ||
  manifest.content_scripts[0].run_at !== "document_idle"
) {
  throw new Error(
    "默认网页入口仅允许 HTTP/HTTPS 顶层脚本；禁止额外站点协议或页面资源暴露",
  );
}
if (manifest.web_accessible_resources || manifest.action.default_popup)
  throw new Error("不应暴露私人页面资源或配置 popup");
const dictionary = JSON.parse(
  fs.readFileSync(
    path.join(root, ".output/chrome-mv3/dictionaries/core/dictionary-manifest.json"),
    "utf8",
  ),
);
const lock = require(path.join(root, "dictionary-text.lock.json"));
if (
  dictionary.schema !== "leximeet.browser-text.v3" ||
  dictionary.sourceReleaseSha256 !== lock.releaseSha256 ||
  dictionary.entryCount !== lock.entryCount ||
  dictionary.audioCount !== 0 ||
  dictionary.sourceEdition !== "lite-text" ||
  dictionary.catalogCount !== lock.catalogCount
) {
  throw new Error("构建产物没有包含锁定的 LexiMeet Dictionary core");
}
const declaration = JSON.parse(
  fs.readFileSync(path.join(root, ".output/chrome-mv3/lmcp-readiness.json"), "utf8"),
);
const contract = require(path.join(root, "lib/connector/contracts/contract.json"));
if (
  declaration.contractVersion !== contract.packageVersion ||
  declaration.contractDigest !== contract.contractDigest ||
  declaration.nativeHost !== "org.leximeet.browser" ||
  declaration.jointAcceptancePassed !== false
)
  throw new Error("生产包的 LMCP 客户端声明不一致；声明不能冒称联调已通过");
// SDK 与构建器生成的辅助代码也进入生产包，通知必须随实际产物交付。
const sourceNotices = fs.readFileSync(
  path.join(root, "public/THIRD_PARTY_NOTICES.txt"),
  "utf8",
);
const builtNotices = fs.readFileSync(
  path.join(root, ".output/chrome-mv3/THIRD_PARTY_NOTICES.txt"),
  "utf8",
);
if (builtNotices !== sourceNotices) throw new Error("随包第三方通知缺失或与源码不一致");
if (!builtNotices.includes("es-module-shims —"))
  throw new Error("缺少预加载辅助代码的 es-module-shims 来源通知");
const lockedPackages = require(path.join(root, "package-lock.json")).packages;
for (const [label, name] of [
  ["Vue", "vue"],
  ["fzstd", "fzstd"],
  ["WXT", "wxt"],
  ["@wxt-dev/browser", "@wxt-dev/browser"],
  ["Vite", "vite"],
  ["Rolldown", "rolldown"],
]) {
  const version = lockedPackages[`node_modules/${name}`]?.version;
  if (!version || !builtNotices.includes(`${label} ${version}`))
    throw new Error(`缺少锁定运行代码的第三方通知：${name} ${version || "未锁定"}`);
}
for (const copyright of [
  "Copyright (c) 2018-present, Yuxi (Evan) You",
  "Copyright (c) 2020 Arjun Barrett",
  "Copyright (c) 2023 Aaron",
  "Copyright (c) 2019-present, VoidZero Inc. and Vite contributors",
  "Copyright (c) 2024-present VoidZero Inc. & Contributors",
  "Copyright (C) 2018-2021 Guy Bedford",
]) {
  const start = builtNotices.indexOf(copyright);
  if (start < 0) throw new Error(`缺少上游版权声明：${copyright}`);
  const next = builtNotices.indexOf("\nCopyright ", start + copyright.length);
  const block = builtNotices.slice(start + copyright.length, next < 0 ? undefined : next);
  const body = block.match(/Permission is hereby granted[\s\S]*?SOFTWARE\./)?.[0];
  // 标准 MIT 全文按空白规范化固定；逐份检查，不能用其他条目的许可代替。
  const hash = createHash("sha256")
    .update(body?.replace(/\s+/g, " ").trim() || "")
    .digest("hex");
  if (hash !== "fe2a9817987f862eaced948f0468c7f51d2fedfc48c5c505b246a49a3870e9a5")
    throw new Error(`MIT 授权正文不完整或被修改：${copyright}`);
}
console.log(`扩展安装清单版本：${actual}；生产目录仅有根 manifest.json`);
console.log(
  `内置词典：${dictionary.entryCount} 条词卡 / ${dictionary.audioCount} 段内置音频（在线朗读）`,
);
