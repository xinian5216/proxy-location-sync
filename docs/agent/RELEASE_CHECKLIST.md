# 发版清单

给未来 Agent。做完勾选。没做真实浏览器 E2E 必须在 README 与 [CURRENT_STATE.md](CURRENT_STATE.md) 写明，不能靠这项清单假装验证了。

版本号只在**产品行为**变化时加。只改 `docs/` / `AGENTS.md` / `agent-index.json` **不要**升 `package.json`。

## 1. 测试

- [ ] 仓库根目录 `npm test`（`node --test tests/*.test.js`）全绿
- [ ] 若改了 JS：对改动文件 `node --check <file>`，或

      find . -name '*.js' ! -path './dist/*' ! -path './node_modules/*' -print0 | xargs -0 -n1 node --check

## 2. 打包

- [ ] `npm run build`（Chromium + Firefox 目录）
- [ ] `npm run package` 生成两个 zip，文件名带**当前** `package.json` version
- [ ] 解压 **Chromium zip** 到临时目录，在该目录再跑 `npm test`
- [ ] 解压 **Firefox zip** 到临时目录，在该目录再跑 `npm test`
- [ ] zip 根目录能直接看到 `manifest.json`（没有多套一层）
- [ ] zip 内有 `scripts/build-extension.mjs`，且其 `copyTree` 含 `"scripts"`（源码包解压后 `npm run package` 仍能跑）

## 3. Manifest 平台差异

对照 `manifests/chromium.json` / `manifests/firefox.json` / 生成的 `dist/*/manifest.json`：

- [ ] Chromium：`background.service_worker`，**没有** `background.scripts`，有 `offscreen`，`minimum_chrome_version` 116
- [ ] Firefox：`background.scripts` + `persistent: false`，**没有** `service_worker`，**没有** `offscreen`，gecko id `proxy-location-sync@xinian5216`，`strict_min_version` 128.0
- [ ] 两边都没有 `tabs` / `debugger` / `privacy`
- [ ] 版本号与 `package.json` 一致

## 4. Chromium regression

未改 Offscreen / SW fallback / badge / fail-closed 则至少用测试锁住；改了则对照：

- [ ] Offscreen 轮询仍不等 Geo
- [ ] Offscreen 与 `startSwFallback` 互斥；Firefox 分支仍不调用 `startSwFallback`
- [ ] 同 IP 心跳零 storage
- [ ] SW 重建后 badge 从 storage 的 `countryCode` 恢复两位大写
- [ ] MAIN 无 trusted 开关；`enabled=true` 注入期间不回系统 GPS

## 5. Firefox runtime

- [ ] `pls-firefox-poll`：`enabled=false` 清除；`intervalSec` 变才重建
- [ ] generic load 不额外 Echo；每次 alarm 一次 Echo
- [ ] Geo 慢不挡下一 alarm（`tests/firefox-poll.test.js`）
- [ ] 缺的 API 走 feature detection，不假实现
- [ ] **若没有真实 Firefox 128+ Event Page suspend/wake 实测：README + CURRENT_STATE 必须写「2–5 秒持续轮询未验证」**

## 6. 文档

- [ ] README 版本、zip 文件名、测试条数
- [ ] `docs/agent/CURRENT_STATE.md` 版本、runtime、测试数、E2E 缺口
- [ ] `agent-index.json` 的 `version`、`subsystems` 路径仍存在
- [ ] 改了模块边界则更新 `docs/agent/INDEX.md`
- [ ] 新的不可破坏约束写入 [INVARIANTS.md](INVARIANTS.md)，新的「为什么」写入 [DECISIONS.md](DECISIONS.md)

## 7. E2E 声明

- [ ] Node 测试通过 ≠ 浏览器验证
- [ ] 没有真实 Chrome 加载：不要写「已在 Chrome 验证」
- [ ] 没有真实 Firefox 128+ suspend/wake：不要写「已验证 2–5 秒轮询」
- [ ] GitHub Release notes 同步上述限制

## 8. 发布面（若这次要推 GitHub）

- [ ] 只推扩展仓库内容：不要 companion 站点、不要 API key、不要 `.env`
- [ ] Release 附两个 zip：`proxy-location-sync-chromium-<ver>.zip` 与 `proxy-location-sync-firefox-<ver>.zip`
