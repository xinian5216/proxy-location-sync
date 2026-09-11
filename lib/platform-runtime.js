/**
 * Chromium：SW + Offscreen。
 * Firefox：无 Offscreen / 无 background SW，event page 自己跑 Echo / WebRTC / Worker。
 * 异常一律 fail-closed，不得把网页退回真实 GPS。
 */

import { canCreateDedicatedWorker, shouldUseOffscreen } from "./browser-api.js";

export function pickBackgroundPoller(api, globals = globalThis) {
  if (shouldUseOffscreen(api)) return "offscreen";
  if (canCreateDedicatedWorker(globals) || typeof globals.fetch === "function") return "background";
  return "background";
}

export async function runWebrtcProbe({ offscreenAvailable, probeOffscreen, probeLocal, ip }) {
  if (offscreenAvailable && typeof probeOffscreen === "function") {
    try {
      const sent = await probeOffscreen(ip);
      if (sent !== false) return sent;
    } catch {
      /* fall through to in-process probe */
    }
  }
  if (typeof probeLocal !== "function") return { status: "unknown", reason: "WebRTC unavailable" };
  try {
    return await probeLocal(ip);
  } catch (err) {
    return { status: "unknown", reason: String(err && err.message ? err.message : err) };
  }
}

export async function runWorkerProbe({
  offscreenAvailable,
  hasOffscreenDocument,
  probeOffscreen,
  probeLocal,
}) {
  if (offscreenAvailable && typeof probeOffscreen === "function") {
    try {
      const open = typeof hasOffscreenDocument === "function" ? await hasOffscreenDocument() : true;
      if (open) {
        const result = await probeOffscreen();
        if (result && typeof result === "object") return result;
      }
    } catch (err) {
      return { ok: false, reason: String(err && err.message ? err.message : err) };
    }
  }
  if (typeof probeLocal !== "function") return { ok: false, reason: "Worker unavailable" };
  try {
    return await probeLocal();
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

export function htmlGeolocationLabel(present) {
  return present ? "present" : "Not supported";
}
