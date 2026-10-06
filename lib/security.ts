// 只信任扩展自身入口；确认窗在后台另设控制白名单，不能读个人历史。
export function trustedSender(
  sender: { id?: string; url?: string },
  extensionId: string,
) {
  try {
    const url = new URL(sender.url || "");
    return (
      sender.id === extensionId &&
      url.protocol === "chrome-extension:" &&
      url.hostname === extensionId &&
      ["/sidepanel.html", "/options.html", "/connection-confirmation.html"].includes(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}
import { isTutorialPage } from "./tutorial-page.ts";
// 真实 HTTP(S) 主 frame 或自己打包的教学页；仍必须有真实 tab、documentId、代次。
export function contentSender(
  sender: {
    id?: string;
    url?: string;
    tab?: { id?: number };
    frameId?: number;
    documentId?: string;
  },
  extensionId: string,
) {
  return (
    sender.id === extensionId &&
    Number.isInteger(sender.tab?.id) &&
    sender.frameId === 0 &&
    !!sender.documentId &&
    (/^https?:\/\//.test(sender.url || "") || isTutorialPage(sender.url, extensionId))
  );
}
