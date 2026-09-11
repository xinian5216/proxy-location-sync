/**
 * Chromium：MV3 service worker。Firefox：MV3 event page（同一文件）。
 *
 * IP Echo 快速 ACK；Geo lookup 是独立可取消任务。
 * 同 IP 心跳不写 storage。
 * 诊断与核心同步隔离：失败只写 unknown，绝不 await 进 persistFromPipeline。
 *
 * Firefox 无 Offscreen：用 `pls-firefox-poll` alarm 唤醒 Event Page 做 Echo。
 * 不得用 setTimeout 循环（MDN：idle 后 DOM timer 不可靠）。
 * generic Event Page load 只 hydrate / badge / 确保 alarm，不额外 Echo。
 * 异常一律 fail-closed，不得把网页退回真实 GPS。
 */

import {
  ALARM_DNS,
  ALARM_FIREFOX_POLL,
  ALARM_KEEPALIVE,
  DEFAULT_SETTINGS,
  DNS_ALARM_MINUTES,
  MSG,
  STORAGE_KEYS,
} from "../lib/constants.js";
import { ext, isServiceWorkerScope, shouldUseOffscreen } from "../lib/browser-api.js";
import { collectBrowserEnvironment } from "../lib/diagnostics.js";
import { createDiagnosticsController } from "../lib/diagnostics-runner.js";
import { createDnsProbe } from "../lib/dns-providers.js";
import { createExitPipeline } from "../lib/exit-pipeline.js";
import { applyLocationMode } from "../lib/geo.js";
import { lookupGeo } from "../lib/geo-providers.js";
import { isPublicIp } from "../lib/ip-compare.js";
import { detectPublicIp, ipHealth } from "../lib/ip-providers.js";
import {
  planFirefoxPolling,
  shouldImmediateEcho,
} from "../lib/firefox-poll.js";
import { pickBackgroundPoller, runWebrtcProbe, runWorkerProbe } from "../lib/platform-runtime.js";
import { nextPollDelayMs } from "../lib/poll-sleep.js";
import { createPollerSupervisor } from "../lib/poller-mode.js";
import { collectTabIds } from "../lib/tab-targets.js";
import { updateBadge } from "../lib/badge.js";
import { probeWebRtc } from "../lib/webrtc.js";
import { probeExtensionWorker, WORKER_PROBE_SCRIPT } from "../lib/worker-probe.js";

const OFFSCREEN_URL = "offscreen/offscreen.html";
const DIAGNOSTICS_URL = "diagnostics/diagnostics.html";

const poller = createPollerSupervisor();
let creatingOffscreen = null;
let swLoop = null;
let swLoopStopped = true;
let prepareGate = null;
const seenTabs = new Map();

const pipeline = createExitPipeline({
  lookupGeo,
  persist: persistFromPipeline,
  probeWebrtc: (ip) => routeWebrtc(ip),
});

const dnsProbe = createDnsProbe();
const diagnosticsCtrl = createDiagnosticsController({
  lookupDns: (opts) => dnsProbe.lookup(opts),
  persist: persistDiagnostics,
  probePage: probeHttpPageEnv,
  probeWorker: probeWorkerRouted,
});

ext.runtime.onInstalled.addListener(() => {
  void boot("installed");
});
ext.runtime.onStartup.addListener(() => {
  void boot("startup");
});
if (isServiceWorkerScope()) {
  self.addEventListener("activate", () => {
    void boot("activate");
  });
}

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_KEEPALIVE) void onKeepAlive();
  if (alarm.name === ALARM_DNS) void runDiagnosticsSafe({ force: false, reason: "auto" });
  if (alarm.name === ALARM_FIREFOX_POLL) void onFirefoxPoll();
});

ext.webNavigation.onCommitted.addListener((details) => {
  if (details && details.tabId >= 0) seenTabs.set(details.tabId, Date.now());
  void injectBootstrap(details);
});

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message)
    .then((result) => sendResponse(stripPromises(result)))
    .catch((err) => {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    });
  return true;
});

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEYS.settings]) {
    void onSettingsChanged(changes[STORAGE_KEYS.settings].newValue);
  }
});

