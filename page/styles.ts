export const pageStyles = `
/* 公共词卡动作使用自己的主题颜色，避免新增采集按钮继承浏览器原生配色。 */
.card .capture{border:1px solid #8baf98;border-radius:6px;padding:6px 12px;min-height:32px;background:#edf5ef;color:#315c43;font-size:12px}.card .capture:disabled{opacity:.65;cursor:default}
:host([data-theme="dark"]) .card .capture{background:#315343;color:#e1ede5;border-color:#577e66}
@media(prefers-color-scheme:dark){:host(:not([data-theme="light"])) .card .capture{background:#315343;color:#e1ede5;border-color:#577e66}}
:host{all:initial!important;color-scheme:light dark!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;overflow:clip!important;z-index:2147483000!important;pointer-events:none!important;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif!important}
*{box-sizing:border-box}button{font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #6aaf87;outline-offset:3px}
.ball{position:fixed;right:22px;bottom:88px;width:46px;height:46px;border:1px solid #8baf98;border-radius:50%;background:#f6faf4;color:#397452;box-shadow:0 3px 15px #14261b22;font-size:20px;font-weight:700;pointer-events:auto;touch-action:none;user-select:none}.ball > svg{width:23px;height:23px;display:block;margin:auto}.ball-spinner{display:none;position:absolute;inset:5px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;pointer-events:none}.ball:is(.busy,.saving) .ball-spinner{display:block;animation:ball-spin .7s linear infinite}.ball.busy > svg{opacity:.4}.ball[aria-pressed="true"]{background:#18765d;color:#fff;border-color:#18765d}.ball[hidden],.card[hidden],.collector-card[hidden],.notice[hidden]{display:none}
.ball-tip{position:fixed;display:flex;align-items:center;gap:7px;max-width:calc(100vw - 12px);min-height:36px;padding:5px 7px 5px 10px;border:1px solid #c8dacb;border-radius:8px;background:#f6faf4;color:#315c43;box-shadow:0 5px 22px #14261b22;pointer-events:auto;white-space:nowrap;font-size:10px}.ball-tip[hidden]{display:none}
.ball{opacity:.65;transition:transform 180ms ease,opacity 180ms ease}.ball[data-side="right"]{transform:translateX(28px)}.ball[data-side="left"]{transform:translateX(-28px)}.ball:is(.expanded,.locked,.dragging,:focus-visible){transform:none;opacity:1}.ball.dragging{transition:none;cursor:grabbing}.ball-tip{display:block;width:200px;padding:10px;white-space:normal;font-size:11px}.ball-tip>span{display:block;font-weight:600;line-height:1.5}
/* 展开时保留原半隐藏位置的悬停区域，避免圆球滑离静止指针后立即收起。 */
.ball.expanded::after{content:"";position:absolute;top:-1px;bottom:-1px;width:28px}.ball.expanded[data-side="right"]::after{left:100%}.ball.expanded[data-side="left"]::after{right:100%}
:is(.card,.collector-card){position:fixed;width:300px;max-width:calc(100vw - 24px);border:1px solid #dce5dd;border-radius:12px;background:#fafcf8;color:#24392e;box-shadow:0 8px 32px #14261b25;padding:15px 17px;pointer-events:auto;line-height:1.6;max-height:min(420px,calc(100vh - 24px));overflow:auto}.word{font-size:21px;font-weight:650}.phonetic{font-size:12px;color:#64756a;margin:2px 0 8px}.meaning{font-size:13px;white-space:pre-line}.sentence{border-top:1px solid #e0e7df;margin-top:10px;padding-top:10px;font-size:12px;color:#69756c}.note{font-size:10px;color:#7a887d;margin-top:8px}.speak{margin-top:8px;min-height:28px;padding:4px 10px;border-radius:6px;border:1px solid #8baf98;background:#eef6ef;color:#2f5d42;font-size:12px}.notice{position:fixed;bottom:24px;left:50vw;transform:translateX(-50%);max-width:460px;padding:9px 15px;border:1px solid #c8dacb;border-radius:8px;color:#315c43;background:#f6faf4;font-size:12px;line-height:1.6;pointer-events:none}.notice strong{font-weight:650}.notice small{display:block;color:#6e7e72}.capture{background:#f8f4e9;border-color:#dbcfad;color:#65552b}@keyframes breathe{to{opacity:.55}}@keyframes ball-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.ball:is(.busy,.saving) .ball-spinner{animation:none}}@media(prefers-color-scheme:dark){:host(:not([data-theme="light"])) :is(.ball,.card,.collector-card,.notice){background:#1e2a24;color:#dce9de;border-color:#46594a}:host(:not([data-theme="light"])) :is(.phonetic,.sentence,.note,.notice small){color:#9eafa1}:host(:not([data-theme="light"])) .sentence{border-color:#3b4b3f}:host(:not([data-theme="light"])) .speak{background:#2a382f;color:#dce9de;border-color:#46594a}:host(:not([data-theme="light"])) .capture{background:#302c20;color:#e7d6a3}}
/* 发音与词头同排，图标沿用按钮文字颜色，明暗主题不依赖外部图片滤镜。 */
.card{box-sizing:border-box}.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.card-head .word{min-width:0;overflow-wrap:anywhere}.card-head .speak{display:grid;place-items:center;flex:0 0 32px;width:32px;height:32px;margin:0;padding:6px;border-radius:50%}.card-head .speak svg{display:block;width:18px;height:18px}.card-head .speak:hover{filter:brightness(.94)}

:host([data-theme="dark"]) :is(.ball,.card,.collector-card,.notice){background:#1e2a24;color:#dce9de;border-color:#46594a}:host([data-theme="dark"]) :is(.phonetic,.sentence,.note,.notice small){color:#9eafa1}
:host([data-theme="dark"]) .sentence{border-color:#3b4b3f}:host([data-theme="dark"]) .speak{background:#2a382f;color:#dce9de;border-color:#46594a}
:host([data-theme="dark"]) .ball-tip{background:#1e2a24;color:#dce9de;border-color:#46594a}
@media(prefers-color-scheme:dark){:host(:not([data-theme="light"])) .ball-tip{background:#1e2a24;color:#dce9de;border-color:#46594a}}
@media(prefers-reduced-motion:reduce){.ball{transition:none}}
.pick-lens{position:fixed;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 9px;border:1px solid #8db5a0;border-radius:6px;background:#f6faf4;color:#245e46;font:600 16px Georgia,serif;pointer-events:none;box-shadow:0 3px 12px #163f2420}.pick-lens[hidden]{display:none}:host([data-theme="dark"]) .pick-lens{background:#24352c;color:#e1ede5;border-color:#577e66}
@media(prefers-color-scheme:dark){:host(:not([data-theme="light"])) .pick-lens{background:#24352c;color:#e1ede5;border-color:#577e66}}
.pick-flight{position:fixed;padding:7px 13px;background:#18765d;color:#fff;border:1px solid #76bea6;border-radius:22px;font:600 18px Georgia,serif;box-shadow:0 4px 18px #184c3540;pointer-events:none;white-space:nowrap;z-index:3}
.page-guide{position:fixed;width:282px;max-width:calc(100vw - 24px);padding:17px 18px;background:#f7fcf8;color:#253b31;border:1px solid #9ac5b2;border-radius:12px;box-shadow:0 12px 32px #164b3530;pointer-events:none;line-height:1.6;font-size:13px;z-index:5}.page-guide small{display:block;color:#28785d;font-size:10px;letter-spacing:.04em;margin-bottom:8px}.page-guide strong{display:block;font-size:15px}.page-guide p{margin:8px 0 10px}.page-guide button{pointer-events:auto;padding:3px 0;color:#377e64;background:transparent;border:0;font-size:11px}.page-guide-line{position:fixed;inset:0;width:100%;height:100%;overflow:visible;color:#278261;pointer-events:none;z-index:4}.page-guide-line path{stroke:currentColor;stroke-width:1.7;fill:none}.page-guide[hidden],.page-guide-line[hidden]{display:none}
:host([data-theme="dark"]) .page-guide{background:#24352c;color:#e1ede5;border-color:#577e66}:host([data-theme="dark"]) .page-guide :is(small,button){color:#9cc9b4}
@media(prefers-color-scheme:dark){:host(:not([data-theme="light"])) .page-guide{background:#24352c;color:#e1ede5;border-color:#577e66}:host(:not([data-theme="light"])) .page-guide :is(small,button){color:#9cc9b4}}
@media print{.ball,.ball-tip,.card,.collector-card,.notice,.page-guide,.page-guide-line,.pick-lens,.pick-flight{display:none!important}}

.page-guide { box-sizing:border-box; }
.page-guide header { display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:grab;pointer-events:auto;touch-action:none;user-select:none;margin-bottom:8px; }
.page-guide header:active { cursor:grabbing; }.page-guide header:focus-visible { outline:2px solid #278261;outline-offset:4px; }
.page-guide header small { margin:0; }.page-guide-tools { display:flex;gap:8px; }.page-guide-tools button { font-size:18px;width:22px;height:24px;padding:0; }
.page-guide [hidden] { display:none!important; }.page-guide-actions { display:flex;gap:12px;justify-content:space-between; }.page-guide[data-collapsed="true"] { padding:10px 14px; }.page-guide[data-collapsed="true"] header { margin:0; }
/* 固定图标与打开侧栏是两个连续动作，独立整行展示；跳过保持次要。 */
.page-guide:is([data-step="pin"],[data-step="panel"]) .page-guide-actions { display:grid;grid-template-columns:1fr 1fr;gap:8px; }
.page-guide:is([data-step="pin"],[data-step="panel"]) .page-guide-actions button:not(.page-guide-skip) { grid-column:1/-1;border:1px solid currentColor;border-radius:6px;padding:7px 8px;font-size:12px; }
.page-guide:is([data-step="pin"],[data-step="panel"]) .page-guide-skip { grid-column:2;justify-self:end;min-height:28px; }
.page-guide button:disabled { opacity:.4;cursor:not-allowed; }
.page-guide-celebration { position:fixed;inset:0;pointer-events:none;z-index:6;overflow:hidden; }.page-guide-celebration[hidden] { display:none; }
.page-guide-celebration i { position:absolute;left:50%;top:30%;width:5px;height:5px;border-radius:50%;background:#4d9b77;animation:lesson-spark 1.5s ease-out both;transform:rotate(var(--angle)); }
.page-guide-celebration i:nth-child(3n) { background:#d8b877; }.page-guide-celebration i:nth-child(3n+1) { background:#7db4ce; }
@keyframes lesson-spark { from { opacity:1;transform:rotate(var(--angle)) translateY(0); } to { opacity:0;transform:rotate(var(--angle)) translateY(-160px); } }
@media(prefers-reduced-motion:reduce) { .page-guide-celebration { display:none; } }
/* 拖拽时鼠标命中正文，收集器与描边层不拦截命中。 */
.ball.dragging,.ball.dragging::after,.collector-card {pointer-events:none!important}
/* 小型收集器跟随指针；选择框标明一个词，不重绘文字。 */
.ball.collector-active{background:transparent!important;border-color:transparent!important;box-shadow:none!important;opacity:1}.ball.collector-active > svg,.ball.collector-active .ball-spinner{display:none}
.word-collector{position:fixed;display:grid;place-items:center;box-sizing:border-box;width:32px;height:32px;border:1px solid #cad7cf;border-radius:8px;background:#f6faf7;color:#7d8c84;box-shadow:0 3px 10px #153b2520;pointer-events:none;z-index:2}
.word-collector svg{width:21px;height:21px}.word-collector.ready{background:#18765d;color:#fff;border-color:#18765d}.word-collector[hidden],.word-target[hidden]{display:none}
.word-target{position:fixed;inset:0;pointer-events:none;z-index:1}.word-target>span{position:fixed;box-sizing:border-box;border:2px solid #2889cf;border-radius:3px;box-shadow:0 0 0 1px #fff;background:#2889cf24;pointer-events:none}
.collector-card{z-index:3}.collector-hint{margin-top:12px;padding-top:9px;border-top:1px solid #8baf9855;font-size:11px;color:inherit}
:host([data-theme="dark"]) .word-collector:not(.ready){background:#24352c;color:#b7c9bc;border-color:#577e66}
@media(prefers-color-scheme:dark){:host(:not([data-theme="light"])) .word-collector:not(.ready){background:#24352c;color:#b7c9bc;border-color:#577e66}}
@media print{.word-collector,.word-target{display:none!important}}
.ball.saving > svg{opacity:.4}

.page-guide-pin-steps{padding:12px 0;margin:12px 0;border-block:1px solid #8baf9840;list-style:none;display:grid;gap:14px}.page-guide-pin-steps li{display:flex;align-items:center;gap:10px;font-size:12px}.page-guide-pin-steps svg{display:block;width:22px;height:22px;color:#18765d}.page-guide-pin-steps span:first-child{padding:6px;border-radius:7px;background:#18765d0e}
.page-guide .page-guide-primary{background:#18765d!important;color:#fff!important;border:1px solid #18765d!important;min-height:36px;padding:7px 10px;border-radius:6px;font-size:12px}.page-guide .page-guide-primary:focus-visible{outline:2px solid #2889cf;outline-offset:3px}
.page-guide-flow{display:grid;grid-template-columns:1fr 1fr;gap:8px;list-style:none;padding:10px 0;margin:10px 0 8px;counter-reset:guide-step;border-top:1px solid #8baf9840}.page-guide-flow li{font-size:11px;color:#778a7e;counter-increment:guide-step}.page-guide-flow li:before{content:counter(guide-step);display:inline-grid;place-items:center;width:19px;height:19px;border-radius:50%;border:1px solid #8baf9860;margin-right:6px}.page-guide-flow li[aria-current="step"]{color:#18765d;font-weight:650}.page-guide-flow li[aria-current="step"]:before{background:#18765d;color:white;border-color:#18765d}.page-guide-flow li.done{color:#4e8067}
:host([data-theme="dark"]) .page-guide-flow li[aria-current="step"]{color:#bce3ce}:host([data-theme="dark"]) .page-guide-pin-steps svg{color:#9cc9b4}
@media(prefers-color-scheme:dark){:host(:not([data-theme="light"])) .page-guide-flow li[aria-current="step"]{color:#bce3ce}:host(:not([data-theme="light"])) .page-guide-pin-steps svg{color:#9cc9b4}}
`;

// 只属于词遇 ShadowRoot 的批注控件；标题栏可拖动，窗口收起不终止教学。
