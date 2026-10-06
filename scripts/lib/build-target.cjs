"use strict";

// 正式包只声明已支持的两个 Chromium 商店，未知输入不能默默退回 Chrome。
function parseBuildTarget(args) {
  if (args.length === 0) return "chrome";
  if (
    args.length === 2 &&
    args[0] === "--browser" &&
    ["chrome", "edge"].includes(args[1])
  )
    return args[1];
  throw new Error("构建目标只支持 --browser chrome 或 --browser edge");
}

module.exports = { parseBuildTarget };
