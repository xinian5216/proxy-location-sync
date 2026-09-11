# Agent 代码导航

按模块定位。说明在 [ARCHITECTURE.md](ARCHITECTURE.md) / [INVARIANTS.md](INVARIANTS.md)。路径相对仓库根。

读序：仓库根 `AGENTS.md` → 本文件 → [INVARIANTS.md](INVARIANTS.md) → 相关源码与测试。

## IP polling

| | 路径 |
| --- | --- |
| 探测 | `lib/ip-providers.js` `lib/ip-compare.js` `lib/provider-health.js` `lib/net.js` |
| 调度 | `lib/poll-sleep.js` `lib/poller-mode.js` `lib/echo-stale.js` `lib/detect-session.js` |
| 管线 | `lib/exit-pipeline.js` `lib/detect-engine.js` `background/service-worker.js` |
| 常量 | `lib/constants.js`（`IP_ECHO_TIMEOUT_MS` `ECHO_STALE_MS` `INTERVAL_CHOICES`） |
| 测试 | `tests/ip-compare.test.js` `tests/exit-pipeline.test.js` `tests/detect-race.test.js` |

## Geo

| | 路径 |
| --- | --- |
| 查询 / 坐标 | `lib/geo-providers.js` `lib/geo.js` `lib/geo-mode.js` |
| 缓存 / 世代 | `lib/detect-engine.js` `lib/exit-pipeline.js` |
| 测试 | `tests/detect-race.test.js` `tests/exit-pipeline.test.js` `tests/stability.test.js` |

## MAIN world

| | 路径 |
| --- | --- |
| 注入 | `content/injected.js`（MAIN） `content/isolated.js`（storage → `__pls_v1`） |
| 补注 | `background/service-worker.js`（`injectBootstrap` / `webNavigation.onCommitted`） |
| 测试 | `tests/mainworld-112.test.js` `tests/source-guard.test.js` `tests/lifecycle-112.test.js` `tests/cross-browser-130.test.js` |
| 夹具 | `tests/frames.html` |

## Geolocation

| | 路径 |
| --- | --- |
| 状态机 | `lib/geolocation-gate.js` `lib/geo-mode.js` |
| `<geolocation>` | `lib/html-geo-element.js` `content/injected.js` |
| 标签 | `lib/platform-runtime.js`（`htmlGeolocationLabel`） |
| 测试 | `tests/geolocation-gate.test.js` `tests/mainworld-112.test.js` `tests/lifecycle-112.test.js` |
| 夹具 | `tests/geolocation-element.html` |

## Date / Intl

| | 路径 |
| --- | --- |
| 时区数学 | `lib/timezone.js` |
| 补丁 | `content/injected.js` |
| 测试 | `tests/timezone-dst.test.js` `tests/mainworld-112.test.js` `tests/cross-browser-130.test.js` |

## Diagnostics

| | 路径 |
| --- | --- |
| 评估 | `lib/diagnostics.js` |
| 编排 | `lib/diagnostics-runner.js` |
| Worker | `lib/worker-probe.js` `diagnostics/worker-probe.js` |
| UI | `diagnostics/diagnostics.html` `diagnostics/diagnostics.js` `diagnostics/diagnostics.css` `popup/popup.js` |
| 测试 | `tests/diagnostics.test.js` `tests/mainworld-112.test.js` |

## DNS

| | 路径 |
| --- | --- |
| 源 | `lib/dns-providers.js` |
| TTL / 抢占 | `lib/diagnostics-runner.js` `lib/constants.js`（`DNS_CACHE_MS` `DNS_FAIL_CACHE_MS` `ALARM_DNS`） |
| 测试 | `tests/diagnostics.test.js` |

## WebRTC

| | 路径 |
| --- | --- |
| 分类 | `lib/webrtc.js` |
| 路由 | `lib/platform-runtime.js` `background/service-worker.js`（`routeWebrtc`） |
| Chromium 执行 | `offscreen/offscreen.js` |
| 测试 | `tests/webrtc.test.js` `tests/lifecycle-112.test.js` `tests/cross-browser-130.test.js` |

## Badge

| | 路径 |
| --- | --- |
| 角标 | `lib/badge.js` |
| 恢复 | `background/service-worker.js`（`prepare` → hydrate → `refreshAction`） |
| 测试 | `tests/badge.test.js` `tests/source-guard.test.js` `tests/cross-browser-130.test.js` |

