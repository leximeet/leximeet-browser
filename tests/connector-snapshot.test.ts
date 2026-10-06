import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { verifyConnectorSnapshot } from "../scripts/lib/connector-snapshot.mjs";

const source = path.resolve("lib/connector/contracts");
function ownedCopy(run: (directory: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-contract-test-"));
  try {
    fs.cpSync(source, directory, { recursive: true });
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("构建合同同时核验17份规范、配置摘要和20份冻结消费文件", () => {
  const verified = verifyConnectorSnapshot(source);
  assert.equal(verified.manifest.files.length, 17);
  assert.equal(verified.snapshot.files.length, 20);
  assert.equal(verified.contract.packageVersion, "1.0.0");
});

test("仅改本地文件哈希不能绕过规范配置身份", () => {
  ownedCopy((directory) => {
    const file = path.join(directory, "contract.json");
    const contract = JSON.parse(fs.readFileSync(file, "utf8"));
    contract.requiredCapabilities = [];
    fs.writeFileSync(file, JSON.stringify(contract));
    const snapshotFile = path.join(directory, "snapshot.json");
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
    snapshot.files.find((item: any) => item.path === "contract.json").sha256 = createHash(
      "sha256",
    )
      .update(fs.readFileSync(file))
      .digest("hex");
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
    assert.throws(() => verifyConnectorSnapshot(directory), /规范清单与固定摘要不一致/);
  });
});

test("遗漏规范正文时拒绝生成消费声明", () => {
  ownedCopy((directory) => {
    const file = path.join(directory, "snapshot.json");
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    snapshot.files = snapshot.files.filter((item: any) => !item.path.startsWith("docs/"));
    fs.writeFileSync(file, JSON.stringify(snapshot));
    assert.throws(() => verifyConnectorSnapshot(directory), /缺少同一来源的完整规范/);
  });
});

test("短 SHA 或无效来源拒绝进入构建和真实联调", () => {
  for (const sourceCommit of ["d92c8c1", "", "x".repeat(40)])
    ownedCopy((directory) => {
      const file = path.join(directory, "snapshot.json");
      const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
      snapshot.sourceCommit = sourceCommit;
      fs.writeFileSync(file, JSON.stringify(snapshot));
      assert.throws(() => verifyConnectorSnapshot(directory), /完整 40 位提交 SHA/);
    });
});
