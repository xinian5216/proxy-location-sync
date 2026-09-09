# Proxy Location Sync

**Chrome / Edge Manifest V3 扩展。** 检测浏览器**当前真实公网出口 IP**，并把网页里的地理位置、时区同步到这个出口。

Detect the browser’s real public exit IP and sync webpage geolocation + timezone to that location — without touching your proxy app.

不读取 v2rayN、Clash、sing-box、NekoRay 的配置、节点名或进程。换代理软件只要浏览器流量仍走那个出口，扩展就能工作。

**当前版本：1.1.3**

| | |
| --- | --- |
| 建议浏览器 | Chrome 120+ / Edge 120+（offscreen 生命周期更稳） |
| 最低 | Chrome / Edge 116 |
| 商店上架 | 否。用开发者模式加载本仓库 |
| 许可证 | MIT |

## 它做什么

切代理节点之后，网页仍然经常显示：

- 真实 GPS / 系统定位
- 主机时区（`Date` / `Intl`）
- 和出口 IP 对不上的城市

本扩展做三件事：

1. **IP Echo**：短间隔探测浏览器实际公网出口（首选 `api64.ipify.org`，IPv4 / IPv6）。
2. **Geo Lookup**：只有 IP 变化（或缓存过期、手动重新同步）才查地理库。同 IP 心跳不写 `chrome.storage.local`。
3. **网页同步**：把 `navigator.geolocation`、`Date` / `Intl` / `Temporal.Now`、Chrome 144+ `<geolocation>` 同步到该出口。

**不是：** 代理客户端、节点切换器、PAC 编辑器，也不会改 WebRTC 策略。

## 快速安装（从本仓库）

本仓库**根目录就是扩展根目录**，能直接看到 `manifest.json`。

```bash
git clone https://github.com/xinian5216/proxy-location-sync.git
```

1. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`。
2. 打开 **开发者模式** → **加载已解压的扩展程序**。
3. 选中克隆下来的 `proxy-location-sync` 文件夹（里面有 `manifest.json`）。
4. 工具栏图标角标为国家代码（如 `JP` / `US`）。切代理后数秒应变。

不需要 `.crx`，不需要上架。代理软件保持原样。

从 1.1.0 / 1.1.2 升级：在 `chrome://extensions` **重新加载**本扩展。1.1.3 是稳定性修复：IP 探测与 Geo 查询解耦、同 IP 心跳不再写 storage，并修正 Date / 权限语义。不改 UI 风格、不加功能。

## 仓库结构

```
manifest.json                # MV3 清单
package.json                 # npm test
README.md
LICENSE
background/service-worker.js
offscreen/                   # IP Echo 自调度 + WebRTC ICE 探测
content/
  isolated.js                # chrome.storage → MAIN CustomEvent（不带 trusted）
  injected.js                # MAIN world：fail-closed geolocation / Date / Intl / Temporal.Now
popup/  options/
lib/
tests/                       # node --test；含 frames.html
icons/
```

## 测试

克隆后在仓库根目录：

```bash
npm test
```

或：

```bash
node --test tests/*.test.js
```

不要写成 `node --test extension/tests/*.test.js`——这个仓库根目录没有 `extension/` 这一层。

当前 **145** 项测试。高风险行为（Date / HTMLGeolocation / 权限撤销）会用 Node `vm` **真正执行** `content/injected.js`，而不是只测 helper。

CI：每次 push / pull request 跑同一套测试。

## 权限

| 权限 | 用途 |
| --- | --- |
| `storage` | 设置、当前出口、按 IP 的地理缓存 |
| `alarms` | 每分钟唤醒 service worker |
| `offscreen` | 短间隔轮询 + WebRTC ICE 探测 |
| `scripting` + `webNavigation` | 导航提交时把当前状态注入 MAIN world |
| `host_permissions: http(s)://*/*` | 请求 IP/地理接口；向网页注入脚本 |

**没有** `tabs`、`debugger`、`privacy`。不会出现「正在调试此浏览器」。不读历史、Cookie、账号。角标走 `chrome.action`。向已打开标签页推送状态时用 `chrome.tabs.query({})` 取 tabId（不读 title/url/favicon），**不申请** `tabs` 权限。SW 重启后仍能找到旧标签。

## 架构

