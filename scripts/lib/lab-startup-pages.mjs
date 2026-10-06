import { DEFAULT_READING_URL } from "../../lib/reading-page.mjs";

// 人工另留 Node.js 文档；后台自动化默认仅访问本轮 fixture，不依赖外网。
export function labReadingUrl({ headless, readingUrl } = {}) {
  if (typeof headless !== "boolean") throw new Error("headless 必须是布尔值");
  const value = readingUrl ?? (headless ? "local" : DEFAULT_READING_URL);
  if (value !== "local" && !/^https?:$/.test(new URL(value).protocol))
    throw new Error("阅读页只允许 HTTP/HTTPS");
  return value;
}

// 导航失败只把本轮阅读标签退回本地；不会关闭教学页、伪造正文或吞掉取消。
export async function openLabReadingPage({
  context,
  readingUrl,
  localUrl,
  navigationTimeout = 20000,
  signal,
  onStatus = console.log,
}) {
  const requestedUrl = readingUrl === "local" ? localUrl : readingUrl;
  for (const value of [requestedUrl, localUrl])
    if (!/^https?:$/.test(new URL(value).protocol))
      throw new Error("阅读页只允许 HTTP/HTTPS");
  signal?.throwIfAborted();
  const reading = await context.newPage();
  let fallback = false;
  async function navigate(url, timeout) {
    const response = await reading.goto(url, { waitUntil: "domcontentloaded", timeout });
    if (!response?.ok())
      throw new Error(`阅读页返回 HTTP ${response?.status() || "未知"}`);
    if (!(await reading.locator("body").innerText({ timeout })).trim())
      throw new Error("阅读页没有可读正文");
    signal?.throwIfAborted();
  }
  try {
    await navigate(requestedUrl, navigationTimeout);
  } catch (error) {
    signal?.throwIfAborted();
    if (readingUrl === "local" || reading.isClosed()) throw error;
    fallback = true;
    onStatus(
      "英文文档暂时不可访问，已切换到本轮本地英文阅读页；浏览器继续保留，可正常遇见、采集和练习。",
    );
    await navigate(localUrl, 15000);
  }
  return { reading, requestedUrl, url: reading.url(), fallback };
}

// 复用真实 onInstalled 打开的教学页，等正文就绪后选中；不创建页或改教学进度。
export async function installedTutorial({
  context,
  extensionId,
  signal,
  timeout = 15000,
}) {
  const url = `chrome-extension://${extensionId}/tutorial.html`;
  const deadline = Date.now() + timeout;
  let page;
  do {
    signal?.throwIfAborted();
    page = context.pages().find((candidate) => candidate.url() === url);
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  if (!page) throw new Error("本轮真实首装教学页未出现");
  await page.waitForLoadState("domcontentloaded", {
    timeout: Math.max(1, deadline - Date.now()),
  });
  await page
    .locator(".lesson article h1")
    .waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
  signal?.throwIfAborted();
  return page;
}

// 最后选中教学，避免新建阅读/管理标签把首次教学盖住；后台不聚焦系统应用。
export async function activateLabPage({ tutorial, workspace, startupPage }) {
  if (!["tutorial", "workspace"].includes(startupPage))
    throw new Error("启动页只能是 tutorial 或 workspace");
  const page = startupPage === "tutorial" ? tutorial : workspace;
  if (!page || page.isClosed()) throw new Error("本轮启动页已关闭或未就绪");
  await page.bringToFront();
  return page.url();
}
