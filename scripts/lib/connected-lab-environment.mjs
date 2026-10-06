import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";

import { verifyConnectorSnapshot } from "./connector-snapshot.mjs";

export const browserRoot = path.resolve(import.meta.dirname, "../..");
// 与构建声明使用同一已校验冻结合同，协议更新后不保留第二份过时摘要。
const { contract } = verifyConnectorSnapshot(
  path.join(browserRoot, "lib/connector/contracts"),
);
export const CONNECTOR_VERSION = contract.packageVersion;
export const CONNECTOR_DIGEST = contract.contractDigest;
export const defaultDesktopRoot = path.resolve(browserRoot, "../../leximeet-desktop");

// 独占副本按每个文件验证；不改 manifest、公开 key 或生产权限。
export function treeHashes(directory, prefix = "") {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("构建目录必须是真实目录");
  return Object.fromEntries(
    fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const file = path.join(directory, entry.name),
          name = path.posix.join(prefix, entry.name);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
          throw new Error("构建目录包含软链接或特殊文件");
        return entry.isDirectory()
          ? Object.entries(treeHashes(file, name))
          : [[name, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]];
      }),
  );
}

// 优先复用已经安装的 JDK 21；不更改系统默认 Java，不自动下载运行时。
export function inspectJava21(desktopRoot) {
  const probe = (executable, args) => {
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      timeout: 5000,
    });
    return result.error || result.status !== 0 ? "" : `${result.stdout}${result.stderr}`;
  };
  if (process.env.LEXIMEET_JAVA && !path.isAbsolute(process.env.LEXIMEET_JAVA))
    throw new Error("LEXIMEET_JAVA 必须是 JDK 21 java 可执行文件的绝对路径");
  const homes = [process.env.JAVA_HOME, path.join(desktopRoot, ".runtime/tools/jdk21")];
  if (process.platform === "darwin") {
    homes.push(probe("/usr/libexec/java_home", ["-v", "21"]).trim());
    const managed = path.join(os.homedir(), "Library/PhpWebStudy/app");
    if (fs.existsSync(managed))
      for (const folder of fs.readdirSync(managed))
        if (folder.includes("openjdk-21"))
          homes.push(path.join(managed, folder, "Contents/Home"));
  }
  const candidates = [
    ...(process.env.LEXIMEET_JAVA ? [{ executable: process.env.LEXIMEET_JAVA }] : []),
    ...homes
      .filter((home) => home && path.isAbsolute(home))
      .map((home) => ({ home, executable: path.join(home, "bin/java") })),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.executable)) continue;
    const executable = fs.realpathSync(candidate.executable);
    const home = candidate.home
      ? fs.realpathSync(candidate.home)
      : path.dirname(path.dirname(executable));
    // 构建需要 javac，不能把系统 Java 转发器或只有 JRE 的目录当作 JDK_HOME。
    if (
      !fs.existsSync(path.join(home, "release")) ||
      !fs.existsSync(path.join(home, "bin/javac"))
    )
      continue;
    const version = probe(executable, ["-version"]).trim();
    const compilerVersion = probe(path.join(home, "bin/javac"), ["-version"]).trim();
    if (/version "21[.\"]/.test(version) && /^javac 21(?:\.|$)/.test(compilerVersion))
      return {
        home,
        executable,
        version,
        compilerVersion,
        binarySha256: createHash("sha256")
          .update(fs.readFileSync(executable))
          .digest("hex"),
      };
  }
  throw new Error(
    "Desktop Core 需要 JDK 21；请安装后设置 JAVA_HOME，启动器不会改系统 Java",
  );
}
export function java21Environment(desktopRoot) {
  const java = inspectJava21(desktopRoot);
  return { JAVA_HOME: java.home, LEXIMEET_JAVA: java.executable };
}

// SHA 说明源码提交；dirty 与构建逐文件指纹共同说明当前未提交候选。
export function sourceRevision(directory) {
  const run = (args) =>
    spawnSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  const revision = run(["rev-parse", "HEAD"]);
  const sha = revision.stdout?.trim();
  if (revision.error || revision.status !== 0 || !/^[a-f0-9]{40}$/.test(sha || ""))
    return {
      sha: null,
      dirty: null,
      reason: "没有可读取的 Git 提交；以构建文件指纹核对候选",
    };
  const state = run(["status", "--porcelain", "--untracked-files=normal"]);
  return {
    sha,
    dirty: state.error || state.status !== 0 ? null : !!state.stdout.trim(),
  };
}