```
v2rayN / Clash / sing-box 切节点
        │  浏览器网络栈变了
        ▼
offscreen 自调度 IP Echo（等上一轮 Echo ACK 再等 interval；不等 Geo）
  detectPublicIp()          ← 首选 api64.ipify.org（IPv4/IPv6）
        │  得到 targetIp，立即 ACK
        ▼
service worker  内存心跳 / 独立 Geo task
  同 IP + ready → 不写 storage
  新 IP → abort 旧 Geo，启动 Geo B
        │  查不到就保留上一份完整 state，Geolocation 进入 pending/error
        ▼
chrome.storage.local  { settings, state, geoCache }
        │  storage.onChanged
        ▼
每个 frame 的 isolated content script
        │  CustomEvent __pls_v1（不可信）
        ▼
MAIN world injected.js
  geolocation: pending | ready | error（永不因页面字段进入 native disabled）
  Date / Intl / Temporal.Now（有虚拟时区之后）
  HTMLGeolocationElement position/error（Chrome 144+）
```

检测绑定的是 **IP Echo Provider 这次请求实际使用的出口**，不是「当前连接的随便一个地理接口」。东京的 IP 绝不会配上洛杉矶的坐标。

## 弹窗：暂停 vs 关掉扩展

| 操作 | 结果 |
| --- | --- |
| 弹窗 **暂停自动同步** | 停止 IP 检测。已打开页面**保持** fail-closed 虚拟定位，**不会恢复系统 GPS**。 |
| `chrome://extensions` **关闭本扩展** 再刷新 | 内容脚本不再注入，网页才真正回到系统定位。 |

页面伪造 `enabled: false` / `__PLS_APPLY__({ trusted: true })` 无效。MAIN world 没有「允许返回真实 GPS」的授权开关。

## Geolocation 状态机（fail-closed）

| 模式 | 行为 |
| --- | --- |
| `pending` | 排队。`getCurrentPosition` / `watchPosition` **绝不**把原生坐标交给页面。超时走 `TIMEOUT`。 |
| `ready` | 只交付与**当前**出口一致的虚拟坐标 |
| `error` | 新出口地理失败。新的 `getCurrentPosition` 返回 `POSITION_UNAVAILABLE`，不把旧出口坐标假装成当前位置。 |

`document_start` 时若同步已开但虚拟位置还没到，视为 `pending`，不是原生。

MAIN world **没有** `trusted` 开关。`__PLS_APPLY__`、`__PLS_BOOTSTRAP__`、CustomEvent 都不能把定位切回系统 GPS。页面伪造 `enabled:false` 会被忽略。

同时 patch `Geolocation.prototype` 与 `navigator.geolocation` 实例。`Geolocation.prototype.getCurrentPosition.call(...)` 与 `Object.getPrototypeOf(navigator.geolocation).getCurrentPosition.call(...)` 走同一套 controller。`Date.prototype.constructor` / `Intl.DateTimeFormat.prototype.constructor` 指向补丁函数。

**Chrome 144+ `<geolocation>` / `HTMLGeolocationElement`：** 扩展覆盖 `position` / `error` getter，并包装 `document.createElement("geolocation")` 以及已有标签（MutationObserver 只扫描 `addedNodes`）。`watch` 时出口变化会 dispatch 合成 `location` 事件，**`event.isTrusted` 只能是 false**——浏览器不允许 JS 伪造可信事件。`watch=false` 一次定位成功后，后续出口变化不再当持续 watcher 推送。若 prototype getter 无法覆盖，则 fail-closed（隐藏原生 position），绝不把系统 GPS 交给页面。测试页：`tests/geolocation-element.html`（Chrome <144 自动 SKIP）。

虚拟 `GeolocationPosition` / `GeolocationCoordinates` 会尽量挂上正确 prototype，自有 latitude/longitude 等字段覆盖可能存在的 native getter。`instanceof` 在跨 realm 或部分 Chromium internal slot 场景下仍可能失败，属于 **JS-level approximation**，不是引擎级对象。

**权限：** 先 `navigator.permissions.query({name:"geolocation"})`。`granted` / `denied` 不调用原生定位传感器；只有 `prompt` 才调用原生 `getCurrentPosition` 弹出授权框。真实坐标只进入内部闭包然后被丢弃。`permissions.query` **不伪装成 granted**。iframe 的 Permissions-Policy 禁止 geolocation 时，门控失败，不会偷偷给坐标。