function stripPromises(result) {
  if (!result || typeof result !== "object") return result;
  const { geoPromise, ...rest } = result;
  void geoPromise;
  return rest;
}

async function persistFromPipeline({ state, geoCache }) {
  const payload = {};
  if (state !== undefined) payload[STORAGE_KEYS.state] = state;
  if (geoCache !== undefined) payload[STORAGE_KEYS.geoCache] = geoCache;
  if (Object.keys(payload).length) await ext.storage.local.set(payload);
  const snap = pipeline.snapshot();
  await refreshAction(snap.state, snap.settings);
  scheduleDiagnostics("state-change");
}

function scheduleDiagnostics(reason = "auto") {
  void runDiagnosticsSafe({ force: false, reason });
}

async function persistDiagnostics(diag) {
  await ext.storage.local.set({ [STORAGE_KEYS.diagnostics]: diag });
}

async function runDiagnosticsSafe({ force = false, reason, locale, environment, worker } = {}) {
  try {
    const snap = pipeline.snapshot();
    const local = collectBrowserEnvironment();
    await diagnosticsCtrl.run({
      state: snap.state,
      settings: snap.settings,
      locale: locale || local.locale,
      environment: environment || local.environment,
      worker,
      force,
      reason: reason || (force ? "manual" : "auto"),
    });
  } catch {
    /* 诊断挂掉不得影响 IP / Geo / Timezone */
  }
}

async function probeHttpPageEnv() {
  let tabs = [];
  try {
    tabs = await ext.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return null;
  }
  const ordered = [...tabs.filter((t) => t.active), ...tabs.filter((t) => !t.active)];
  for (const tab of ordered) {
    if (typeof tab.id !== "number") continue;
    try {
      const res = await ext.tabs.sendMessage(tab.id, { type: MSG.PAGE_ENV_PROBE }, { frameId: 0 });
      if (res && res.env) return res.env;
    } catch {
      /* 该标签没有 content script */
    }
  }
  return null;
}

async function probeExtensionWorkerOffscreen() {
  try {
    if (!(await hasOffscreenDocument())) {
      return { ok: false, reason: "Worker unavailable" };
    }
    const result = await ext.runtime.sendMessage({ type: MSG.OFFSCREEN_WORKER_PROBE });
    if (!result || typeof result !== "object") {
      return { ok: false, reason: "Worker unavailable" };
    }
    if (result.ok === true || result.ok === false) return result;
    return { ok: false, reason: "Worker unavailable" };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

async function probeExtensionWorkerLocal() {
  try {
    if (typeof Worker !== "function") {
      return { ok: false, reason: "Worker unavailable" };
    }
    return await probeExtensionWorker({
      Worker,
      workerUrl: ext.runtime.getURL(WORKER_PROBE_SCRIPT),
    });
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

async function probeWorkerRouted() {
  const offscreenAvailable = shouldUseOffscreen(ext);
  return runWorkerProbe({
    offscreenAvailable,
    hasOffscreenDocument,
    probeOffscreen: probeExtensionWorkerOffscreen,
    probeLocal: offscreenAvailable ? undefined : probeExtensionWorkerLocal,
  });
}

async function routeWebrtc(ip) {
  const offscreenAvailable = shouldUseOffscreen(ext);
  const result = await runWebrtcProbe({
    offscreenAvailable,
    probeOffscreen: (targetIp) => tellOffscreen({ type: MSG.OFFSCREEN_WEBRTC, ip: targetIp }),
    probeLocal: offscreenAvailable ? undefined : () => probeWebRtc(ip),
    ip,
  });
  if (result && typeof result === "object" && result.status) {
    return pipeline.onWebRtcResult(result);
  }
}

async function prepare(reason) {
  await ensureDefaults();
  await hydrateFromStorage();
  const snap = pipeline.snapshot();
  await refreshAction(snap.state, snap.settings);
  await ext.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 1 });
  await ext.alarms.create(ALARM_DNS, { periodInMinutes: DNS_ALARM_MINUTES });
  if (snap.settings.enabled) {
    await startPolling(snap.settings);
  } else {
    await stopBackgroundWork();
  }
  void reason;
}

function prepareOnce(reason = "load") {
  if (!prepareGate) {
    prepareGate = prepare(reason).catch((err) => {
      prepareGate = null;
      throw err;
    });
  }
  return prepareGate;
}

async function boot(reason) {
  await prepareOnce(reason);
  if (
    shouldImmediateEcho(reason, { offscreenAvailable: shouldUseOffscreen(ext) })
  ) {
    await kickEcho(reason);
  }
  scheduleDiagnostics("auto");
}

async function hydrateFromStorage() {
  const data = await ext.storage.local.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.state,
    STORAGE_KEYS.geoCache,
    STORAGE_KEYS.diagnostics,
  ]);
  pipeline.hydrate({
    settings: { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) },
    state: data[STORAGE_KEYS.state] || null,
    geoCache: data[STORAGE_KEYS.geoCache] || {},
  });
  diagnosticsCtrl.hydrate(data[STORAGE_KEYS.diagnostics] || null);
}

