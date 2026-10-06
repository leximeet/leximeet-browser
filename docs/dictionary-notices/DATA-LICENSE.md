# 数据来源、许可与权利通知

仓库代码采用 [GPL-3.0](LICENSE)。词包汇集不同来源，使用方应保留随包的 `DATA-LICENSE.md`、`notice-*` 许可声明和音频清单中的逐文件署名。

| 数据 | 来源与适用说明 |
| --- | --- |
| 主词卡、同版 audit 与词遇中文审校 | [open-dictionary v2.0](https://github.com/ahpxex/open-dictionary)、English Wiktionary 贡献者、词遇维护者；按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 提供，并保留随包 `notice-OPEN-DICTIONARY-DATA-LICENSE.md`。词遇审校文件逐条保存旧值与核对页面。 |
| 高频功能词补充 | [Wiktionary / Kaikki / Wiktextract](https://kaikki.org/dictionary/rawdata.html)；按 CC BY-SA 4.0 署名。固定的 34 个逐词文件哈希和定位见 `sources/function-words.jsonl`。 |
| 中文及缺词回退 | [ECDICT](https://github.com/skywind3000/ECDICT) 与贡献者；保留随包 `notice-ECDICT-LICENSE.txt` 和来源说明。 |
| 概念与音素 | Open English WordNet / Princeton WordNet、CMUdict；保留随包对应的 `notice-*` 许可声明。 |
| 词书归属与顺序 | [qwerty-learner](https://github.com/RealKai42/qwerty-learner) 固定版本的词头、词书顺序、补充译文和原始音标；保留来源锁和 `notice-QWERTY-LEARNER-LICENSE.md`。 |
| AI 学习文章 | [DictionaryByGPT4](https://github.com/Ceelog/DictionaryByGPT4) 固定版本的学习文章候选；保留来源、审核状态和 `notice-DICTIONARYBYGPT4-LICENSE.md`，不作为基础释义。 |
| 真人离线录音 | [Wikimedia Commons](https://commons.wikimedia.org/)；436 条固定录音的原文件快照在 `sources/commons-audio-v0.0.1.tar.gz`；作者、许可链接、来源页和 SHA-256 在 `audio.lock.json` 与发布物 `audio-sources.json`，按逐文件许可署名。 |
| 合成离线录音 | 其余核心词头由 [eSpeak NG](https://github.com/espeak-ng/espeak-ng) 1.52.0 的 `en-us` 声线生成，经 [Opus](https://opus-codec.org/license/) 编码；音频索引用 `entry_id` 关联输入词头，并记录 `kind=synthetic`、拼读方式与哈希。工具版本和来源见随包 `notice-ESPEAK-NG-AND-OPUS.md`。合成音质与真人录音有差异，0.0.1 的非核心词没有随包音频。 |

感谢以上项目与贡献者。如认为某个词条、字段或录音侵犯权利，请联系作者并提供内容位置与依据。维护者核查后会移除或替换相应使用，并重建后续词包。

DictionaryByGPT4 与 qwerty-learner 从 0.0.2 起用于核心词的学习层。0.0.3 只对既有词卡和录音做无损压缩、精选与分层，没有引入新的数据源：lite 保留入选词的全部既有内容，core 保留全部核心词，full-text 再补非核心词卡。无音频组合不下载录音及其署名清单；有声组合随包提供逐文件音频来源。使用方仍应保留下载组合附带的许可声明，不应删除词卡中的来源与审核状态。