`watchPosition` 之后如果权限变成 `denied`：每个虚拟 watcher **只**收到一次 `PERMISSION_DENIED`，然后被移除。重新 granted **不会**自动复活旧 watcher；网站必须再调一次 `watchPosition`。

**A→B 切换：** 网络出口已是 B、B 的 Geo 尚未就绪时，Geolocation 进入 `pending`（或 B 失败则为 `error`），**不再声称 A 的坐标是当前位置**。  
Date / Intl 是同步 API，无法阻塞，因此在 B 时区就绪前**暂时保留上一个虚拟时区**，避免突然露出主机时区。

Echo 健康与 Geo 健康是分开的：出口探测正常、地理查询失败时，弹窗显示当前 IP + 地理错误，**不会**显示「出口检测失联」。

## Date / Intl / Temporal

有虚拟时区之后（包括 Geo 仍 pending 的切换窗口）：

- `Date()`（不加 `new`）→ 出口时区的 `toString`
- `Date.prototype.getYear` / `setYear`（含 0–99 → 1900+y）走虚拟时区
- `new Date(y, m, d, h, …)` → 出口墙上时间（含 DST 缺口/重叠，按 Temporal *compatible*：缺口取 later，重叠取 earlier）
- `Date.parse` / `new Date("2026-01-15T12:00:00")` 无时区偏移时按出口墙时；`Z` / `GMT` / `±HH:MM` 仍是绝对时间；纯 `YYYY-MM-DD` 是 UTC 午夜
- 非 ISO 字符串（如 `01/01/2026 00:00:00`、`Jan 1 2026 00:00:00`）先走原生解析得到墙时分量，再按出口时区还原
- `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` 走原生实现并注入 `timeZone`
- `getMilliseconds` 走原生（负 epoch 仍是 0–999）
- `Invalid Date` 的 getter / `toString` 走原生
- `setHours(NaN)` 等与原生一致：返回 `NaN`，对象变成 Invalid Date，不抛额外 `RangeError`
- `Invalid Date.setFullYear` / `setYear` 按原生语义恢复：用 `+0` 在**虚拟时区**的本地分量
- `Temporal.Now.timeZoneId` / `zonedDateTimeISO` / `plainDateISO` 等：未显式传时区时用出口时区。**不包装 `instant()`**

时区校验用 `new Intl.DateTimeFormat("en-US", { timeZone })`，不靠字符串是否包含 `/`。`UTC`、`Etc/UTC` 合法。

不改 `navigator.language`。不伪装 `Function#toString`。

## WebRTC（只检测）

结果绑定 `checkedForIp`。显示前必须等于当前 `state.ip`，否则是 `unknown`（「exit changed; probe pending」）。  
IP 变化后，无论地理来自缓存命中还是新查询，都会把 WebRTC 置为 unknown 并重新探测。不会继承上一出口的 `ok`。

| 状态 | 含义 |
| --- | --- |
| `ok` | 有 srflx 公网候选，且与 HTTP 出口 IP 一致；host 若存在应是 mDNS |
| `leak` | STUN 公网 IP ≠ 出口，或能看到局域网 host |
| `unknown` | 没有足够候选、探测失败、出口刚变、或只有 mDNS。**不等于确定没泄漏** |

不修改 `webRTCIPHandlingPolicy`。

## 出口失联

若超过约 20 秒没有任何成功的 IP Echo，弹窗显示「出口检测失联」。Geolocation 不再把旧坐标称为当前位置（pending / unavailable）。Date/Intl 仍保留最后一份虚拟时区。**无法检测出口 ≠ 确认出口没变。**

## IPv6 / 双栈

首选 `https://api64.ipify.org?format=json`（IPv4 / IPv6），避免 IPv6-only 出口先白等两个 IPv4-only 超时。成功源保持 sticky。缓存 key 使用规范化后的 IP，压缩/展开的同一 IPv6 不会拆成两条缓存。

**双栈代理可能同时拥有 IPv4 和 IPv6 出口；一个网站最终看到哪个地址取决于实际连接族。** 扩展看到的是 Echo Provider 那次请求用的族。

## 分流（split-routing）是天然限制

扩展检测的是：「IP Echo Provider 这个请求实际使用的出口」。

如果 v2rayN / PAC / Clash 规则是：

- `api.ipify.org` → Proxy
- `example.com` → DIRECT

那么并不存在一个统一的「整个浏览器当前公网 IP」。不同网站可能走不同出口。

