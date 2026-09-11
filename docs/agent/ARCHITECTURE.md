# 架构

当前 1.3.1 的数据流。约束写在 [INVARIANTS.md](INVARIANTS.md)，现状写在 [CURRENT_STATE.md](CURRENT_STATE.md)。

## 总览

```
代理软件切节点（扩展不读取其配置）
        │  浏览器网络栈变了
        ▼
IP Echo（只问公网 IP，快速 ACK）
  Chromium：Offscreen 自调度，等 Echo ACK + interval，不等 Geo
  Firefox：alarm `pls-firefox-poll` 每次触发一次 Echo
        │
        ▼
background 内存管线  lib/exit-pipeline.js
  同 IP + geo ready → 心跳，不写 storage
  新 IP → ++exitGeneration，abort 旧 Geo，开新 Geo
        │
        ▼
storage.local  { settings, state, geoCache, diagnostics }
        │  storage.onChanged
        ▼
content/isolated.js  →  CustomEvent __pls_v1（不可信）
        ▼
content/injected.js  MAIN
  geolocation: pending | ready | error（永不因页面字段回到系统 GPS）
  Date / Intl / Temporal.Now
  HTMLGeolocationElement（有则补丁；没有则跳过）
```

检测绑定的是 **这次 Echo 请求实际使用的出口**，不是「随便一个地理接口的出口」。

## 共享核心

同一份 `background/service-worker.js`、`lib/*`、`content/*`。平台差异用 feature detection，不靠 UA 硬分叉业务：

- `lib/browser-api.js` — `resolveExtApi()`：有 `browser.runtime` 用 `browser`，否则 `chrome`。业务代码用 `ext`。
- `lib/platform-runtime.js` — `pickBackgroundPoller` / `runWebrtcProbe` / `runWorkerProbe` / `htmlGeolocationLabel`。
- `manifests/base.json` 共享 content_scripts、host_permissions、action。
- overlay 决定后台形态：Chromium `service_worker` + `offscreen`；Firefox `scripts` + `persistent: false`，无 `offscreen`。

Chrome 116–120 不能在同一份 MV3 清单里同时写 `background.scripts` 和 `background.service_worker`。Firefox 没有 `background.service_worker`（MDN / bug 1573659）。所以必须两套 overlay。

## Chromium

1. SW 启动 → `boot("load")` → `prepareOnce`（hydrate、恢复 badge、keepalive/DNS alarm、`startPolling`）→ **立即 Echo**。
2. `startPolling`：`ensureOffscreen()`，让 Offscreen 按 `intervalSec` 自调度。
3. Offscreen 一轮：`detectPublicIp` → `IP_ECHO` ACK → 睡 `intervalSec`（冷却时最长 30s）→ 下一轮。**不 await Geo。**
4. Offscreen 创建失败才 `startSwFallback()`（`setTimeout` 循环）。Offscreen 一旦恢复，立刻停 fallback（`lib/poller-mode.js`）。
5. WebRTC / packaged Worker 在 Offscreen 文档里跑。
6. `pls-keepalive` 每分钟、`pls-dns` 每 15 分钟。

## Firefox

没有 `chrome.offscreen`，Event Page 也不是 persistent。

MDN（Background scripts，2026-07-27）：Event Page idle 之后 **DOM `setTimeout` 不可靠**，要用 `browser.alarms`。MDN alarms：alarms **不跨浏览器 session 持久化**。

因此 1.3.1：

1. `pickBackgroundPoller === "background"` 时 **绝不** `startSwFallback()`。
2. `ensureFirefoxPollAlarm`：`periodInMinutes = intervalSec / 60`（3 秒 → 0.05）。`enabled=false` 清除；`intervalSec` 变了才重建，周期没变则 keep。
3. 每次 `pls-firefox-poll`：**一次** IP Echo；Geo 异步，慢 Geo 不挡下一发 alarm。
4. `prepare` / `prepareOnce` 只做 hydrate、badge、确保 alarm。generic Event Page `load` **不** Echo（避免 alarm 唤醒时 double detect）。
5. 立即 Echo 的 reason 仅 `installed` / `startup` / `settings`（见 `lib/firefox-poll.js` `shouldImmediateEcho`）。
6. `onInstalled` / `onStartup` / 设置变化时创建或恢复 alarm。
7. WebRTC / Worker 在 event page 进程内跑，Worker 仍用打包的 `diagnostics/worker-probe.js`。

**2–5 秒 alarm 真实触发频率未在 Firefox 128+ 实测，不能当已验证。**

## Echo 与 Geo

`lib/exit-pipeline.js`：

- `onEcho` 尽快 ACK：最多写一次语义状态，Geo 后台跑。
- 调用方不得 `await lookupGeo` 才能进入下一轮 Echo。
- 同 IP 心跳：零 storage，不 abort 已有 Geo（含 manual RESYNC）。
- 新 IP：abort 旧 Geo；persist / cache-hit / commit / fail 全部认 `exitGeneration`。旧出口的异步结果必须丢弃。

Geolocation 在 A→B 且 B 的 Geo 未就绪时进入 `pending`（失败则 `error`），不再把 A 的坐标称为当前位置。Date/Intl 无法阻塞，切换窗口暂时保留上一份虚拟时区，避免露出主机时区。

## 页面注入

- isolated + MAIN 都是 `document_start`、`all_frames`、`match_about_blank`、`match_origin_as_fallback`。
- isolated 把 storage 桥到 MAIN；MAIN 忽略页面伪造的 `enabled: false` / `trusted`。
- `webNavigation.onCommitted` + `scripting.executeScript({ world: "MAIN", injectImmediately: true })` 补 about:blank 缺口。Firefox 空 about:blank **不会**在 document_start 注入（MDN）。
- 诊断 PAGE_ENV 只探测已打开的 http(s) 页。扩展页本身没有 MAIN 补丁。

## 诊断（旁路）

`lib/diagnostics-runner.js` 与 Echo/Geo **隔离**：DNS / Worker / 字体失败不得打断轮询。

优先级：新 detected IP 永远抢占（含正在跑的 manual）；同 IP 的 auto **不得**取消 manual。Worker 探测只在扩展 origin，不在目标网页 `new Worker(Blob)`。
