import { browser } from "wxt/browser";
import { mountReader } from "../../page/reader.ts";
import { GUIDE_STORAGE_KEY, guideStep, validGuide } from "../../lib/onboarding-guide.ts";
import "./style.css";

// 自带正文仍走正式阅读控制器；不使用 fake 词卡、自动采集或模拟侧栏。
const tab = await browser.tabs.getCurrent();
if (tab?.id === undefined) throw new Error("使用教学必须在独立标签中打开");
const reader = mountReader(
  {
    onInvalidated: (dispose) =>
      window.addEventListener("pagehide", dispose, { once: true }),
  },
  tab.id,
);
if (!reader) throw new Error("教学阅读器重复启动");
const host = document.querySelector<HTMLElement>("leximeet-page-ui")!;
function theme() {
  const value = host.dataset.theme || "system";
  const dark =
    value === "dark" ||
    (value === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector<HTMLImageElement>(".lesson-header img")!.src =
    `/assets/brand/logo-${dark ? "dark" : "light"}.png`;
}
new MutationObserver(theme).observe(host, {
  attributes: true,
  attributeFilter: ["data-theme"],
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme);
theme();
async function progress() {
  const value = (await browser.storage.local.get(GUIDE_STORAGE_KEY))[GUIDE_STORAGE_KEY];
  if (!validGuide(value)) return;
  const complete = guideStep(value) === "complete",
    active = value.active;
  document.querySelector<HTMLButtonElement>("#lesson-skip")!.hidden = !active;
  document.querySelector<HTMLButtonElement>("#lesson-manage")!.hidden = active;
  document.querySelector("#lesson-status")!.textContent = complete
    ? "教学完成 · 去遇见自己的目标"
    : !active
      ? "教学已跳过 · 可以在设置重新进入"
      : "词遇内置英文阅读页";
}
document
  .querySelector("#lesson-skip")!
  .addEventListener("click", () => void reader.dismissGuide());
// 结束/跳过后提供真实管理入口，不把整个页面导航伪装成教学完成事件。
document
  .querySelector("#lesson-manage")!
  .addEventListener("click", () => void reader.openWorkspace());
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[GUIDE_STORAGE_KEY]) void progress();
});
void progress();
