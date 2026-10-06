import { publicWord, tokenize } from "./pure.ts";
export type PickedWord = {
  id: string;
  surface: string;
  sentence: string;
  start: number;
};
// 内容脚本只提交实际点选的一词一原句，后台再次校验范围与预算。
export function pickedWord(value: unknown): PickedWord {
  const x = value as PickedWord;
  if (
    !x ||
    typeof x.id !== "string" ||
    !x.id.length ||
    x.id.length > 100 ||
    !publicWord(x.surface) ||
    typeof x.sentence !== "string" ||
    !x.sentence.length ||
    x.sentence.length > 4000 ||
    !Number.isInteger(x.start) ||
    x.start < 0 ||
    !tokenize(x.sentence).some((t) => t.start === x.start && t.surface === x.surface)
  )
    throw new Error("点选单词与原句位置不一致");
  return { id: x.id, surface: x.surface, sentence: x.sentence, start: x.start };
}
