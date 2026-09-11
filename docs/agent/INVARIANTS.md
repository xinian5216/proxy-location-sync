# 不变量

未来 Agent **不得破坏**。改代码前对照；加功能也要守。测试是这些约束的执行层，不是可以绕过的清单。

## Geolocation

1. **`enabled=true`（内容脚本仍在注入）时，绝不能 fallback 到真实系统 GPS。** pending / error 也要把原生坐标丢掉。页面伪造 `trusted`、`enabled: false`、`__PLS_APPLY__`、CustomEvent 都不能授权返回 GPS。
2. 弹窗「暂停自动同步」只停 IP 检测。已打开页面保持 fail-closed 虚拟状态，**不会**恢复系统 GPS。要回到系统定位，只能关掉扩展（或内容脚本不再注入）。
3. A→B 且 B 的 Geo 未就绪：Geolocation 为 `pending`（B 失败则为 `error`），不得继续把 A 的坐标称为当前位置。
4. `permissions.query` 不得伪装成 `granted`。只有 `prompt` 才调用原生定位弹授权框；真实坐标只进内部闭包然后丢弃。
5. Firefox 无 `HTMLGeolocationElement`：feature detection 后跳过，诊断标 Not supported，**不要垫假元素**。

## Echo / Geo 管线

6. **IP Echo 与 Geo 查询解耦。** Echo 快速 ACK。调用方不得 `await` Geo 才能进入下一轮探测。
7. **Geo 慢不能阻塞下一次 IP 检测。** Chromium Offscreen 与 Firefox alarm 都如此。
8. **Latest generation wins。** `exitGeneration` / geo generation：persist、cache-hit、lookup commit、failGeo 都要认世代。
9. **同 IP heartbeat 不写 storage。** 同 IP + geo ready + 非 force：纯内存心跳。
10. **新出口必须淘汰旧出口的异步结果。** 旧 Echo 的慢 persist 不得重启 Geo，也不得 abort 更新的 Geo。同 IP 心跳不得 abort 已有 Geo（含 manual RESYNC）。

## 诊断

11. **manual diagnostics 不得被同 IP 的 auto 中断。** auto 应 skip 或 coalesce 到当前 manual。
12. **新 IP 可以抢占旧 IP diagnostics**（含正在跑的 manual）。
13. 诊断失败只写 unknown / 自己的状态，**不得抛进** IP Echo / Geo / watchPosition。
14. **Worker diagnostics 不得在目标网页使用 Blob Worker。** 只用打包的 `diagnostics/worker-probe.js`（扩展 origin）。PAGE_ENV 不在 MAIN 里 `new Worker`。

## 平台

15. **Chromium = Service Worker + Offscreen。** 短间隔轮询走 Offscreen。`startSwFallback()` 只在 Offscreen 失败时启动；Offscreen 恢复必须立刻停 fallback。
16. **Firefox = Event Page + alarms。** 不声明、不使用 Offscreen。不依赖 Event Page `setTimeout` 做持续轮询。`pickBackgroundPoller === "background"` 时禁止 `startSwFallback()`。
17. Firefox generic Event Page `load` 只 hydrate / 恢复 badge / 确保 alarm，**不得额外 Echo**。alarm 每次触发只产生一次 Echo。
18. Firefox alarms 不跨 session 持久化：`onInstalled` / `onStartup` / 设置变化必须创建或恢复 `pls-firefox-poll`。`enabled=false` 清除；`intervalSec` 变化才重建。
19. **Firefox 不支持的 API 应 feature detection 后跳过**（Offscreen、`HTMLGeolocationElement`、`action.setBadgeTextColor`、SW `skipWaiting` 等）。不要为缺 API 写假实现去「对齐」Chromium 外观。
20. **不为了 Firefox 兼容破坏 Chromium 已稳定行为。** 改 Firefox 轮询不要动 `offscreen/offscreen.js` 的调度语义。

## 产品边界

21. **不自动修改语言、UA / UA-CH、Canvas、WebGL、字体。** Locale / 字体 / UA 诊断只读，zh-CN / 微软雅黑不是 error。
22. 不 hook `Function#toString`。不包装 `Temporal.Now.instant`。
23. 不申请 `tabs`、`debugger`、`privacy`。不改 `webRTCIPHandlingPolicy`。WebRTC 只检测，不拦截。
24. 不读代理软件配置、节点名、进程。不声称「Echo 到的 IP = 每一个网站的实际出口」（分流 / PAC 是天然限制）。
25. `Date.parse` 遇显式时区（`Z` / `GMT` / `±HH:MM` / `EST` 等）走**当前引擎原生解析**。不要把 Chromium/V8 的 EST 结果强套到 Firefox。
26. 没有真实浏览器 E2E 时，**不得**把 Node 测试或源码意图写成「已在 Chrome / Firefox 验证持续轮询」。
