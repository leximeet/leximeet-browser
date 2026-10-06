import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSingleExtensionManifest } from "../scripts/lib/package-manifest.cjs";

function packageFixture(t: TestContext, files: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "leximeet-package-manifest-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of files) {
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "{}\n");
  }
  return directory;
}

test("生产包允许唯一的根安装清单及独立命名的数据清单", (t) => {
  const directory = packageFixture(t, [
    "manifest.json",
    "dictionaries/core/dictionary-manifest.json",
    "connector/contract-manifest.json",
  ]);
  assert.doesNotThrow(() => assertSingleExtensionManifest(directory));
});

test("生产包递归拒绝词典和任意深层目录中的第二份安装清单", async (t) => {
  for (const name of [
    "dictionaries/core/manifest.json",
    "dictionaries/core.previous/manifest.json",
    "assets/nested/extension/manifest.json",
    "assets/nested/Manifest.JSON",
  ]) {
    await t.test(name, (t) => {
      const directory = packageFixture(t, ["manifest.json", name]);
      assert.throws(
        () => assertSingleExtensionManifest(directory),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /只能包含根目录 manifest.json/);
          assert.ok(error.message.includes(name));
          return true;
        },
      );
    });
  }
});

test("生产包缺少根清单或仅有嵌套清单时拒绝通过", async (t) => {
  for (const files of [[], ["dictionaries/core/manifest.json"], ["Manifest.JSON"]]) {
    await t.test(files.join("、") || "无清单", (t) => {
      const directory = packageFixture(t, files);
      assert.throws(() => assertSingleExtensionManifest(directory), /只能包含根目录/);
    });
  }
});

test("生产包符号链接不能绕过递归清单核验", (t) => {
  const directory = packageFixture(t, ["manifest.json", "assets/data.json"]);
  symlinkSync("data.json", join(directory, "assets/link.json"));
  assert.throws(() => assertSingleExtensionManifest(directory), /符号链接/);
});
