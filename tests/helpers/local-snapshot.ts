import type { LocalLibrary } from "../../lib/local-database.ts";
// 仅测试读取业务仓库，检查不变性；不是产品文件导出或备份接口。
export async function localSnapshot(db: LocalLibrary) {
  const book = await db.book();
  return {
    format: book.format,
    book,
    settings: await db.settings(),
    words: await db.listWords(true),
    notebooks: await db.listNotebooks(true),
    encounters: await db.encounters(),
    reviews: await db.reviews(),
    practice: await db.practice(),
    plan: await db.plan(),
    workspace: await db.workspaceMeta("workspace"),
    checkpoints: await db.workspaceMeta("checkpoints"),
  };
}
