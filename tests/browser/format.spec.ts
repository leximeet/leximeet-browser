import { test, expect } from "./fixtures";
import { workspace, addWord } from "./ui-helpers";

test("真实 MV3：未知个人资料格式明确拒绝且保留词条原文", async ({ extension }) => {
  const page = await workspace(extension);
  await addWord(page, "resilient");
  const original = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("leximeet-personal-v1");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction(["meta", "words"], "readwrite");
    const words = await new Promise<any[]>((resolve, reject) => {
      const get = tx.objectStore("words").getAll();
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    const book = await new Promise<any>((resolve, reject) => {
      const get = tx.objectStore("meta").get("book");
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    tx.objectStore("meta").put({ ...book, format: "unknown-personal-format" }, "book");
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { words, book };
  });
  expect(original.words).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "本地资料版本不受支持，原数据未修改",
  );
  const preserved = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("leximeet-personal-v1");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction(["meta", "words"], "readonly");
    const read = <T>(store: string, key?: string) =>
      new Promise<T>((resolve, reject) => {
        const request = key
          ? tx.objectStore(store).get(key)
          : tx.objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const result = {
      words: await read<any[]>("words"),
      book: await read<any>("meta", "book"),
    };
    db.close();
    return result;
  });
  expect(preserved.words).toEqual(original.words);
  expect(preserved.book.bookUid).toBe(original.book.bookUid);
  expect(preserved.book.format).toBe("unknown-personal-format");
});
