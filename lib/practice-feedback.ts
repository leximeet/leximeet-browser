// 练习音效只在用户操作后本地合成，不联网、不携带单词和个人信息。
export type PracticeFeedback = "type" | "correct" | "incorrect";
export function createPracticeFeedback() {
  let context: AudioContext | undefined;
  let lastTick = 0,
    epoch = 0;
  const active = new Set<OscillatorNode>();
  function stop() {
    epoch++;
    for (const oscillator of active) {
      try {
        oscillator.stop();
      } catch {
        // 已结束的节点无需再次停止。
      }
    }
    active.clear();
  }
  async function play(kind: PracticeFeedback, enabled: boolean) {
    if (!enabled) return;
    const now = performance.now();
    if (kind === "type" && now - lastTick < 28) return;
    lastTick = now;
    const token = epoch;
    try {
      context ??= new AudioContext();
      if (context.state === "suspended") await context.resume();
      if (token !== epoch || context.state !== "running") return;
      // 正误音不被末尾字母的轻敲音覆盖；所有声音都用短包络，避免点击爆音。
      const notes =
        kind === "correct" ? [660, 880] : kind === "incorrect" ? [220, 165] : [520];
      const start = context.currentTime;
      for (const [index, frequency] of notes.entries()) {
        const oscillator = context.createOscillator(),
          gain = context.createGain();
        const at = start + index * 0.085,
          duration = kind === "type" ? 0.04 : 0.1;
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(kind === "type" ? 0.025 : 0.055, at + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
        oscillator.connect(gain).connect(context.destination);
        active.add(oscillator);
        oscillator.onended = () => {
          active.delete(oscillator);
          oscillator.disconnect();
          gain.disconnect();
        };
        oscillator.start(at);
        oscillator.stop(at + duration + 0.01);
      }
    } catch {
      // 音频被设备或浏览器阻止时，正误颜色与文字反馈照常可用。
    }
  }
  return {
    play,
    stop,
    dispose() {
      stop();
      void context?.close().catch(() => {});
      context = undefined;
    },
  };
}
