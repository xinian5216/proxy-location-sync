/**
 * Firefox MV3 Event Page 轮询计划（纯函数）。
 *
 * MDN Background scripts（2026-07-27）：
 *   DOM setTimeout 在 Event Page idle 后不会保持；要用 alarms 唤醒。
 * MDN alarms（2025-07-17）：alarms 不跨浏览器 session 持久化。
 * MDN setTimeout（2026-09-03）：WebExtension 后台不要依赖 setTimeout。
 * Firefox 源码 ext-alarms.js：delay = periodInMinutes * 60 * 1000，无 Chrome 那种 30 秒 clamp。
 * 本仓库未在真实 Firefox 128+ 实测 2–5 秒触发频率，不得声称已验证持续轮询。
 */

import { DEFAULT_SETTINGS } from "./constants.js";

export function intervalSecToPeriodMinutes(intervalSec) {
  const sec = Number(intervalSec);
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_SETTINGS.intervalSec / 60;
  return sec / 60;
}

export function firefoxPollAlarmInfo(intervalSec) {
  return { periodInMinutes: intervalSecToPeriodMinutes(intervalSec) };
}

export function firefoxPollAlarmNeedsUpdate(existing, intervalSec) {
  if (!existing) return true;
  const want = intervalSecToPeriodMinutes(intervalSec);
  const have = Number(existing.periodInMinutes);
  if (!Number.isFinite(have)) return true;
  return Math.abs(have - want) > 1e-9;
}

/**
 * generic Event Page load / alarm wake 不得额外 Echo。
 * Chromium（有 Offscreen）保持 1.3.0：load / installed / startup / activate / settings 仍立即 Echo。
 */
export function shouldImmediateEcho(reason, { offscreenAvailable } = {}) {
  if (reason === "poll") return false;
  if (offscreenAvailable) return true;
  return reason === "installed" || reason === "startup" || reason === "settings";
}

/**
 * Firefox 永不走 setTimeout fallback。
 * action: create | keep | clear
 */
export function planFirefoxPolling({
  enabled,
  offscreenAvailable,
  existingAlarm,
  intervalSec,
} = {}) {
  if (offscreenAvailable || !enabled) {
    return { action: "clear", startSwFallback: false };
  }
  if (firefoxPollAlarmNeedsUpdate(existingAlarm, intervalSec)) {
    return {
      action: "create",
      info: firefoxPollAlarmInfo(intervalSec),
      startSwFallback: false,
    };
  }
  return { action: "keep", startSwFallback: false };
}

export function echoesForAlarmFires(n) {
  const count = Math.max(0, Number(n) || 0);
  return count;
}
