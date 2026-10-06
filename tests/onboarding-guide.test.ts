import test from "node:test";
import assert from "node:assert/strict";
import {
  OnboardingGuide,
  GUIDE_STEPS,
  emptyGuide,
  guideStep,
  validGuide,
  type GuideState,
} from "../lib/onboarding-guide.ts";

// 这里验证状态机的事件顺序；真实图钉、侧栏、Range 与 IndexedDB 另由浏览器用例验证。
function fixture(initial?: GuideState) {
  let saved: unknown = initial,
    pinned = false,
    ready = false,
    finished = 0;
  const guide = new OnboardingGuide({
    load: async () => saved,
    save: async (state) => {
      saved = structuredClone(state);
    },
    pinned: async () => pinned,
    planReady: async () => ready,
    finish: async () => {
      finished++;
    },
  });
  return {
    guide,
    pin: () => {
      pinned = true;
    },
    plan: () => {
      ready = true;
    },
    get finished() {
      return finished;
    },
  };
}
const location = { windowId: 3, tabId: 7 };
test("引导按真实事件顺序推进，固定前打开、错误窗口和未完成保存均不跳关", async () => {
  const f = fixture();
  await f.guide.start();
  await f.guide.record("toolbar", location);
  assert.equal(guideStep(await f.guide.status()), "pin");
  await f.guide.record("capture", location);
  f.pin();
  assert.equal(guideStep(await f.guide.status()), "panel");
  await f.guide.record("toolbar", location);
  assert.equal(guideStep(await f.guide.record("plan")), "plan");
  f.plan();
  assert.equal(guideStep(await f.guide.record("plan")), "plan");
  await f.guide.record("workspace", { windowId: 8 });
  assert.equal(guideStep(await f.guide.status()), "plan");
  await f.guide.record("workspace", location);
  assert.equal(guideStep(await f.guide.status()), "plan");
  await f.guide.record("plan", location);
  assert.equal(guideStep(await f.guide.status()), "encounter");
  await f.guide.record("encounter", { windowId: 8 });
  assert.equal(guideStep(await f.guide.status()), "encounter");
  await f.guide.record("word-card", location);
  assert.equal(guideStep(await f.guide.status()), "encounter");
  await f.guide.record("encounter", location);
  assert.equal(guideStep(await f.guide.status()), "encounter");
  assert.equal((await f.guide.status()).encounterAnalyzed, true);
  await f.guide.record("word-card", { windowId: 3, tabId: 8 });
  assert.equal(guideStep(await f.guide.status()), "encounter");
  await f.guide.record("word-card", location);
  assert.equal(guideStep(await f.guide.status()), "capture");
  await f.guide.record("capture", location);
  assert.equal(guideStep(await f.guide.status()), "floating");
  await f.guide.record("reopened", location);
  await f.guide.record("analyzed", location);
  assert.equal(f.finished, 0);
  await f.guide.record("closed", location);
  await f.guide.record("analyzed", location);
  assert.equal((await f.guide.status()).floating.analyzed, true);
  await f.guide.record("hovered", location);
  await f.guide.record("analyzed", location);
  await f.guide.record("reopened", { windowId: 8 });
  assert.equal(f.finished, 0);
  await f.guide.record("reopened", location);
  assert.equal(f.finished, 0);
  await f.guide.record("deactivated", location);
  await f.guide.record("reopened", location);
  assert.equal(f.finished, 0);
  await f.guide.record("collector-captured", { windowId: 3, tabId: 88 });
  assert.equal((await f.guide.status()).floating.captured, false);
  await f.guide.record("collector-captured", location);
  const reopened = await f.guide.record("reopened", location);
  assert.equal(guideStep(reopened), "floating");
  assert.equal(reopened.floating.reclosed, false);
  assert.equal(f.finished, 0);
  await f.guide.record("closed", { windowId: 8 });
  assert.equal(f.finished, 0);
  const end = await f.guide.record("closed", location);
  assert.equal(guideStep(end), "complete");
  assert.equal(end.active, false);
  await f.guide.record("reopened", location);
  assert.equal(f.finished, 1);
});
test("暂停后可续接，不用手动确认伪造完成；重新开始仅清空引导状态", async () => {
  const f = fixture();
  await f.guide.start();
  f.pin();
  await f.guide.status();
  await f.guide.record("toolbar", location);
  const paused = await f.guide.pause();
  assert.equal(paused.active, false);
  await f.guide.record("workspace", location);
  assert.equal((await f.guide.status()).workspaceOpened, false);
  const restarted = fixture(paused);
  assert.equal(guideStep(await restarted.guide.resume()), "plan");
  assert.deepEqual((await restarted.guide.start()).completed, []);
});
test("并发状态查询不会覆盖步骤，写失败后仍能读取并继续", async () => {
  let saved: unknown = emptyGuide(true),
    fail = true;
  const guide = new OnboardingGuide({
    load: async () => saved,
    save: async (s) => {
      if (fail) throw new Error("storage failure");
      saved = s;
    },
    pinned: async () => true,
    planReady: async () => false,
    finish: async () => {},
  });
  await assert.rejects(guide.status(), /storage failure/);
  fail = false;
  const results = await Promise.all([
    guide.status(),
    guide.status(),
    guide.record("toolbar", location),
  ]);
  assert.deepEqual(results[2].completed, ["pin", "panel"]);
});
test("拒绝跳步或非法序列的存储状态", () => {
  assert.equal(validGuide(emptyGuide()), true);
  assert.equal(validGuide({ ...emptyGuide(), completed: ["capture"] }), false);
  assert.equal(validGuide({ ...emptyGuide(), readingTabId: NaN }), false);
  assert.equal(validGuide({ ...emptyGuide(), floating: {} }), false);
});

test("重复安装初始化不覆盖跳过或完成的教学，并发初始化只返回一次首次安装", async () => {
  const fresh = fixture();
  assert.deepEqual(
    await Promise.all([
      fresh.guide.initializeOnInstall(),
      fresh.guide.initializeOnInstall(),
    ]),
    [true, false],
  );
  assert.equal((await fresh.guide.status()).active, true);
  const paused = await fresh.guide.pause();
  const reopened = fixture(paused);
  assert.equal(await reopened.guide.initializeOnInstall(), false);
  assert.deepEqual(await reopened.guide.status(), paused);
  const completed = { ...emptyGuide(), completed: [...GUIDE_STEPS] };
  const installed = fixture(completed);
  assert.equal(await installed.guide.initializeOnInstall(), false);
  assert.deepEqual(await installed.guide.status(), completed);
  // 主动重新进入仍能从头开始，不受首次初始化保护影响。
  assert.deepEqual((await installed.guide.start()).completed, []);
});

test("暂不固定也能继续教学，略过状态独立保留，重进不改 Chrome 固定事实", async () => {
  const f = fixture();
  await f.guide.start();
  const continued = await f.guide.continueWithPanel(location);
  assert.equal(guideStep(continued), "plan");
  assert.equal(continued.pinSkipped, true);
  assert.equal(continued.readingTabId, location.tabId);
  assert.equal(continued.active, true);
  assert.equal(guideStep(await f.guide.continueWithPanel(location)), "plan");
  await f.guide.pause();
  assert.equal((await f.guide.continueWithPanel(location)).active, false);
  await f.guide.start();
  assert.equal(guideStep(await f.guide.status()), "pin");
  f.pin();
  await f.guide.status();
  assert.equal(guideStep(await f.guide.continueWithPanel(location)), "plan");
  assert.notEqual((await f.guide.status()).pinSkipped, true);
});
