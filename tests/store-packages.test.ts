import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("商店 ZIP 门禁拒绝损坏、旧包、额外清单和不等价产物", () => {
  execFileSync(
    "python3",
    [fileURLToPath(new URL("./store-packages_test.py", import.meta.url))],
    { stdio: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
});
