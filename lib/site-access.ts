// 网站入口只覆盖 HTTP(S)；Chrome 内部页和商店不能注入内容脚本。
export function sitePattern(url: string | undefined): string | null {
  try {
    const parsed = new URL(url || "");
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.hostname === "chromewebstore.google.com" ||
      (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"))
    )
      return null;
    // Chrome match pattern 不包含端口，端口仍保留在语境来源 URL 中。
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

// getAll() 中可能有别的可选权限；不能把它们变成可注入的网站匹配。
export function readableOrigins(origins: string[] = []): string[] {
  return [
    ...new Set(origins.filter((origin) => /^https?:\/\/[^/]+\/\*$/.test(origin))),
  ].sort();
}

export type CurrentPage = {
  tabId: number | null;
  title: string;
  url: string;
  sitePattern: string | null;
  siteEnabled: boolean;
  access: "ready" | "loading" | "permission-needed" | "restricted";
};
