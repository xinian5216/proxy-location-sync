/**
 * IP Echo 与 Geo Lookup 解耦。
 *
 * onEcho 必须快速 ACK：最多写入一次语义状态，然后在后台跑 lookupGeo。
 * 调用方不得 await geo 才能进入下一轮 IP 探测。
 *
 * 同 IP + geo ready + 非 force：纯内存心跳，零 storage。
 * 不同 IP：abort 旧 Geo，启动新 Geo。
 * 同 IP 心跳：不得 abort 已有 Geo（含 manual RESYNC）。
 */

import { DEFAULT_SETTINGS, ECHO_STALE_MS, GEO_CACHE_LIMIT } from "./constants.js";
import {
  geoCacheGet,
  geoCacheKey,
  isCacheFresh,
  nextGeoRetryAt,
  shouldSkipGeoRetry,
} from "./detect-engine.js";
import { applyEchoFailure } from "./echo-stale.js";
import { applyLocationMode } from "./geo.js";
import { canonicalizeIp, ipsEqual, isPublicIp } from "./ip-compare.js";
import { webrtcForCommit } from "./webrtc.js";

export function createExitPipeline({
  now = () => Date.now(),
  lookupGeo,
  persist,
  probeWebrtc,
  applyMode = applyLocationMode,
} = {}) {
  let settings = { ...DEFAULT_SETTINGS };
  let state = null;
  let geoCache = {};
  let lastSuccessfulEchoAt = 0;
  let geoGen = 0;
  let activeGeo = null;

  const stats = {
    storageSets: 0,
    geoLookups: 0,
    broadcasts: 0,
    cacheTouches: 0,
    geoAborts: 0,
    heartbeats: 0,
    commits: 0,
  };

  function snapshot() {
    return {
      settings: { ...settings },
      state: state ? { ...state } : null,
      geoCache: { ...geoCache },
    };
  }

  function hydrate(data = {}) {
    if (data.settings) settings = { ...DEFAULT_SETTINGS, ...data.settings };
    if (Object.prototype.hasOwnProperty.call(data, "state")) state = data.state;
    if (data.geoCache) geoCache = { ...data.geoCache };
    const persisted = state && Number(state.lastSuccessfulEchoAt);
    if (Number.isFinite(persisted) && persisted > lastSuccessfulEchoAt) {
      lastSuccessfulEchoAt = persisted;
    }
  }

  function setSettings(next) {
    settings = { ...DEFAULT_SETTINGS, ...next };
  }

  async function write(nextState, { cache, touch } = {}) {
    stats.storageSets += 1;
    stats.broadcasts += 1;
    state = nextState;
    if (cache) {
      geoCache = cache;
      if (touch) stats.cacheTouches += 1;
    }
    if (typeof persist === "function") {
      await persist({
        state,
        geoCache: cache ? geoCache : undefined,
      });
    }
  }

  function echoStaleNow(ts = now()) {
    if (!lastSuccessfulEchoAt) return false;
    return ts - lastSuccessfulEchoAt > ECHO_STALE_MS;
  }

  function abortGeo() {
    if (!activeGeo) return;
    stats.geoAborts += 1;
    try {
      activeGeo.abort.abort();
    } catch {
      /* ignore */
    }
    activeGeo = null;
  }

  function sameCommittedIp(ip) {
    return !!(state && state.ip && ipsEqual(state.ip, ip));
  }

  function samePendingIp(ip) {
    return !!(state && state.pendingIp && ipsEqual(state.pendingIp, ip));
  }

  function isReadySameIp(ip) {
    return (
      sameCommittedIp(ip) &&
      state.geoStatus === "ready" &&
      !state.pendingIp
    );
  }

  async function onEcho({ ip, provider = "", reason = "echo", forceGeo = false } = {}) {
    const ts = now();
    const force = !!(forceGeo || reason === "resync");
    const bypass = force || reason === "manual" || reason === "resync";

    if (!isPublicIp(ip)) {
      return onEchoFailure({ error: "invalid ip", cooling: false });
    }

    lastSuccessfulEchoAt = ts;

    if (isReadySameIp(ip) && !force && !(state && state.echoStale)) {
      stats.heartbeats += 1;
      return { ok: true, ack: true, heartbeat: true };
    }

    if (isReadySameIp(ip) && !force && state && state.echoStale) {
      await write({
        ...state,
        echoStale: false,
        echoProvider: provider || state.echoProvider,
        lastError: "",
        lastSuccessfulEchoAt: ts,
      });
      return { ok: true, ack: true, recovered: true };
    }

    if (!force && activeGeo && ipsEqual(activeGeo.ip, ip)) {
      stats.heartbeats += 1;
      return { ok: true, ack: true, heartbeat: true, geoInFlight: true };
    }

    if (
      !force &&
      sameCommittedIp(ip) &&
      state &&
      state.geoStatus === "error" &&
      shouldSkipGeoRetry(state, ip, ts)
    ) {
      stats.heartbeats += 1;
      return { ok: true, ack: true, heartbeat: true };
    }

    const ipChanged = !sameCommittedIp(ip);
    if (ipChanged) {
      if (activeGeo) abortGeo();
      const pending = {
        ...(state || {}),
        pendingIp: ip,
        geoStatus: "pending",
        lastCheckedAt: ts,
        lastError: "",
        echoProvider: provider,
        echoStale: false,
        lastSuccessfulEchoAt: ts,
        webrtc: state && state.ip
          ? {
              status: "unknown",
              reason: "exit changed; probe pending",
              checkedForIp: ip,
            }
          : (state && state.webrtc) || undefined,
      };
      await write(pending);
      const geoPromise = startGeo(ip, { force, reason, provider, bypass });
      return { ok: true, ack: true, pending: true, geoStarted: !!geoPromise, geoPromise };
    }

    if (state && state.echoStale) {
      await write({
        ...state,
        echoStale: false,
        echoProvider: provider || state.echoProvider,
        lastSuccessfulEchoAt: ts,
      });
    } else if (!samePendingIp(ip) && !(state && state.geoStatus === "ready")) {
      await write({
        ...(state || {}),
        pendingIp: ip,
        geoStatus: state && state.geoStatus === "error" ? "error" : "pending",
        lastCheckedAt: ts,
        echoProvider: provider || (state && state.echoProvider) || "",
        echoStale: false,
        lastSuccessfulEchoAt: ts,
      });
    }

    const geoPromise = startGeo(ip, { force, reason, provider, bypass });
    return { ok: true, ack: true, geoStarted: !!geoPromise, geoPromise };
  }

  function startGeo(ip, { force, reason, provider, bypass }) {
    if (activeGeo && ipsEqual(activeGeo.ip, ip)) {
      return activeGeo.promise;
    }
    if (activeGeo && !ipsEqual(activeGeo.ip, ip)) abortGeo();

    if (!force) {
      const cached = geoCacheGet(geoCache, ip);
      if (cached && isCacheFresh(cached, now())) {
        const promise = Promise.resolve().then(() =>
          commitRecord(ip, maybeReapply(cached, ip), provider),
        );
        return promise;
      }
      if (shouldSkipGeoRetry(state, ip, now())) return null;
    }

    if (typeof lookupGeo !== "function") return null;

    const abort = new AbortController();
    const generation = ++geoGen;
    const task = { ip, generation, reason, force, abort };
    stats.geoLookups += 1;
    const promise = (async () => {
      try {
        const looked = await lookupGeo(ip, { signal: abort.signal, bypassCooldown: bypass });
        if (activeGeo !== task || abort.signal.aborted) return { discarded: true };
        if (!ipsEqual(looked.ip, ip)) {
          throw new Error(`geo ip mismatch: ${looked.ip} != ${ip}`);
        }
        await commitLooked(ip, looked, provider);
        return { ok: true, ip };
      } catch (err) {
        if ((err && err.name === "AbortError") || activeGeo !== task) {
          return { discarded: true };
        }
        await failGeo(ip, err);
        return { ok: false, error: String(err && err.message ? err.message : err) };
      } finally {
        if (activeGeo === task) activeGeo = null;
      }
    })();
    task.promise = promise;
    activeGeo = task;
    return promise;
  }

  async function commitLooked(ip, looked, provider) {
    const ts = now();
    const applied = applyMode(looked.latitude, looked.longitude, ip, settings.locationMode);
    const record = {
      ip,
      country: looked.country,
      countryCode: looked.countryCode,
      region: looked.region,
      city: looked.city,
      rawLatitude: looked.latitude,
      rawLongitude: looked.longitude,
      latitude: applied.latitude,
      longitude: applied.longitude,
      accuracy: applied.accuracy,
      offsetKm: applied.offsetKm,
      timezone: looked.timezone,
      isp: looked.isp,
      provider: looked.provider,
      locationMode: settings.locationMode,
      fetchedAt: ts,
    };
    await commitRecord(ip, record, provider);
  }

  async function commitRecord(ip, record, provider) {
    const ts = now();
    const ipChanged = !(state && state.ip && ipsEqual(state.ip, ip));
    const { webrtc, shouldProbe } = webrtcForCommit(state && state.webrtc, ip);
    const next = {
      ip,
      previousIp: ipChanged && state ? state.ip : (state && state.previousIp) || "",
      country: record.country,
      countryCode: record.countryCode,
      region: record.region,
      city: record.city,
      rawLatitude: record.rawLatitude,
      rawLongitude: record.rawLongitude,
      latitude: record.latitude,
      longitude: record.longitude,
      accuracy: record.accuracy,
      offsetKm: record.offsetKm,
      timezone: record.timezone,
      isp: record.isp,
      provider: record.provider,
      echoProvider: provider || (state && state.echoProvider) || "",
      lastCheckedAt: ts,
      geoFetchedAt: record.fetchedAt,
      ipChangedAt: ipChanged ? ts : (state && state.ipChangedAt) || ts,
      lastError: "",
      pendingIp: "",
      geoStatus: "ready",
      nextGeoRetryAt: 0,
      geoFailCount: 0,
      echoStale: false,
      lastSuccessfulEchoAt: lastSuccessfulEchoAt || ts,
      webrtc,
    };
    const cache = touchCache(geoCache, ip, record);
    stats.commits += 1;
    await write(next, { cache, touch: true });
    if (shouldProbe && typeof probeWebrtc === "function") {
      try {
        await probeWebrtc(ip);
      } catch {
        /* ignore */
      }
    }
  }

  async function failGeo(ip, err) {
    const ts = now();
    const failCount = (state && state.geoFailCount) || 0;
    const retryAt =
      err && err.name === "CooldownError" && err.nextRetryAt
        ? err.nextRetryAt
        : nextGeoRetryAt(ts, failCount + 1);
    const next = {
      ...(state || {}),
      pendingIp: ip,
      geoStatus: "error",
      lastCheckedAt: ts,
      lastError: String(err && err.message ? err.message : err),
      nextGeoRetryAt: retryAt,
      geoFailCount: failCount + 1,
      echoStale: false,
    };
    await write(next);
  }

  async function onEchoFailure({ error, cooling } = {}) {
    const ts = now();
    const stale = echoStaleNow(ts);
    if (!stale) {
      return { ok: true, ack: true, cooling: !!cooling, stale: false };
    }
    if (state && state.echoStale) {
      return { ok: true, ack: true, cooling: !!cooling, stale: true };
    }
    const next = applyEchoFailure(
      { ...(state || {}), lastSuccessfulEchoAt },
      { error: error || (cooling ? "CooldownError" : ""), now: ts },
    );
    await write(next);
    return { ok: true, ack: true, cooling: !!cooling, stale: true };
  }

  async function onWebRtcResult(result) {
    const checked = result && (result.checkedForIp || result.ip);
    if (state && state.ip && checked && !ipsEqual(checked, state.ip)) {
      return { ok: true, discarded: true };
    }
    const next = {
      ...(state || {}),
      webrtc: {
        ...(result || {}),
        checkedForIp: canonicalizeIp(checked || (state && state.ip) || ""),
        checkedAt: now(),
      },
    };
    await write(next);
    return { ok: true };
  }

  function maybeReapply(cached, ip) {
    if (cached.locationMode === settings.locationMode) return cached;
    const applied = applyMode(cached.rawLatitude, cached.rawLongitude, ip, settings.locationMode);
    return { ...cached, ...applied, locationMode: settings.locationMode };
  }

  function touchCache(cache, ip, record) {
    const key = geoCacheKey(ip);
    const next = { ...cache, [key]: { ...record, ip, lastUsedAt: now() } };
    if (ip !== key) delete next[ip];
    const keys = Object.keys(next);
    if (keys.length <= GEO_CACHE_LIMIT) return next;
    const sorted = keys.sort((a, b) => (next[a].lastUsedAt || 0) - (next[b].lastUsedAt || 0));
    for (const k of sorted.slice(0, keys.length - GEO_CACHE_LIMIT)) delete next[k];
    return next;
  }

  function stop() {
    abortGeo();
  }

  function activeGeoTask() {
    if (!activeGeo) return null;
    return {
      ip: activeGeo.ip,
      reason: activeGeo.reason,
      force: activeGeo.force,
      generation: activeGeo.generation,
      promise: activeGeo.promise,
    };
  }

  return {
    hydrate,
    snapshot,
    setSettings,
    onEcho,
    onEchoFailure,
    onWebRtcResult,
    stop,
    stats,
    activeGeoTask,
    getLastSuccessfulEchoAt: () => lastSuccessfulEchoAt,
    echoStaleNow,
  };
}
