# 设计决策

短 ADR。改这些方向之前先读对应不变量。

## ADR-001 — Fail-closed geolocation

**决定：** 同步开启且内容脚本仍在注入时，`getCurrentPosition` / `watchPosition` / `<geolocation>` 绝不把系统 GPS 交给页面。未知则 `pending` 或 `error`，不是 native。

**为什么：** MAIN world 与网页共享环境。页面能改 `__PLS_APPLY__`、CustomEvent、`enabled`。任何「trusted 开关」或 `enabled:false` 通道都会被伪造，从而泄漏真实定位。暂停自动同步如果恢复 GPS，页面也能发同样的消息。诚实限制：要回系统定位，关掉扩展。

## ADR-002 — Echo 与 Geo 解耦

**决定：** IP Echo 快速 ACK；Geo 后台跑。下一轮探测不等 Geo。同 IP 心跳不写 storage。

**为什么：** 2–5 秒要能发现切节点。地理库 4s 超时、失败重试、缓存命中都不能卡住 Echo。storage 写放大在 MV3 里会拖 SW / Event Page，同 IP 无新信息就不要写。`exitGeneration` 防止慢 Geo / 慢 persist 用旧出口覆盖新出口。

## ADR-003 — Chromium 用 Offscreen

**决定：** 短间隔轮询和 WebRTC ICE 放在 Offscreen 文档。SW 只做状态、注入、Offscreen 生命周期。Offscreen 失败才 SW `setTimeout` fallback，二者互斥。

**为什么：** MV3 service worker 会被杀。Offscreen 能跑 DOM 计时器和 `RTCPeerConnection`。理由用真实的 `WEB_RTC`（确实做 ICE），不用假 peer connection 保活。这条路径 1.3.1 保持稳定，不为 Firefox 改语义。

## ADR-004 — Firefox 用 alarms

**决定：** Firefox 用 `pls-firefox-poll`（`periodInMinutes = intervalSec/60`）。不模拟 Offscreen，不用 Event Page `setTimeout` 循环。generic load 不 Echo。

**为什么：** MDN 明确写 Event Page idle 后 DOM timer 不可靠，应 `browser.alarms` 唤醒。1.3.0 的 `startSwFallback()` 在 idle 后会停。alarms 不跨 session，所以 installed/startup/settings 要重建。load 再 Echo 会和 alarm 唤醒叠一次，所以 `prepareOnce` 与 `kickEcho` 分开。真实 2–5 秒频率仍未 E2E，文档必须保留这句话。

## ADR-005 — Worker probe 放在扩展 origin

**决定：** 诊断 Worker 只用打包的 `diagnostics/worker-probe.js`。目标网页 MAIN 不创建 Blob Worker。

**为什么：** Gemini / Telegram 等站点的 `worker-src` CSP 会挡住页面里的 Blob Worker，连累 PAGE_ENV。扩展 origin 不受那条 CSP 管。网页 Worker 本就打不进 content script，时区不一致记 warning，不是去「修」成和 Window 一样。

## ADR-006 — 不 spoof language / UA / Canvas / WebGL

**决定：** 只同步与出口相关的定位和时区。Locale / 字体 / UA 诊断只读。不改 Canvas/WebGL 指纹，不 hook `Function#toString`。

**为什么：** 那是 Anti-Detect Browser 的范围，和「出口 IP 与网页 API 一致」不是同一产品。改这些既增加检测面，也让失败模式变成「假装成另一个设备」。zh-CN 配东京出口可以是信息，不是错误。

## ADR-007 — 一套共享核心，不是两个仓库

**决定：** 同一份 `lib/`、`content/`、`background/service-worker.js`。平台差异：manifest overlay + `lib/browser-api.js` / `lib/platform-runtime.js` 的 feature detection。

**为什么：** Echo/Geo/fail-closed/Date 在两套 fork 里会立刻漂移。Chrome 116–120 与 Firefox 的后台字段又互斥，所以清单必须分开，代码必须能在缺 Offscreen / 缺 HTMLGeolocationElement 时跳过。禁止「为了 Firefox 绿而改 Chromium Offscreen」。缺 API 就跳过或标 Not supported，不要垫假实现。
