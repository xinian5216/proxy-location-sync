# 当前状态

只记 **1.3.1** 的事实。完整故事在 README 升级段；本文件不堆历史。发版时改这里。

## 版本与仓库

| | |
| --- | --- |
| 产品版本 | **1.3.1**（`package.json` / `manifests/base.json` / 根 `manifest.json`） |
| 仓库 | https://github.com/xinian5216/proxy-location-sync |
| 仓库根 | 扩展根目录（能直接看到 `manifest.json`） |
| 许可证 | MIT |
| 商店 | 未上架 |

## Runtime

| | Chromium | Firefox |
| --- | --- | --- |
| 后台 | Service Worker + Offscreen | Event Page：`background.scripts` + `persistent: false` + `type: module` |
| 最低版本 | Chrome / Edge **116**（建议 120+） | Firefox **128.0**（`strict_min_version`） |
| Add-on ID | （无） | `proxy-location-sync@xinian5216` |
| IP 轮询 | Offscreen 自调度；失败才 SW `setTimeout` fallback | alarm `pls-firefox-poll`，`periodInMinutes = intervalSec/60` |
| WebRTC / Worker | Offscreen 文档 | Event Page 进程内；Worker 仍是 `diagnostics/worker-probe.js` |
| 立即 Echo | `load` / `installed` / `startup` / `activate` / `settings` | 仅 `installed` / `startup` / `settings`；generic `load` 不 Echo |
| `HTMLGeolocationElement` | Chrome 144+ 补丁 | 不存在 → 诊断 **Not supported** |
| `Date.parse` 显式 TZ | 跟 V8 原生 | 跟 SpiderMonkey 原生 |

Firefox **不**调用 `startSwFallback()`。Chromium Offscreen 路径 1.3.1 **未改**。

## 测试

| | |
| --- | --- |
| 命令 | `npm test` → `node --test tests/*.test.js` |
| 条数 | **272**（Node 单元 / vm 执行 `content/injected.js` / 源码守卫） |
| CI | `.github/workflows/test.yml`，同样是 Node 20 + `node --test tests/*.test.js` |
| 产物 | `npm run package` → `dist/proxy-location-sync-chromium-1.3.1.zip` 与 `dist/proxy-location-sync-firefox-1.3.1.zip` |

这些测试**不是**把 MV3 扩展加载进真实浏览器。

## 已知限制（产品，不是 bug）

- 分流 / PAC：Echo 只反映探测 Provider 那次请求的出口。
- 网页 Worker / SharedWorker / Service Worker 进不去；Worker 时区不一致是 warning。
- 独立 opaque `data:` / `blob:` frame 不保证注入。
- Firefox 空 `about:blank` 在 `document_start` 不注入；靠 `webNavigation` 补，仍有短窗口。
- `document_start` 仍可能有几毫秒主机时区；地理位置 pending 时不泄漏 GPS。
- 虚拟 `GeolocationPosition` 是 JS 近似，`instanceof` 不保证。
- `<geolocation watch>` 的 `location` 事件只能合成，`isTrusted` 必为 false。
- 暂停自动同步无法安全地从网页侧恢复系统 GPS。
- 不伪装 language / UA / 字体 / Canvas / WebGL。
- Firefox Stable 正式安装需要 Mozilla 签名；仓库只提供未签名源码包。

## 尚未做真实浏览器 E2E

**不要把下面写成已验证。**

- 未在真实 **Firefox 128+** 用 `about:debugging` / `web-ext` 做过 Event Page suspend → alarm wake → 切代理仍检测。
- 因此 **不得声称 2–5 秒持续轮询已在 Firefox 验证**。Firefox 浏览器实现里 alarm 延迟是 `periodInMinutes * 60 * 1000`，没有 Chrome 那种 30 秒下限，但是否被系统节流以实测为准。
- CI 与 `npm test` 都不加载 Chrome / Edge / Firefox。
- `tests/geolocation-element.html` 依赖 Chrome 144+；Node / 低版本会 SKIP。
- `npx web-ext lint` 不是发布门禁。

Node 测试覆盖：alarm 计划、load 不重复 Echo、同 IP 零 storage、慢 Geo 不挡下一 Echo、两套 manifest、fail-closed、badge 恢复。这只证明源码契约，不证明浏览器调度。
