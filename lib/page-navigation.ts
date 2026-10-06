// 软导航与往返缓存用完整 path/query/hash 判断正文是否换页；凭证不计入。
export function pageLocationKey(href: string) {
  try {
    const url = new URL(href);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "";
  }
}

export function locationChanged(previous: string, next: string) {
  const from = pageLocationKey(previous);
  const to = pageLocationKey(next);
  return !!from && !!to && from !== to;
}
