# AGENTS.md

第一入口。读完本文件再改代码。细节去 `docs/agent/`，不要先全库扫描。

**Proxy Location Sync** 检测浏览器**当前真实公网出口 IP**，并把网页里的地理位置与时区同步到该出口。不是代理客户端，不读 v2rayN / Clash / sing-box 配置。

**当前版本：1.3.1**（本套 agent 文档是 metadata，不要为此升产品版本。）

仓库根目录就是扩展根目录：能直接看到 `manifest.json`。开发时这份清单是 **Chromium**。Firefox 用 `npm run build:firefox` 的产物，不要把带 `background.service_worker` 的清单加载进 Firefox。

## 平台与后台

| | Chromium | Firefox |
| --- | --- | --- |
| 浏览器 | Chrome / Edge 116+（建议 120+） | Firefox 128+ |
| 后台 | Service Worker + Offscreen | Event Page（`background.scripts`，`persistent: false`） |
| IP 轮询 | Offscreen 自调度；Offscreen 失败才 `setTimeout` fallback | `pls-firefox-poll` alarm，**不用** Event Page `setTimeout` 循环，**不用** Offscreen |
| 清单 | `manifests/base.json` + `manifests/chromium.json` | 同一份 base + `manifests/firefox.json`（gecko id `proxy-location-sync@xinian5216`） |

共享一份源码，两套 overlay。Chrome 116–120 拒载同时带 `scripts` 与 `service_worker` 的 MV3 清单，所以不能合成一份通吃 manifest。

## 动手前必读

1. 本文件
2. [docs/agent/INDEX.md](docs/agent/INDEX.md) — 按模块找源码和测试，不要全库搜
3. [docs/agent/INVARIANTS.md](docs/agent/INVARIANTS.md) — 不能破坏的约束
4. 再按任务选读：
   - 数据流 / 平台差异 → [ARCHITECTURE.md](docs/agent/ARCHITECTURE.md)
   - 现在真实状态 / 未做的 E2E → [CURRENT_STATE.md](docs/agent/CURRENT_STATE.md)
   - 为什么这样设计 → [DECISIONS.md](docs/agent/DECISIONS.md)
5. 发版 → [RELEASE_CHECKLIST.md](docs/agent/RELEASE_CHECKLIST.md)

机器可读索引：[agent-index.json](agent-index.json)

## 测试（改前改后都要跑）

```bash
npm test
```

等价于 `node --test tests/*.test.js`。仓库根没有 `extension/` 这一层。

改了 background / polling / manifest / 打包脚本之后，还要：

```bash
npm run package
```

并对**解压后的 zip 根目录**再跑一次 `npm test`。

发版清单见 `docs/agent/RELEASE_CHECKLIST.md`。CI 只跑 Node 测试，**不是**把扩展加载进真实 Chrome / Firefox。

## 不要随意改无关稳定模块

只改任务涉及的文件。尤其不要顺手改：

- `content/injected.js` — MAIN fail-closed；没有 trusted 开关
- `lib/exit-pipeline.js` — Echo / Geo 解耦、generation、同 IP 零 storage
- `lib/geolocation-gate.js` / `lib/html-geo-element.js` — 定位状态机
- `lib/timezone.js` — Date/Intl；显式 TZ 走**本引擎**原生 `Date.parse`
- `offscreen/offscreen.js` — 已稳定的 Chromium 轮询；**不为 Firefox 改它**
- `lib/firefox-poll.js` — Firefox alarm 计划；**不要让 Firefox 走 `startSwFallback()`**
- `lib/diagnostics-runner.js` — manual vs auto、新 IP 抢占
- `manifests/*.json` — 不要合成一份通吃清单，不要给 Firefox 加 `offscreen`

Firefox 补丁不得破坏 Chromium 已稳定行为。缺 API 就 feature detection 后跳过，不要垫一层假实现。

未在真实浏览器做过的事，不要写成「已验证」。当前最重要的缺口：Firefox 128+ Event Page suspend/wake 与 2–5 秒 alarm 频率。
