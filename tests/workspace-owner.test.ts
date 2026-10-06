import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readyWorkspaceMode } from "../lib/workspace-owner.ts";

describe("业务页面的资料归属就绪", () => {
  it("恢复独立连接状态但资料仍切换时，不提前初始化原独立页面", () => {
    assert.equal(readyWorkspaceMode({ mode: "independent", ownerReady: false }), null);
    assert.equal(
      readyWorkspaceMode({ mode: "independent", ownerReady: true }),
      "independent",
    );
  });
  it("配对状态已落盘但资料尚未封存完成时，不提前初始化桌面页面", () => {
    assert.equal(readyWorkspaceMode({ mode: "desktop", ownerReady: false }), null);
    assert.equal(readyWorkspaceMode({ mode: "desktop", ownerReady: true }), "desktop");
  });
  it("缺失或无效的就绪回执不默认进入任何业务页面", () => {
    assert.equal(readyWorkspaceMode(null), null);
    assert.equal(readyWorkspaceMode({ mode: "independent" }), null);
    assert.equal(readyWorkspaceMode({ mode: "unknown", ownerReady: true }), null);
  });
});