async function onKeepAlive() {
  const { settings } = pipeline.snapshot();
  if (!settings.enabled) return;
  await startPolling(settings);
  const snap = pipeline.snapshot();
  const detected = (snap.state && (snap.state.pendingIp || snap.state.ip)) || "";
  if (detected && diagnosticsCtrl.dnsNeedsRefresh(detected, false)) {
    scheduleDiagnostics("auto");
  }
}

async function onSettingsChanged(next) {
  const settings = { ...DEFAULT_SETTINGS, ...(next || {}) };
  pipeline.setSettings(settings);
  if (settings.enabled) {
    await startPolling(settings);
    await kickEcho("settings");
  } else {
    await stopBackgroundWork();
    await refreshAction(null, settings);
  }
}

async function startPolling(settings) {
  if (pickBackgroundPoller(ext) === "background") {
    applyPoller(poller.stopAll());
    await ensureFirefoxPollAlarm(settings);
    return;
  }
  await clearFirefoxPollAlarm();
  const ok = await ensureOffscreen();
  if (ok) {
    const sent = await tellOffscreen({ type: MSG.OFFSCREEN_START, intervalSec: settings.intervalSec });
    if (sent) {
      applyPoller(poller.onOffscreenReady());
      return;
    }
    try {
      await closeOffscreen();
    } catch {
      /* ignore */
    }
    const retried = await ensureOffscreen();
    const sent2 =
      retried &&
      (await tellOffscreen({ type: MSG.OFFSCREEN_START, intervalSec: settings.intervalSec }));
    if (sent2) {
      applyPoller(poller.onOffscreenReady());
      return;
    }
  }
  applyPoller(poller.onOffscreenFailed());
}

async function stopBackgroundWork() {
  pipeline.stop();
  applyPoller(poller.stopAll());
  await clearFirefoxPollAlarm();
  if (shouldUseOffscreen(ext)) {
    await tellOffscreen({ type: MSG.OFFSCREEN_STOP });
    await closeOffscreen();
  }
}

function applyPoller(action) {
  if (action.stopFallback) stopSwFallback();
  if (action.startFallback) startSwFallback();
}

async function handleMessage(message) {
  const type = message && message.type;
  if (type === MSG.GET_SNAPSHOT) return getSnapshot();
  if (type === MSG.SETTINGS_PATCH) return patchSettings(message.patch || {});
  if (type === MSG.DETECT_NOW) return detectNow();
  if (type === MSG.RESYNC) return resyncNow();
  if (type === MSG.IP_ECHO) return onIpEcho(message);
  if (type === MSG.WEBRTC_RESULT) return pipeline.onWebRtcResult(message.result);
  if (type === MSG.OPEN_OPTIONS) {
    await ext.runtime.openOptionsPage();
    return { ok: true };
  }
  if (type === MSG.OPEN_DIAGNOSTICS) {
    await ext.tabs.create({ url: ext.runtime.getURL(DIAGNOSTICS_URL) });
    return { ok: true };
  }
  if (type === MSG.DIAGNOSTICS_RUN) {
    await runDiagnosticsSafe({
      force: true,
      reason: "manual",
      locale: message.locale,
      environment: message.environment,
      worker: message.worker,
    });
    return getSnapshot();
  }
  return { ok: false, error: "unknown message" };
}