本扩展刻意不读取 v2rayN / Clash 路由配置，所以无法知道某个网站最终命中了哪条规则。

- **全局代理 / 所有浏览器流量统一出口：** 效果最符合预期。
- **复杂分流：** 只能根据探测 Provider 的出口推断全局位置，不能保证每个目标网站实际网络出口都相同。

## Offscreen

- 理由是诚实的 `WEB_RTC`（确实做 ICE 探测）
- 轮询：上一轮结束 → 等 interval → 下一轮。`pollInFlight` 互斥。IP Echo 与 Geo Lookup 解耦：不等 Geo 才能进入下一轮探测
- Offscreen 与 service worker fallback **互斥**：offscreen 创建失败才启动 fallback；之后一旦 offscreen 恢复，立即停掉 fallback
- 全部 IP Echo Provider 冷却时：不 fetch；loop 睡到 `nextRetryAt`，但最长 30 秒再醒（不是睡到数分钟后的 cooldown 结束）。manual detect 可 bypass。
- 同一 pending IP 的 Geo 失败会记 `nextGeoRetryAt`，3 秒一次的 IP echo 不会每次重打 Geo
- `chrome.runtime.sendMessage` 失败不得让主循环永久退出
- 不用假 `RTCPeerConnection` 保活
- 暂停自动同步：abort 进行中的 fetch / 探测，`closeDocument`
- Chrome 116：`hasDocument` 不存在则用 `getContexts`

## iframe

Manifest 使用 `all_frames` + `match_about_blank` + `match_origin_as_fallback`。

由匹配 http/https origin 创建的 `data:` / `blob:` / `filesystem:` / `about:` frame，可通过 `match_origin_as_fallback` 覆盖；**独立、无匹配 initiator/origin 的 opaque frame 不保证覆盖。**

打开 `tests/frames.html`（需通过 http/https 访问）可看 about / data / blob 三个 frame 的时区是否与顶层一致。若实测与文档不一致，以当前 Chromium 行为 + [Chrome 文档](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) 为准。

## MAIN world / CustomEvent

isolated → MAIN 使用固定事件名 `__pls_v1`，并暴露 `__PLS_APPLY__` / `__PLS_BOOTSTRAP__`。

Chrome 明确说明 MAIN world 与网页共享执行环境。网页可以读取、调用、覆盖、伪造这些名字和 CustomEvent detail。

**这些通道绝不能授权返回真实 GPS。** 1.1.2 删除了调用方自报的 `trusted` 布尔。页面执行：

```js
__PLS_APPLY__({ trusted: true, settings: { enabled: false } })
window.__PLS_BOOTSTRAP__ = { settings: { enabled: false } }
```

都**不会**把 `navigator.geolocation` 切回系统定位。`settings.enabled=false` 在 MAIN 会被忽略。弹窗暂停自动同步只停止 IP 检测；**已经打开的页面保持 fail-closed 虚拟状态**（有坐标则继续虚拟坐标，没有则 pending/error）。

要真正恢复系统定位，只能在 `chrome://extensions` 关闭本扩展（或刷新且内容脚本不再注入）。这是纯 MAIN monkeypatch 下「动态关闭既方便又安全」做不到时的诚实限制，不是用可伪造的 trusted 旗标假装解决。

页面仍可能改写虚拟坐标 / 干扰 Date 补丁（共享环境）。被干扰时优先 pending/error，而不是退回真实 GPS。不宣称恶意页面绝对无法识别或破坏 monkeypatch。

## 如何验证（装到浏览器后）

