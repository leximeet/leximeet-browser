import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { verifyPackages } from "../scripts/package-github-release.mjs";

test("正式发行拒绝错版本、脏源码、非等价产物或被篡改的安装包", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-browser-release-"));
  const commit = "a".repeat(40);
  try {
    const packages = Object.fromEntries(
      ["chrome", "edge"].map((browser) => {
        const file = `leximeet-browser-1.0.0-${browser}.zip`;
        fs.writeFileSync(path.join(directory, file), "verified");
        return [
          browser,
          {
            file,
            bytes: 8,
            sha256: crypto.createHash("sha256").update("verified").digest("hex"),
          },
        ];
      }),
    );
    const evidence = {
      version: "1.0.0",
      sourceCommit: commit,
      sourceDirty: false,
      equivalence: true,
      productionDigest: "b".repeat(64),
      productionFiles: 5,
      packages,
    };
    assert.equal(verifyPackages(directory, evidence, "1.0.0", commit).length, 2);
    for (const changed of [
      { ...evidence, version: "0.0.1" },
      { ...evidence, sourceDirty: true },
      { ...evidence, sourceCommit: "c".repeat(40) },
      { ...evidence, equivalence: false },
      { ...evidence, packages: { chrome: packages.chrome } },
    ])
      assert.throws(() => verifyPackages(directory, changed, "1.0.0", commit));
    assert.throws(() => verifyPackages(directory, evidence, "v1.0.0", commit));
    const edge = packages.edge;
    assert.ok(edge);
    fs.writeFileSync(path.join(directory, edge.file), "modified");
    assert.throws(() => verifyPackages(directory, evidence, "1.0.0", commit), /SHA-256/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
