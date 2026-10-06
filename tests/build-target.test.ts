import test from "node:test";
import assert from "node:assert/strict";
import { parseBuildTarget } from "../scripts/lib/build-target.cjs";

test("安装清单校验默认 Chrome，可明确选择 Chrome 或 Edge", () => {
  assert.equal(parseBuildTarget([]), "chrome");
  assert.equal(parseBuildTarget(["--browser", "chrome"]), "chrome");
  assert.equal(parseBuildTarget(["--browser", "edge"]), "edge");
});

test("未知或不完整目标不允许误校验 Chrome 产物", () => {
  for (const args of [
    ["edge"],
    ["--browser"],
    ["--browser", "firefox"],
    ["--browser", "../chrome-mv3"],
    ["--browser", "Edge"],
    ["--browser", "edge", "extra"],
    ["--target", "edge"],
  ])
    assert.throws(() => parseBuildTarget(args), /构建目标只支持/);
});
