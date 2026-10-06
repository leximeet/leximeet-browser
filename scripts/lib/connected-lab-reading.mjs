import { createServer } from "node:http";
import { DEFAULT_READING_URL } from "../../lib/reading-page.mjs";

// 阅读页来自本轮随机回环端口；不含账号、Desktop 数据或伪造配对接口。
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>词遇双端隔离阅读页</title><style>
body{margin:0;background:#f2f5ef;color:#253b31;font:21px/1.85 Georgia,serif}main{max-width:800px;margin:48px auto;padding:48px;background:#fff;border:1px solid #dce5dc;border-radius:16px}h1{font-size:40px;line-height:1.2}small{font:12px system-ui;color:#697f72;letter-spacing:.08em}a,button{font:14px system-ui;color:#19765f;border:1px solid #bdd4c7;padding:10px 16px;background:white;border-radius:8px;text-decoration:none;cursor:pointer}@media(max-width:900px){main{margin:20px;padding:28px}}</style>
<main><small>LEXIMEET · ISOLATED READING</small><h1>Building a reliable system</h1>
<p>A <strong>resilient</strong> system is a group of components that work together. Each component provides a useful service, while the network connects resources and carries data between them.</p>
<p data-testid="capture-edge-context">🙂 <span data-testid="mixed-case-word">Resilient</span> <span data-testid="target-word">SYSTEM</span>, network and <strong data-testid="unknown-word">leximeetnovelword</strong> share one context.</p>
<h2>Keep the design clear</h2><p>Start with a simple plan. Give every resource a clear purpose and make each operation easy to understand. A small change can improve the whole system when its effect is measured carefully.</p>
<p>A learner can encounter an unfamiliar word, capture its original context, and return to the idea tomorrow.</p>
<button id="site-action">Website action</button> <output id="site-result">0</output>
<p><a href="/second" target="_blank">Read another page</a> <a href="${DEFAULT_READING_URL}" target="_blank" rel="noreferrer">Open Node.js documentation</a></p>
<script>document.getElementById('site-action').onclick=()=>document.getElementById('site-result').textContent=Number(document.getElementById('site-result').textContent)+1;</script></main></html>`;

export async function startConnectedReadingServer() {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      request.url?.startsWith("/second")
        ? page.replace("词遇双端隔离阅读页", "词遇双端隔离阅读页 · 第二篇")
        : page,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    localUrl: `http://127.0.0.1:${server.address().port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
