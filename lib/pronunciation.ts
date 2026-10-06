import type { PronunciationSettings } from "./workspace-model.ts";
export type AudioState = {
  phase: "idle" | "loading" | "playing" | "ended" | "error";
  word?: string;
  message?: string;
};
// 公开词头音频地址，不发送页面正文、笔记、账号或遇见记录。
export function pronunciationUrl(word: string, settings: PronunciationSettings): string {
  const text = word.normalize("NFKC").trim();
  if (!text || text.length > 160) throw new Error("词头无效");
  if (settings.provider === "youdao") {
    const url = new URL("https://dict.youdao.com/dictvoice");
    url.searchParams.set("audio", text);
    url.searchParams.set("type", settings.accent === "uk" ? "1" : "2");
    return url.href;
  }
  const template = settings.customUrl;
  let url: URL;
  try {
    url = new URL(template.replaceAll("{word}", encodeURIComponent(text)));
  } catch {
    throw new Error("请输入带 {word} 的 HTTPS 音频地址");
  }
  if (
    [...url.searchParams.keys()].some((k) =>
      /token|password|credential|signature|secret|(^|[._-])(key|auth)($|[._-])/i.test(k),
    ) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !template.includes("{word}") ||
    /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|169\.254\.|\[.*\])/.test(
      url.hostname,
    )
  )
    throw new Error("自定义发音需公开 HTTPS 音频地址，不能包含账号密码或本机地址");
  return url.href;
}
// 每个扩展页面只保留一个播放器；真实 playing 事件才表示开始，切页/换词终止旧请求。
export function createPronunciationPlayer(
  audioFactory: () => HTMLAudioElement,
  onChange: (s: AudioState) => void,
  timeoutMs = 12000,
) {
  let dispose: (() => void) | null = null,
    sequence = 0;
  const stop = () => {
    sequence++;
    dispose?.();
    dispose = null;
    onChange({ phase: "idle" });
  };
  async function play(word: string, settings: PronunciationSettings) {
    stop();
    const id = sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => id === sequence;
    try {
      const url = pronunciationUrl(word, settings),
        audio = audioFactory();
      const fail = (e: unknown) => {
        if (!valid()) return;
        dispose?.();
        dispose = null;
        sequence++;
        onChange({
          phase: "error",
          word,
          message:
            (e as Error)?.name === "NotAllowedError"
              ? "请点击喇叭开始发音"
              : (e as Error)?.message || "发音加载失败，请检查网络",
        });
      };
      const playing = () => {
          if (valid()) {
            clearTimeout(timer);
            // 已开始播放也可能网络中断而不触发 ended；必须释放等待发音的练习游标。
            timer = setTimeout(() => fail(new Error("发音播放超时")), timeoutMs);
            onChange({ phase: "playing", word });
          }
        },
        ended = () => {
          if (valid()) {
            dispose?.();
            dispose = null;
            onChange({ phase: "ended", word });
          }
        },
        error = () => fail(new Error("发音加载失败，请检查网络后重试"));
      dispose = () => {
        clearTimeout(timer);
        audio.removeEventListener("playing", playing);
        audio.removeEventListener("ended", ended);
        audio.removeEventListener("error", error);
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        audio.remove();
      };
      audio.addEventListener("playing", playing);
      audio.addEventListener("ended", ended);
      audio.addEventListener("error", error);
      audio.playbackRate = settings.rate;
      audio.preload = "auto";
      audio.src = url;
      onChange({ phase: "loading", word });
      timer = setTimeout(() => fail(new Error("发音请求超时")), timeoutMs);
      try {
        await audio.play();
      } catch (e) {
        fail(e);
      }
    } catch (e) {
      if (valid()) onChange({ phase: "error", word, message: (e as Error).message });
    }
  }
  return { play, stop };
}

// 公开设置和 JSON 备份只允许无凭据的音频模板，闲置模板也按同一规则检查。
export function validAudioTemplate(template: string): boolean {
  if (!template) return true;
  try {
    pronunciationUrl("resilient", {
      provider: "custom",
      accent: "us",
      rate: 1,
      customUrl: template,
    });
    return true;
  } catch {
    return false;
  }
}