async function onIpEcho(message) {
  const ip = message && message.ip;
  if (!isPublicIp(ip)) {
    return pipeline.onEchoFailure({
      error: (message && message.error) || "invalid ip",
      cooling: message && message.error === "CooldownError",
    });
  }
  return pipeline.onEcho({
    ip,
    provider: message.provider,
    reason: message.reason || "echo",
    forceGeo: false,
  });
}

async function kickEcho(reason) {
  try {
    const echo = await detectPublicIp({ bypassCooldown: reason === "manual" || reason === "resync" });
    await pipeline.onEcho({ ip: echo.ip, provider: echo.provider, reason: reason || "boot" });
  } catch (err) {
    await pipeline.onEchoFailure({
      error: String(err && err.message ? err.message : err),
      cooling: err && err.name === "CooldownError",
    });
  }
}

async function detectNow() {
  const echo = await detectPublicIp({ bypassCooldown: true });
  await pipeline.onEcho({ ip: echo.ip, provider: echo.provider, reason: "manual" });
  return getSnapshot();
}

async function resyncNow() {
  const echo = await detectPublicIp({ bypassCooldown: true });
  const result = await pipeline.onEcho({
    ip: echo.ip,
    provider: echo.provider,
    reason: "resync",
    forceGeo: true,
  });
  if (result && result.geoPromise) {
    try {
      await result.geoPromise;
    } catch {
      /* failGeo already persisted */
    }
  }
  return getSnapshot();
}

async function patchSettings(patch) {
  const snap = pipeline.snapshot();
  const settings = { ...snap.settings, ...patch };
  const enabledFlipped =
    Object.prototype.hasOwnProperty.call(patch, "enabled") && patch.enabled !== snap.settings.enabled;
  const modeChanged = patch.locationMode && patch.locationMode !== snap.settings.locationMode;
  await ext.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  pipeline.setSettings(settings);

  if (modeChanged && snap.state && snap.state.ip && snap.state.rawLatitude != null) {
    const applied = applyLocationMode(
      snap.state.rawLatitude,
      snap.state.rawLongitude,
      snap.state.ip,
      settings.locationMode,
    );
    const state = {
      ...snap.state,
      latitude: applied.latitude,
      longitude: applied.longitude,
      accuracy: applied.accuracy,
      offsetKm: applied.offsetKm,
    };
    const geoCache = { ...snap.geoCache };
    const key = snap.state.ip;
    pipeline.hydrate({ settings, state, geoCache });
    await ext.storage.local.set({ [STORAGE_KEYS.state]: state, [STORAGE_KEYS.geoCache]: geoCache });
    await refreshAction(state, settings);
    void key;
  }

  if (settings.enabled) {
    await startPolling(settings);
  } else {
    await stopBackgroundWork();
  }
  if (enabledFlipped) {
    await pushToOpenPages(await getSnapshot());
  }
  scheduleDiagnostics("auto");
  return getSnapshot();
}

async function getSnapshot() {
  const snap = pipeline.snapshot();
  return {
    settings: snap.settings,
    state: snap.state,
    geoCache: snap.geoCache,
    diagnostics: diagnosticsCtrl.snapshot(),
  };
}

async function ensureDefaults() {
  const data = await ext.storage.local.get([STORAGE_KEYS.settings]);
  if (!data[STORAGE_KEYS.settings]) {
    await ext.storage.local.set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS } });
  }
}

async function hasOffscreenDocument() {
  if (!shouldUseOffscreen(ext)) return false;
  if (ext.offscreen && typeof ext.offscreen.hasDocument === "function") {
    return ext.offscreen.hasDocument();
  }
  if (typeof ext.runtime.getContexts !== "function") return false;
  try {
    const url = ext.runtime.getURL(OFFSCREEN_URL);
    const ctxs = await ext.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    return ctxs.length > 0;
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (!shouldUseOffscreen(ext)) return false;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    try {
      if (await hasOffscreenDocument()) return true;
      await ext.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WEB_RTC"],
        justification: "Poll the browser proxy exit IP and probe WebRTC ICE candidates for leaks.",
      });
      return true;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (/already exists|Only a single offscreen/i.test(msg)) return true;
      console.warn("[pls] offscreen create failed, SW fallback", msg);
      return false;
    } finally {
      creatingOffscreen = null;
    }
  })();
  return creatingOffscreen;
}