**公网 IP**  
打开 [https://api.ipify.org](https://api.ipify.org) 或 [https://api64.ipify.org](https://api64.ipify.org)。应与弹窗一致。切节点后数秒两边一起变。

**地理位置**

```js
navigator.geolocation.getCurrentPosition((p) => {
  console.log(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
});
navigator.geolocation.watchPosition((p) => {
  console.log("moved", p.coords.latitude, p.coords.longitude, new Date().toTimeString());
});
```

精度约 800–4200 米。从东京切到洛杉矶，**不要刷新**，watch 应打出洛杉矶坐标。切换过程中新的 `getCurrentPosition` 不应继续返回旧城市。

**时区**

```js
Intl.DateTimeFormat().resolvedOptions().timeZone
new Date().getTimezoneOffset()
new Date().toString()
new Date(2026, 0, 15, 12, 0, 0).toString()
```

东京：`Asia/Tokyo`，偏移 `-540`。洛杉矶随夏令时 420 或 480。`navigator.language` 应保持原样（例如 `zh-CN`）。

**WebRTC**  
[browserleaks.com/webrtc](https://browserleaks.com/webrtc)。若出现与出口不同的公网 IP 或清晰局域网 IP，弹窗为「可能泄漏」。没有候选则为「未知」。切出口后应先变未知再出新结果。

## 能做到 / 近似 / 做不到

**完全可以**

- 跟浏览器真实出口 IP，不绑某一款代理软件
- IP 变化才查地理；缓存 7 天；坐标按 IP 稳定
- fail-closed geolocation（含暂停自动同步期间的 watch/get、A→B pending、error 不假装旧坐标）
- 常见 Date / Intl / Temporal.Now 时区，以及 `Date.prototype.constructor` / `Intl.DateTimeFormat.prototype.constructor`
- Chrome 144+ `<geolocation>` 的 position/error（watch 的 location 事件只能合成，isTrusted=false）
- 由匹配 origin 创建的 iframe（含部分 about/data/blob）
- 多源容错、generation 竞态、冷却、禁用时停轮询
- WebRTC 泄漏**检测**（绑定当前出口 IP）

**只能近似**

- MV3 service worker 会休眠。短间隔在 offscreen；极端省电仍可能被限制。`chrome.alarms` 每分钟兜底。
- `document_start` 仍有竞态：同步内联脚本可能在状态到达前跑几毫秒。**地理位置在 pending 时不会泄漏**；`Date()` 在还没有任何虚拟时区前仍可能是主机时区。
- 新 IP 已检测到但 Geo 尚未就绪期间，Date/Intl 暂时保留上一个虚拟时区；Geolocation 不再声称旧坐标是当前坐标。
- 为弹出授权框必须调用原生 geolocation；真实坐标存在于内部闭包。若页面 hook 了更底层的实现，仍可能观察到这次调用。
- IP 库是城市级。抖动避免永远钉在质心，不是 GPS。
- DST 缺口/重叠按 Temporal compatible 消歧，与 V8 在极端历史时区上可能有出入。
- 虚拟 `GeolocationPosition` 是 JS 近似：会挂 prototype，但 `instanceof` 不保证永远为 true。
- `<geolocation watch>` 的更新只能 dispatch 合成 `location` 事件，`isTrusted` 无法变成 true。
- 弹窗暂停自动同步无法在 MAIN 安全地切回系统 GPS（页面也能发同样的消息）。已打开页保持虚拟/pending。

**做不到（不假装）**

- `chrome://`、`edge://`、商店页、内置 PDF 查看器
- 网页自己的 Worker / SharedWorker / Service Worker（content script 进不去）
- 无匹配 initiator 的 opaque `data:` / `blob:` frame（不保证注入）
- 不用 `chrome.debugger` 就不能改浏览器界面时区、DevTools 时区（用了会长期显示「正在调试」）
- 不能从本机代理软件读节点名，也不能按每个目标网站的 PAC/分流规则分别伪装
- 不拦截、不修改 WebRTC
- 无法把 IP 定位伪装成 5 米 GPS
- 无法在 MAIN world 下彻底防止恶意网页干扰注入脚本，也不能用页面可写字段做「允许返回真实定位」的授权
- 无法既方便又安全地从网页侧动态关闭伪装并恢复系统 GPS（需关掉扩展）

## 缓存与默认

- 地理缓存 TTL **7 天**，最多 50 个 IP。过期后重新查询。key 为规范化 IP。
- 默认定位模式 **raw**（出口 IP、地理库、Geolocation、Timezone 尽量一致）。城市随机偏移是可选。

## 开发

改代码后：

```bash
node --test tests/*.test.js
```

加载已解压的扩展后，每次改 `content/`、`background/`、`offscreen/` 都要在 `chrome://extensions` 点**重新加载**，并刷新已打开的网页。

Issue / PR 欢迎。请说明 Chrome/Edge 版本、是否全局代理、以及 `chrome://extensions` 里的报错。

## 许可证

[MIT](./LICENSE)

本项目按「现状」提供。它会改网页里的定位和时区 API；请自行判断使用场景。作者不对误用、网站检测、或代理分流导致的不一致负责。
