import { expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

/**
 * 无头 Chromium 将正文与真实 SIDE_PANEL 暴露为两个渲染表面，普通 page 截图只含一个。
 * 这里只拼接两张原始截图，不绘制浏览器工具栏或改动产品 DOM。公开使用时必须标为拼接图。
 * 原始图、像素尺寸和摘要同时保存，后续可以核对展示图的来源。
 */
export async function captureReadingWorkspace(
  reading: Page,
  panel: Page,
  outputPath: string,
) {
  const contexts = await panel.evaluate(() =>
    (globalThis as any).chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }),
  );
  expect(contexts.some((item: any) => item.documentUrl === panel.url())).toBe(true);
  const pageImage = await reading.screenshot({ animations: "disabled" });
  const panelImage = await panel.screenshot({ animations: "disabled" });
  const compositor = await reading.context().browser()!.newContext();
  try {
    const page = await compositor.newPage();
    // 仅在另一个空白测试 context 展示原图；生产正文和原生侧栏均不注入布局代码。
    await page.setContent(
      `<style>html,body{margin:0;padding:0}#workspace{display:flex;width:max-content;align-items:flex-start}img{display:block;max-width:none}</style><div id="workspace"><img id="reading" alt="真实阅读正文" src="data:image/png;base64,${pageImage.toString("base64")}"><img id="panel" alt="真实原生侧栏" src="data:image/png;base64,${panelImage.toString("base64")}"></div>`,
    );
    const composed = await page.evaluate(async () => {
      const a = document.querySelector<HTMLImageElement>("#reading")!;
      const b = document.querySelector<HTMLImageElement>("#panel")!;
      await Promise.all([a.decode(), b.decode()]);
      return {
        reading: { width: a.naturalWidth, height: a.naturalHeight },
        panel: { width: b.naturalWidth, height: b.naturalHeight },
        output: {
          width: a.naturalWidth + b.naturalWidth,
          height: Math.max(a.naturalHeight, b.naturalHeight),
        },
      };
    });
    expect(composed.reading.width).toBeGreaterThan(500);
    expect(composed.panel.width).toBeGreaterThan(200);
    expect(composed.output.width).toBe(composed.reading.width + composed.panel.width);
    await page.setViewportSize(composed.output);
    const displayedImage = await page
      .locator("#workspace")
      .screenshot({ animations: "disabled" });
    const stem = outputPath.replace(/\.png$/, "");
    const metadata = {
      method: "actual-page-and-native-side-panel-composite",
      browserToolbarIncluded: false,
      nativeSidePanel: true,
      reading: {
        ...composed.reading,
        sha256: createHash("sha256").update(pageImage).digest("hex"),
      },
      panel: {
        ...composed.panel,
        sha256: createHash("sha256").update(panelImage).digest("hex"),
      },
      output: composed.output,
    };
    await Promise.all([
      writeFile(outputPath, displayedImage),
      writeFile(stem + ".page.png", pageImage),
      writeFile(stem + ".sidepanel.png", panelImage),
      writeFile(stem + ".json", JSON.stringify(metadata, null, 2) + "\n"),
    ]);
    return metadata;
  } finally {
    await compositor.close();
  }
}
