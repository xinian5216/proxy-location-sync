/**
 * Offscreen：IP Echo 自调度。只等 Echo ACK，不等 Geo lookup。
 * sendMessage 失败不得让主循环永久退出。
 */

import { MSG } from "../lib/constants.js";
import { createAbortSlot, runExclusive } from "../lib/abort-slot.js";
import { detectPublicIp, ipHealth } from "../lib/ip-providers.js";
import { nextPollDelayMs, runResilientLoop, sendAck } from "../lib/poll-sleep.js";
import { probeWebRtc } from "../lib/webrtc.js";
import { probeExtensionWorker, WORKER_PROBE_SCRIPT } from "../lib/worker-probe.js";

let intervalSec = 3;
let stopped = true;
let loopPromise = null;
let pollInFlight = false;
const ipSlot = createAbortSlot();
const webrtcSlot = createAbortSlot();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message && message.type;
  if (type === MSG.OFFSCREEN_START) {
    intervalSec = Number(message.intervalSec) || 3;
    start();
    sendResponse({ ok: true });
    return;
  }
  if (type === MSG.OFFSCREEN_STOP) {
    stop();
    sendResponse({ ok: true });
    return;
  }
  if (type === MSG.OFFSCREEN_DETECT) {
    void tick("manual")
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (type === MSG.OFFSCREEN_WEBRTC) {
    void runWebRtc(message.ip).then((result) => sendResponse(result));
    return true;
  }
  if (type === MSG.OFFSCREEN_WORKER_PROBE) {
    void runWorkerProbe()
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({ ok: false, reason: String(err && err.message ? err.message : err) }),
      );
    return true;
  }
  return false;
});

function start() {
  stopped = false;
  if (!loopPromise) {
    loopPromise = runResilientLoop({
      isStopped: () => stopped,
      tick: () => tick("interval"),
      sleep,
      delayMs: () => nextPollDelayMs(intervalSec, ipHealth.nextRetryAt()),
    }).finally(() => {
      loopPromise = null;
    });
  }
}

function stop() {
  stopped = true;
  ipSlot.abortCurrent();
  webrtcSlot.abortCurrent();
}

async function tick(reason) {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await runExclusive(ipSlot, async (signal) => {
      try {
        const echo = await detectPublicIp({
          signal,
          bypassCooldown: reason === "manual",
        });
        await sendAck(chrome.runtime.sendMessage.bind(chrome.runtime), {
          type: MSG.IP_ECHO,
          ip: echo.ip,
          provider: echo.provider,
          reason,
          at: Date.now(),
        });
      } catch (err) {
        if (err && err.name === "AbortError") return;
        const cooling = err && err.name === "CooldownError";
        await sendAck(chrome.runtime.sendMessage.bind(chrome.runtime), {
          type: MSG.IP_ECHO,
          ip: "",
          error: cooling ? "CooldownError" : String(err && err.message ? err.message : err),
          reason,
          at: Date.now(),
        });
      }
    });
  } finally {
    pollInFlight = false;
  }
}

async function runWebRtc(ip) {
  return runExclusive(webrtcSlot, async (signal) => {
    const result = await probeWebRtc(ip, { signal });
    await sendAck(chrome.runtime.sendMessage.bind(chrome.runtime), {
      type: MSG.WEBRTC_RESULT,
      result,
    });
    return result;
  });
}

async function runWorkerProbe() {
  try {
    return await probeExtensionWorker({
      Worker: globalThis.Worker,
      workerUrl: chrome.runtime.getURL(WORKER_PROBE_SCRIPT),
    });
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

start();
