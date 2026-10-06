import { sanitizeUrl } from "./pure.ts";
export const TUTORIAL_PATH = "/tutorial.html";
export const TUTORIAL_SOURCE = "leximeet://tutorial/reading";
// 只允许自己打包的教学页；其他扩展页、外部扩展和 Chrome 内部页仍不可分析。
export function isTutorialPage(url: string | undefined, extensionId: string) {
  return url === `chrome-extension://${extensionId}${TUTORIAL_PATH}`;
}
export function readingSourceUrl(url: string | undefined, extensionId: string) {
  return isTutorialPage(url, extensionId) ? TUTORIAL_SOURCE : sanitizeUrl(url || "");
}
