/**
 * IP Echo 与 Geo Lookup 解耦。
 *
 * onEcho 必须快速 ACK：最多写入一次语义状态，然后在后台跑 lookupGeo。
 * 调用方不得 await geo 才能进入下一轮 IP 探测。
 *
 * 同 IP + geo ready + 非 force：纯内存心跳，零 storage。
 * 不同 IP：abort 旧 Geo，启动新 Geo。
 * 同 IP 心跳：不得 abort 已有 Geo（含 manual RESYNC）。
 *
 * exitGeneration：可能改变出口优先级的 Echo 在任何 await 之前 ++。
 * persist / cache-hit / lookup commit / failGeo 全部认 generation。
 * 旧 Echo 在慢 persist 之后不得重启 Geo，也不得 abort 更新的 Geo。
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
  let exitGeneration = 0;
  let activeGeo = null;

  const stats = {
    storageSets: 0,
    geoLookups: 0,
    broadcasts: 0,
    cacheTouches: 0,
    geoAborts: 0,
    heartbeats: 0,
    commits: 0,
    discarded: 0,
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

  function isCurrent(generation) {
    return generation == null || generation === exitGeneration;
  }

  async function write(nextState, { cache, touch, generation } = {}) {
    if (!isCurrent(generation)) {
      stats.discarded += 1;
      return { discarded: true };
    }
    stats.storageSets += 1;
    stats.broadcasts += 1;
    state = nextState;
    if (cache) {
      geoCache = cache;
      if (touch) stats.cacheTouches += 1;
    }
    if (typeof persist === "function") {
      await persist({
        state: nextState,
        geoCache: cache ? geoCache : undefined,
      });
    }
    if (!isCurrent(generation)) {
      stats.discarded += 1;
      if (typeof persist === "function") {
        try {
          await persist({ state, geoCache });
        } catch {
          /* keep memory as source of truth */
        }
      }
      return { discarded: true };
    }
    return { ok: true };
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
      const myGeneration = exitGeneration;
      const wrote = await write(
        {
          ...state,
          echoStale: false,
          echoProvider: provider || state.echoProvider,
          lastError: "",
          lastSuccessfulEchoAt: ts,
        },
        { generation: myGeneration },
      );
      if (wrote.discarded) return { ok: true, ack: true, discarded: true };
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
    const myGeneration = ipChanged ? ++exitGeneration : exitGeneration;
    if (ipChanged && activeGeo) abortGeo();

    if (ipChanged) {
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
      const wrote = await write(pending, { generation: myGeneration });
      if (wrote.discarded) return { ok: true, ack: true, discarded: true, pending: true };
      const geoPromise = startGeo(ip, { force, reason, provider, bypass, generation: myGeneration });
      return { ok: true, ack: true, pending: true, geoStarted: !!geoPromise, geoPromise };
    }

    if (state && state.echoStale) {
      const wrote = await write(
        {
          ...state,
          echoStale: false,
          echoProvider: provider || state.echoProvider,
          lastSuccessfulEchoAt: ts,
        },
        { generation: myGeneration },
      );
      if (wrote.discarded) return { ok: true, ack: true, discarded: true };
    } else if (!samePendingIp(ip) && !(state && state.geoStatus === "ready")) {
      const wrote = await write(
        {
          ...(state || {}),
          pendingIp: ip,
          geoStatus: state && state.geoStatus === "error" ? "error" : "pending",
          lastCheckedAt: ts,
          echoProvider: provider || (state && state.echoProvider) || "",
          echoStale: false,
          lastSuccessfulEchoAt: ts,
        },
        { generation: myGeneration },
      );
      if (wrote.discarded) return { ok: true, ack: true, discarded: true };
    }

    const geoPromise = startGeo(ip, { force, reason, provider, bypass, generation: myGeneration });
    return { ok: true, ack: true, geoStarted: !!geoPromise, geoPromise };
  }

  function startGeo(ip, { force, reason, provider, bypass, generation }) {
    const gen = generation == null ? exitGeneration : generation;
    if (!isCurrent(gen)) return null;

    if (activeGeo && ipsEqual(activeGeo.ip, ip)) {
      return activeGeo.promise;
    }
    if (activeGeo && !ipsEqual(activeGeo.ip, ip)) {
      if (!isCurrent(gen)) return null;
      abortGeo();
    }

    if (!force) {
      const cached = geoCacheGet(geoCache, ip);
      if (cached && isCacheFresh(cached, now())) {
        return runGeoTask({
          ip,
          generation: gen,
          reason: reason || "cache",
          force: false,
          provider,
          cacheRecord: cached,
        });
      }
      if (shouldSkipGeoRetry(state, ip, now())) return null;
    }

    if (typeof lookupGeo !== "function") return null;
    return runGeoTask({
      ip,
      generation: gen,
      reason,
      force,
      provider,
      bypass,
    });
  }

  function runGeoTask({ ip, generation, reason, force, provider, bypass, cacheRecord }) {
    if (!isCurrent(generation)) return null;
    const abort = new AbortController();
    const task = {
      ip,
      generation,
      reason,
      force,
      abort,
      cacheHit: !!cacheRecord,
    };
    if (!cacheRecord) stats.geoLookups += 1;
    activeGeo = task;
    const promise = (async () => {
      try {
        if (!isCurrent(generation) || abort.signal.aborted || activeGeo !== task) {
          return { discarded: true };
        }
        if (cacheRecord) {
          await commitRecord(ip, maybeReapply(cacheRecord, ip), provider, generation);
          if (!isCurrent(generation)) return { discarded: true };
          return { ok: true, ip, cache: true };
        }
        const looked = await lookupGeo(ip, { signal: abort.signal, bypassCooldown: bypass });
        if (!isCurrent(generation) || activeGeo !== task || abort.signal.aborted) {
          return { discarded: true };
        }
        if (!ipsEqual(looked.ip, ip)) {
          throw new Error(`geo ip mismatch: ${looked.ip} != ${ip}`);
        }
        await commitLooked(ip, looked, provider, generation);
        if (!isCurrent(generation)) return { discarded: true };
        return { ok: true, ip };
      } catch (err) {
        if ((err && err.name === "AbortError") || activeGeo !== task || !isCurrent(generation)) {
          return { discarded: true };
        }
        await failGeo(ip, err, generation);
        return { ok: false, error: String(err && err.message ? err.message : err) };
      } finally {
        if (activeGeo === task) activeGeo = null;
      }
    })();
    task.promise = promise;
    return promise;
  }

  async function commitLooked(ip, looked, provider, generation) {
    if (!isCurrent(generation)) return { discarded: true };
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
    return commitRecord(ip, record, provider, generation);
  }

  async function commitRecord(ip, record, provider, generation) {
    if (!isCurrent(generation)) return { discarded: true };
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
    const wrote = await write(next, { cache, touch: true, generation });
    if (wrote.discarded) return { discarded: true };
    stats.commits += 1;
    if (shouldProbe && typeof probeWebrtc === "function") {
      if (!isCurrent(generation)) return { discarded: true };
      try {
        await probeWebrtc(ip);
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  }

  async function failGeo(ip, err, generation) {
    if (!isCurrent(generation)) return { discarded: true };
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
    return write(next, { generation });
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
    const myGeneration = exitGeneration;
    const next = applyEchoFailure(
      { ...(state || {}), lastSuccessfulEchoAt },
      { error: error || (cooling ? "CooldownError" : ""), now: ts },
    );
    const wrote = await write(next, { generation: myGeneration });
    if (wrote.discarded) return { ok: true, ack: true, discarded: true };
    return { ok: true, ack: true, cooling: !!cooling, stale: true };
  }

  async function onWebRtcResult(result) {
    const checked = result && (result.checkedForIp || result.ip);
    if (state && state.ip && checked && !ipsEqual(checked, state.ip)) {
      return { ok: true, discarded: true };
    }
    const myGeneration = exitGeneration;
    const next = {
      ...(state || {}),
      webrtc: {
        ...(result || {}),
        checkedForIp: canonicalizeIp(checked || (state && state.ip) || ""),
        checkedAt: now(),
      },
    };
    const wrote = await write(next, { generation: myGeneration });
    if (wrote.discarded) return { ok: true, discarded: true };
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
      cacheHit: !!activeGeo.cacheHit,
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
    getExitGeneration: () => exitGeneration,
    echoStaleNow,
  };
}
