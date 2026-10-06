import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertSingleExtensionManifest,
  assertNoEmbeddedArchives,
} from "../scripts/lib/package-manifest.cjs";

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

test("正式包允许明文词典及正常图片、音效", (t) => {
  const directory = packageFixture(t, [
    "manifest.json",
    "dictionaries/core/entries/re.jsonl",
    "dictionaries/core/catalogs/all.json",
    "assets/icon.png",
    "assets/success.wav",
  ]);
  assert.doesNotThrow(() => assertNoEmbeddedArchives(directory));
});

test("正式包递归拒绝压缩档案后缀，不能把历史缓存带入商店", (t) => {
  for (const extension of [
    "gz",
    "GZ",
    "zip",
    "tgz",
    "bz2",
    "xz",
    "zst",
    "br",
    "7z",
    "rar",
    "tar",
    "lzma",
  ]) {
    const directory = packageFixture(t, [
      "manifest.json",
      `dictionaries/core/nested/data.${extension}`,
    ]);
    assert.throws(() => assertNoEmbeddedArchives(directory), /禁止内嵌压缩档案/);
  }
});

test("压缩档案改成数据文件后缀仍按文件头拒绝", (t) => {
  const signatures = [
    "1f8b0800",
    "504b0304",
    "504b0506",
    "504b0708",
    "425a68",
    "fd377a585a00",
    "28b52ffd",
    "502a4d18",
    "5f2a4d18",
    "377abcaf271c",
    "526172211a0700",
    "4c5a4950",
  ];
  for (const signature of signatures) {
    const directory = packageFixture(t, ["manifest.json", "data.json"]);
    writeFileSync(join(directory, "data.json"), Buffer.from(signature, "hex"));
    assert.throws(() => assertNoEmbeddedArchives(directory), /文件头是压缩档案/);
  }
  const directory = packageFixture(t, ["manifest.json", "data.json"]);
  const tar = Buffer.alloc(512);
  tar.write("ustar", 257);
  writeFileSync(join(directory, "data.json"), tar);
  assert.throws(() => assertNoEmbeddedArchives(directory), /文件头是压缩档案/);
});