## Firefox runtime

| | 路径 |
| --- | --- |
| Alarm 计划 | `lib/firefox-poll.js` |
| 适配 | `lib/browser-api.js` `lib/platform-runtime.js` |
| 接线 | `background/service-worker.js`（`prepareOnce` `ensureFirefoxPollAlarm` `onFirefoxPoll`） |
| 清单 | `manifests/firefox.json` `manifests/base.json` |
| 常量 | `lib/constants.js`（`ALARM_FIREFOX_POLL`） |
| 测试 | `tests/firefox-poll.test.js` `tests/browser-api.test.js` `tests/platform-runtime.test.js` `tests/cross-browser-130.test.js` |

## Chromium Offscreen

| | 路径 |
| --- | --- |
| 文档 | `offscreen/offscreen.html` `offscreen/offscreen.js` |
| 互斥 | `lib/poller-mode.js` `lib/poll-sleep.js` |
| 接线 | `background/service-worker.js`（`ensureOffscreen` `startSwFallback`；仅 Offscreen 失败） |
| 清单 | `manifests/chromium.json` `manifests/base.json` |
| 测试 | `tests/exit-pipeline.test.js` `tests/stability.test.js` `tests/source-guard.test.js` |

## Platform adapter

| | 路径 |
| --- | --- |
| `ext` / feature detect | `lib/browser-api.js` |
| 轮询 / WebRTC / Worker 路由 | `lib/platform-runtime.js` |
| UI 用 `ext` | `popup/popup.js` `options/options.js` `diagnostics/diagnostics.js` |
| 测试 | `tests/browser-api.test.js` `tests/platform-runtime.test.js` `tests/source-guard.test.js` |

## Build

| | 路径 |
| --- | --- |
| 打包 | `scripts/build-extension.mjs` `package.json` |
| 清单 | `manifests/base.json` `manifests/chromium.json` `manifests/firefox.json` `manifest.json`（生成的 Chromium 开发清单） |
| 测试 | `tests/source-guard.test.js` `tests/cross-browser-130.test.js` `tests/stability.test.js` |

`copyTree` 打进 zip 的目录：`background` `content` `diagnostics` `icons` `lib` `offscreen` `options` `popup` `tests` `manifests` `scripts`，以及 `LICENSE` `README.md` `package.json`。`docs/`、`AGENTS.md`、`agent-index.json` **不进 zip**。

## Tests（清单）

| 文件 | 覆盖 |
| --- | --- |
| `tests/ip-compare.test.js` | IP 规范化、provider health、IPv6 |
| `tests/exit-pipeline.test.js` | Echo/Geo 解耦、generation、offscreen sleep |
| `tests/detect-race.test.js` | latest wins、geo cache、lookup 绑定 IP |
| `tests/geolocation-gate.test.js` | fail-closed、切换、权限 |
| `tests/mainworld-112.test.js` | 真正执行 `content/injected.js`：trusted、Date、HTMLGeo、PAGE_ENV |
| `tests/timezone-dst.test.js` | Date/Intl helper |
| `tests/diagnostics.test.js` | 诊断评估、DNS、manual/auto、Worker |
| `tests/webrtc.test.js` | ok/leak/unknown、绑定当前出口 |
| `tests/badge.test.js` | SW 重建恢复角标 |
| `tests/firefox-poll.test.js` | alarm、load 不重复 Echo、慢 Geo |
| `tests/browser-api.test.js` | `ext` / feature detect |
| `tests/platform-runtime.test.js` | Offscreen vs background 路由 |
| `tests/cross-browser-130.test.js` | 两套 manifest、原生 Date.parse |
| `tests/source-guard.test.js` | 权限、fail-closed、1.3.1 zip 含 build 脚本 |
| `tests/stability.test.js` | Offscreen/fallback 互斥、iframe 夹具 |
| `tests/lifecycle-112.test.js` | tab 发现、HTMLGeo helper、echo stale |
| `tests/frames.html` | iframe 夹具（需 http(s)） |
| `tests/geolocation-element.html` | Chrome 144+ 夹具 |

命令：`npm test`。当前条数见 [CURRENT_STATE.md](CURRENT_STATE.md)。
