import { test, expect } from "./fixtures";
import { readingServer } from "../helpers/extension.cjs";
import { workspace, addWord, pickWord, facts } from "./ui-helpers";
import { captureReadingWorkspace } from "../helpers/reading-workspace";

// 真实原生侧栏中操作采集编辑，不注入对话框或写入展示状态。
test("采集编辑：明暗实图与个人笔记", async ({ extension }, info) => {
  const manager = await workspace(extension);
  await manager.getByRole("button", { name: "跳过引导", exact: true }).click();
  await addWord(manager, "node");
  const server = await readingServer(
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Capture note example</title><style>body{margin:48px;color:#26352f;background:#f5f6f3;font:24px/1.8 Georgia}h1{font-size:36px}</style><h1>Reading notes</h1><p>Node uses the system.</p></html>',
  );
  try {
    const reading = await extension.context.newPage();
    await reading.goto(server.url);
    const panel = await extension.openPanel(reading);
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await pickWord(reading, "Node");
    await panel.getByRole("button", { name: "编辑语境", exact: true }).click();
    const dialog = panel.getByRole("dialog", { name: "编辑采集语境" });
    await expect(dialog.getByLabel("保存摘录", { exact: true })).toHaveValue(
      "Node uses the system.",
    );
    await expect(dialog.getByLabel("释义补充", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("笔记", { exact: true }).fill("记下这一次阅读的用法。");
    await dialog.getByLabel("保存摘录", { exact: true }).focus();
    for (const theme of ["light", "dark"] as const) {
      await panel.emulateMedia({ colorScheme: theme });
      await expect(panel.locator(".lm-panel")).toHaveAttribute("data-theme", theme);
      await captureReadingWorkspace(
        reading,
        panel,
        info.outputPath(`capture-note-${theme}.png`),
      );
    }
    await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect.poll(async () => (await facts(manager)).encounters.length).toBe(1);
    expect((await facts(manager)).encounters[0].annotation).toEqual({
      note: "记下这一次阅读的用法。",
    });
  } finally {
    await server.close();
  }
});