async function closeOffscreen() {
  if (!shouldUseOffscreen(ext)) return;
  try {
    if (await hasOffscreenDocument()) await ext.offscreen.closeDocument();
  } catch {
    /* already closed */
  }
}

async function tellOffscreen(payload) {
  if (!shouldUseOffscreen(ext)) return false;
  try {
    await ext.runtime.sendMessage(payload);
    return true;
  } catch {
    return false;
  }
}

function startSwFallback() {
  if (swLoop) return;
  swLoopStopped = false;
  swLoop = (async () => {
    while (!swLoopStopped) {
      try {
        const { settings } = pipeline.snapshot();
        if (!settings.enabled) break;
        const echo = await detectPublicIp({});
        await pipeline.onEcho({
          ip: echo.ip,
          provider: echo.provider,
          reason: "sw-fallback",
        });
      } catch (err) {
        try {
          await pipeline.onEchoFailure({
            error: String(err && err.message ? err.message : err),
            cooling: err && err.name === "CooldownError",
          });
        } catch {
          /* keep looping */
        }
      }
      const { settings } = pipeline.snapshot();
      await new Promise((r) => setTimeout(r, nextPollDelayMs(settings.intervalSec, ipHealth.nextRetryAt())));
    }
    swLoop = null;
  })();
}

function stopSwFallback() {
  swLoopStopped = true;
}

async function ensureFirefoxPollAlarm(settings) {
  let existing = null;
  try {
    existing = await ext.alarms.get(ALARM_FIREFOX_POLL);
  } catch {
    existing = null;
  }
  const plan = planFirefoxPolling({
    enabled: !!(settings && settings.enabled),
    offscreenAvailable: shouldUseOffscreen(ext),
    existingAlarm: existing,
    intervalSec: settings && settings.intervalSec,
  });
  if (plan.action === "clear" || plan.action === "create") {
    await clearFirefoxPollAlarm();
  }
  if (plan.action === "create") {
    await ext.alarms.create(ALARM_FIREFOX_POLL, plan.info);
  }
  return plan;
}

async function clearFirefoxPollAlarm() {
  try {
    await ext.alarms.clear(ALARM_FIREFOX_POLL);
  } catch {
    /* ignore */
  }
}

async function onFirefoxPoll() {
  if (shouldUseOffscreen(ext)) return;
  await prepareOnce("poll");
  const { settings } = pipeline.snapshot();
  if (!settings.enabled) {
    await clearFirefoxPollAlarm();
    return;
  }
  await ensureFirefoxPollAlarm(settings);
  await kickEcho("poll");
}

async function refreshAction(state, settings) {
  await updateBadge(ext.action, state, settings && settings.enabled);
}

async function injectBootstrap(details) {
  if (!details || !details.url || !/^https?:/.test(details.url)) return;
  try {
    const snap = await getSnapshot();
    await ext.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      world: "MAIN",
      injectImmediately: true,
      func: bootstrapMainWorld,
      args: [snap.state, snap.settings],
    });
  } catch {
    /* chrome:// / PDF / 无 host 权限 */
  }
}

async function pushToOpenPages(snap) {
  let queried = [];
  try {
    queried = await ext.tabs.query({});
  } catch {
    queried = [];
  }
  const tabIds = collectTabIds(seenTabs.keys(), queried);
  for (const tabId of tabIds) {
    try {
      await ext.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: bootstrapMainWorld,
        args: [snap.state, snap.settings],
      });
      seenTabs.set(tabId, Date.now());
    } catch {
      seenTabs.delete(tabId);
    }
  }
}

function bootstrapMainWorld(state, settings) {
  globalThis.__PLS_BOOTSTRAP__ = { state, settings };
  if (typeof globalThis.__PLS_APPLY__ === "function") {
    globalThis.__PLS_APPLY__({ state, settings });
  }
}

void boot("load");
