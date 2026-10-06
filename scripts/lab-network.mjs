import { createConnection } from "node:net";

async function available(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (found) => {
      socket.destroy();
      resolve(found);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

// Chromium 不自动继承 shell 的代理变量；只为本轮隔离浏览器设置，回环阅读页直连。
export async function labProxy(env = process.env, probe = available) {
  if (env.LEXIMEET_LAB_PROXY === "direct") return undefined;
  let server =
    env.LEXIMEET_LAB_PROXY ||
    env.https_proxy ||
    env.HTTPS_PROXY ||
    env.http_proxy ||
    env.HTTP_PROXY ||
    env.all_proxy ||
    env.ALL_PROXY;
  if (!server) {
    for (const port of [7897, 12334]) {
      if (await probe(port)) {
        server = `http://127.0.0.1:${port}`;
        break;
      }
    }
  }
  if (!server) return undefined;
  const url = new URL(server);
  if (
    !["http:", "https:", "socks5:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("验收代理请使用不带凭据的 HTTP/HTTPS/SOCKS5 地址");
  return {
    server: url.origin === "null" ? server : url.origin,
    bypass: "localhost,127.0.0.1,[::1]",
  };
}
