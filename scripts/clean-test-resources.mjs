import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const reportFolders = ["test-results", "playwright-report"];

// 进程检查不可用时拒绝删除。只输出清理目标，不输出其他项目的进程或参数。
function processCommands() {
  try {
    return execFileSync("ps", ["-axo", "command="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    throw new Error("无法检查测试进程，未清理；当前清理命令需要 macOS/Linux 的 ps");
  }
}
function assertIdle(commands) {
  if (
    typeof commands !== "string" ||
    /(?:playwright[^\n]*\b(?:test|--ui|--debug)\b|launch-connected-lab\.mjs|launch-isolated-browser\.mjs)/.test(
      commands,
    )
  )
    throw new Error("仍有浏览器自动化或 lab 在运行，未清理；请结束后重试");
}
function sizeOf(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw new Error("报告目录含软链接或特殊文件，未清理");
  if (stat.isFile()) return stat.size;
  return fs
    .readdirSync(file)
    .reduce((size, entry) => size + sizeOf(path.join(file, entry)), 0);
}

// 只清固定报告目录，不清 .output、词典、SDK 缓存、临时 profile 或调用者提供的任意路径。
export function cleanTestResources({
  root = projectRoot,
  apply = false,
  commands = processCommands,
} = {}) {
  if (
    !path.isAbsolute(root) ||
    typeof apply !== "boolean" ||
    fs.lstatSync(root).isSymbolicLink() ||
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name !==
      "leximeet-browser"
  )
    throw new Error("清理目标必须是词遇浏览器项目的真实目录");
  if (apply) assertIdle(commands());
  const targets = reportFolders
    .map((name) => path.join(root, name))
    .filter(fs.existsSync)
    .map((file) => {
      if (!fs.lstatSync(file).isDirectory()) throw new Error("报告路径不是目录，未清理");
      return { name: path.basename(file), bytes: sizeOf(file), file };
    });
  // 所有目标先检查完，避免一半已删、一半才发现路径错误。
  if (apply) {
    assertIdle(commands());
    for (const target of targets) fs.rmSync(target.file, { recursive: true });
  }
  return {
    applied: apply,
    bytes: targets.reduce((sum, item) => sum + item.bytes, 0),
    targets: targets.map(({ name, bytes }) => ({ name, bytes })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--apply"))
      throw new Error("用法：npm run test:clean [-- --apply]；默认只预览");
    const result = cleanTestResources({ apply: args[0] === "--apply" });
    console.log(JSON.stringify(result, null, 2));
    if (!result.applied)
      console.log("只预览；确认报告不再需要后执行 npm run test:clean -- --apply");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