// 只读检查失败要明确结束，不能换成旧协议或假 Host。
export function checkConnectedEnvironment({
  desktopRoot = defaultDesktopRoot,
  extensionDir = path.join(browserRoot, ".output/chrome-mv3"),
} = {}) {
  if (process.platform !== "darwin")
    throw new Error(
      "1.0 本地连接当前仅完成 macOS Native Host 实现；其他平台需要单独验收",
    );
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("双端联调需要 Node.js 24 或更新版本");
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const manifest = read(path.join(extensionDir, "manifest.json"));
  if (
    manifest.manifest_version !== 3 ||
    !/^1\.0\.0(?:\.\d+)?$/.test(manifest.version) ||
    !manifest.permissions?.includes("nativeMessaging")
  )
    throw new Error("请先构建 Browser 1.0.0，核对 Native Messaging 权限");
  const declaration = read(path.join(extensionDir, "lmcp-readiness.json"));
  if (
    declaration.contractVersion !== CONNECTOR_VERSION ||
    declaration.contractDigest !== CONNECTOR_DIGEST
  )
    throw new Error("Browser 的 LMCP 版本或摘要不是当前1.0.0");
  const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));
  const executable = desktopRequire("electron");
  for (const file of [
    executable,
    path.join(desktopRoot, "core-java/target/leximeet-core.jar"),
    path.join(desktopRoot, "frontend/dist/index.html"),
    path.join(desktopRoot, "electron/native-host/main.cjs"),
  ])
    if (!fs.statSync(file).isFile())
      throw new Error(`缺少 Desktop 构建：${path.basename(file)}`);
  return {
    desktopRoot,
    extensionDir,
    executable,
    browserVersion: manifest.version,
    desktopVersion: read(path.join(desktopRoot, "package.json")).version,
    contractVersion: CONNECTOR_VERSION,
    contractDigest: CONNECTOR_DIGEST,
    platform: `${process.platform}-${process.arch}`,
    java: inspectJava21(desktopRoot),
  };
}

// 构建继承工具环境；运行进程仅继承白名单，避免把云凭证带入 trace。
export function runtimeEnvironment({
  desktopRoot,
  profileDir,
  headless,
  java = inspectJava21(desktopRoot),
}) {
  const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));
  const { backgroundEnvironment } = desktopRequire(
    "./tests/helpers/background-environment.cjs",
  );
  const env = backgroundEnvironment({
    profileDir,
    seed: false,
    browserSandbox: false,
  });
  Object.assign(env, { JAVA_HOME: java.home, LEXIMEET_JAVA: java.executable });
  if (!headless) {
    env.LEXIMEET_PROFILE = "demo";
    delete env.LEXIMEET_TEST_SILENT;
    delete env.LEXIMEET_TEST_BROWSER;
  }
  return env;
}

// 只结束本次 spawn 创建的构建进程组，Ctrl+C 不会遗留 Maven / Node。
export async function buildConnectedProjects({
  desktopRoot = defaultDesktopRoot,
  signal,
  onStatus = console.log,
} = {}) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const java = java21Environment(desktopRoot);
  const buildEnv = {
    ...process.env,
    ...java,
    PATH: [path.dirname(java.LEXIMEET_JAVA), process.env.PATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
  for (const [cwd, task] of [
    [browserRoot, "build"],
    [browserRoot, "verify:manifest"],
    [desktopRoot, "build"],
  ]) {
    signal?.throwIfAborted();
    onStatus(`准备 ${path.basename(cwd)}：${task}`);
    await new Promise((resolve, reject) => {
      const child = spawn(npm, ["run", task], {
        cwd,
        stdio: "inherit",
        env: buildEnv,
        detached: process.platform !== "win32",
      });
      let forceTimer;
      const killOwned = (name) => {
        if (!child.pid) return;
        try {
          process.platform === "win32"
            ? child.kill(name)
            : process.kill(-child.pid, name);
        } catch (error) {
          if (error.code !== "ESRCH") reject(error);
        }
      };
      const abort = () => {
        killOwned("SIGTERM");
        // Maven 子进程若未响应，也仅结束这次构建创建的独立进程组。
        forceTimer = setTimeout(() => killOwned("SIGKILL"), 5000);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(forceTimer);
        signal?.removeEventListener("abort", abort);
        // leader 退出后仍可能有构建子进程，只清理本次独占的组。
        if (signal?.aborted) killOwned("SIGKILL");
        signal?.aborted
          ? reject(signal.reason)
          : code === 0
            ? resolve()
            : reject(new Error(`${path.basename(cwd)} ${task} 失败，退出码 ${code}`));
      });
    });
  }
}
