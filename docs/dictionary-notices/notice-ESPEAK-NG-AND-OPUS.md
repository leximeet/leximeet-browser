# 合成音频工具声明

词遇 0.0.1 的合成离线发音由 [eSpeak NG](https://github.com/espeak-ng/espeak-ng) 1.52.0 的 `en-us` 声线生成。eSpeak NG 软件以 GPL-3.0-or-later 发布。本词包保留其名称、版本、声线和逐词 `kind=synthetic` 标记；真人录音另按 `audio-sources.json` 逐文件署名。

音频由 [Xiph.Org opus-tools / opusenc](https://github.com/xiph/opus-tools) 0.2 和 libopus 1.6.1 编码为 Ogg Opus。Opus 编解码与工具的授权说明见 [Opus 官方许可页](https://opus-codec.org/license/)和对应源码。本词包不内置 eSpeak NG 或 opusenc 可执行程序。
