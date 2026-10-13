import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cleanTestResources } from "../scripts/clean-test-resources.mjs";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-cleanup-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "leximeet-browser" }),
  );
  for (const dir of [
    "test-results",
    "playwright-report",
    ".output",
    ".dictionary-release",
    ".bug",
  ]) {
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, "keep.txt"), "fixture");
  }
  return root;
}

test("测试清理默认只预览，应用时只移除两种固定报告，保留构建和个人输入", (t) => {
  const root = fixture(t);
  const options = { root, commands: () => "node unrelated-service.mjs" };
  const preview = cleanTestResources(options);
  assert.equal(preview.applied, false);
  assert.equal(preview.bytes, 14);
  assert.equal(fs.existsSync(path.join(root, "test-results")), true);
  assert.equal(cleanTestResources({ ...options, apply: true }).applied, true);
  for (const dir of ["test-results", "playwright-report"])
    assert.equal(fs.existsSync(path.join(root, dir)), false);
  for (const dir of [".output", ".dictionary-release", ".bug"])
    assert.equal(fs.readFileSync(path.join(root, dir, "keep.txt"), "utf8"), "fixture");
  assert.equal(cleanTestResources({ ...options, apply: true }).bytes, 0);
});

test("测试运行中、检查失败及清理前新启动的测试都不能删除报告", (t) => {
  const root = fixture(t);
  for (const command of [
    "node /a/node_modules/playwright/cli.js test",
    "node /a/scripts/launch-connected-lab.mjs",
    "node /a/scripts/launch-isolated-browser.mjs",
  ]) {
    assert.throws(
      () => cleanTestResources({ root, apply: true, commands: () => command }),
      /运行/,
    );
  }
  assert.throws(() =>
    cleanTestResources({
      root,
      apply: true,
      commands: () => {
        throw new Error("检查失败");
      },
    }),
  );
  let checks = 0;
  assert.throws(() =>
    cleanTestResources({
      root,
      apply: true,
      commands: () => (++checks === 1 ? "node other.js" : "playwright test"),
    }),
  );
  assert.equal(fs.existsSync(path.join(root, "test-results/keep.txt")), true);
});

test("报告中的软链接及非 Browser 项目拒绝清理，外部资料保留", (t) => {
  const root = fixture(t);
  fs.symlinkSync(path.join(root, ".bug"), path.join(root, "test-results/outside"), "dir");
  assert.throws(
    () => cleanTestResources({ root, apply: true, commands: () => "" }),
    /软链接/,
  );
  assert.equal(fs.readFileSync(path.join(root, ".bug/keep.txt"), "utf8"), "fixture");
  assert.equal(fs.existsSync(path.join(root, "playwright-report")), true);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "other" }));
  assert.throws(
    () => cleanTestResources({ root, apply: true, commands: () => "" }),
    /词遇浏览器/,
  );
});
