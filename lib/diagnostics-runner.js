/**
 * 诊断编排。失败只写 unknown，绝不抛到 IP Echo / Geo 路径。
 *
 * 优先级（同 detected IP）：
 *   新出口 > manual force > ordinary auto
 * 不同 detected IP：新出口永远抢占（含正在跑的 manual）。
 * 同 IP 的 auto 不得 abort 正在进行的 manual；可 coalesce 到 manual promise。
 */

import { DNS_CACHE_MS, DNS_FAIL_CACHE_MS } from "./constants.js";
import {
  buildDiagnostics,
  committedGeoIp,
  detectedExitIp,
  diagnosticsFingerprint,
  isDnsTechnicalFailure,
  isSwitchingExit,
  runIsolated,
  usableDnsResolvers,
} from "./diagnostics.js";
import { ipsEqual } from "./ip-compare.js";
import { viewWebRtc } from "./webrtc.js";

export function dnsTtlMs(cache) {
  return isDnsTechnicalFailure(cache) ? DNS_FAIL_CACHE_MS : DNS_CACHE_MS;
}

export function dnsCacheValid(cache, exitIp, now = Date.now(), ttl) {
  if (!cache || !exitIp) return false;
  if (!cache.checkedForIp || !ipsEqual(cache.checkedForIp, exitIp)) return false;
  if (!Number.isFinite(cache.checkedAt)) return false;
  const used = Number.isFinite(ttl) ? ttl : dnsTtlMs(cache);
  return now - cache.checkedAt < used;
}

function isAbortLike(err) {
  if (!err) return false;
  if (typeof err === "object" && err.name === "AbortError") return true;
  return /abort/i.test(String(err && err.message ? err.message : err));
}

export function normalizeDiagnosticsReason(reason, force = false) {
  if (reason === "manual") return "manual";
  if (reason === "state-change") return "state-change";
  if (reason === "auto") return force ? "manual" : "auto";
  return force ? "manual" : "auto";
}

function isManualRun(run) {
  return !!(run && (run.reason === "manual" || run.force));
}

/** 是否让 incoming 替换 active。不同 IP 永远 true。 */
export function diagnosticsShouldSupersede(active, incoming) {
  if (!active) return true;
  const activeIp = (active && active.detectedIp) || "";
  const nextIp = (incoming && incoming.detectedIp) || "";
  if (activeIp && nextIp && !ipsEqual(activeIp, nextIp)) return true;
  if (!activeIp && nextIp) return true;
  if (activeIp && !nextIp) return isManualRun(incoming);
  if (isManualRun(incoming)) return true;
  if (isManualRun(active)) return false;
  return true;
}

export function createDiagnosticsController({
  now = () => Date.now(),
  lookupDns,
  persist,
  probePage,
  probeWorker,
} = {}) {
  let last = null;
  let writes = 0;
  let dnsLookups = 0;
  let diagnosticsGeneration = 0;
  let activeRun = null;
  const stats = {
    writes: 0,
    dnsLookups: 0,
    runs: 0,
    failures: 0,
    discarded: 0,
    aborts: 0,
    skipped: 0,
  };

  function hydrate(data) {
    last = data || null;
  }

  function snapshot() {
    return last;
  }

  function isCurrent(gen) {
    return gen === diagnosticsGeneration;
  }

  function dnsNeedsRefresh(exitIp, force = false) {
    if (force) return true;
    const dns = last && last.dns;
    if (!dns) return true;
    return !dnsCacheValid(dns, exitIp, now());
  }

  function viewActive() {
    if (!activeRun) return null;
    return {
      generation: activeRun.generation,
      detectedIp: activeRun.detectedIp,
      force: activeRun.force,
      reason: activeRun.reason,
      aborted: !!(activeRun.controller && activeRun.controller.signal.aborted),
    };
  }

  async function persistIfChanged(next, myGeneration) {
    if (!isCurrent(myGeneration)) return { wrote: false, discarded: true };
    const prevFp = diagnosticsFingerprint(last);
    const nextFp = diagnosticsFingerprint(next);
    if (prevFp && prevFp === nextFp) {
      if (!isCurrent(myGeneration)) return { wrote: false, discarded: true };
      last = next;
      return { wrote: false };
    }
    if (!isCurrent(myGeneration)) return { wrote: false, discarded: true };
    if (typeof persist === "function") {
      try {
        await persist(next);
      } catch {
        /* storage 失败不得让诊断变成抛出 */
      }
    }
    if (!isCurrent(myGeneration)) {
      if (last && last !== next && typeof persist === "function") {
        try {
          await persist(last);
        } catch {
          /* ignore */
        }
      }
      return { wrote: false, discarded: true };
    }
    last = next;
    writes += 1;
    stats.writes = writes;
    return { wrote: true };
  }

  async function execute(opts, myRun) {
    const { state, settings, locale, environment, page, worker, force } = opts;
    const signal = myRun.controller.signal;
    const myGeneration = myRun.generation;

    const isolated = await runIsolated(async () => {
      if (!isCurrent(myGeneration) || signal.aborted) return { discarded: true };

      const detectedIp = detectedExitIp(state);
      const committedIp = committedGeoIp(state);
      const switching = isSwitchingExit(state);

      let dnsInput = (last && last.dns) || { resolvers: [] };
      if (detectedIp && dnsNeedsRefresh(detectedIp, force) && typeof lookupDns === "function") {
        dnsLookups += 1;
        stats.dnsLookups = dnsLookups;
        const lookedIso = await runIsolated(() => lookupDns({ bypassCooldown: force, signal }));
        if (!isCurrent(myGeneration) || signal.aborted || isAbortLike(lookedIso.error)) {
          return { discarded: true };
        }
        if (lookedIso.ok && lookedIso.value) {
          const looked = lookedIso.value;
          if (isAbortLike(looked.error) || looked.aborted) return { discarded: true };
          const usable = usableDnsResolvers(looked.resolvers);
          if (!usable.length) {
            dnsInput = {
              resolvers: [],
              provider: looked.provider || "",
              error: looked.error || "no usable DNS resolvers",
              timedOut: !!looked.timedOut,
              checkedAt: now(),
              checkedForIp: detectedIp,
              technicalFailure: true,
            };
          } else {
            dnsInput = {
              resolvers: usable,
              provider: looked.provider || "",
              error: looked.error || "",
              timedOut: !!looked.timedOut,
              checkedAt: now(),
              checkedForIp: detectedIp,
              technicalFailure: isDnsTechnicalFailure({
                resolvers: usable,
                error: looked.error,
                timedOut: looked.timedOut,
              }),
            };
          }
        } else {
          dnsInput = {
            resolvers: [],
            provider: "",
            error: lookedIso.error || "dns failed",
            timedOut: /timeout/i.test(String(lookedIso.error || "")),
            checkedAt: now(),
            checkedForIp: detectedIp,
            technicalFailure: true,
          };
        }
      } else if (dnsInput) {
        dnsInput = { ...dnsInput, checkedForIp: dnsInput.checkedForIp || detectedIp };
      }

      if (!isCurrent(myGeneration) || signal.aborted) return { discarded: true };

      let pageEnv = page || null;
      if (!pageEnv && typeof probePage === "function") {
        const probed = await runIsolated(() => probePage(signal));
        if (!isCurrent(myGeneration) || signal.aborted) return { discarded: true };
        pageEnv = probed.ok ? probed.value : null;
        if (pageEnv && pageEnv.ok === false) pageEnv = null;
      }

      if (!isCurrent(myGeneration) || signal.aborted) return { discarded: true };

      let workerEnv = worker || null;
      if (!workerEnv && typeof probeWorker === "function") {
        const probedW = await runIsolated(() => probeWorker(signal));
        if (!isCurrent(myGeneration) || signal.aborted) return { discarded: true };
        if (probedW.ok && probedW.value) workerEnv = probedW.value;
        else workerEnv = { ok: false, reason: probedW.error || "未能探测 Worker" };
      }

      if (!isCurrent(myGeneration) || signal.aborted) return { discarded: true };

      const diag = buildDiagnostics({
        now: now(),
        locationMode: (settings && settings.locationMode) || (state && state.locationMode) || "raw",
        exit: {
          ip: detectedIp,
          detectedIp,
          committedGeoIp: committedIp,
          switching,
          country: switching ? "" : state && state.country,
          countryCode: switching ? "" : state && state.countryCode,
          city: switching ? "" : state && state.city,
          latitude: switching
            ? Number.NaN
            : state && (Number.isFinite(state.rawLatitude) ? state.rawLatitude : state.latitude),
          longitude: switching
            ? Number.NaN
            : state && (Number.isFinite(state.rawLongitude) ? state.rawLongitude : state.longitude),
          timezone: switching ? "" : state && state.timezone,
          isp: switching ? "" : state && state.isp,
          echoStale: !!(state && state.echoStale),
          accuracy: state && state.accuracy,
        },
        virtual: {
          latitude: state && state.latitude,
          longitude: state && state.longitude,
          country: state && state.country,
          countryCode: state && state.countryCode,
          city: state && state.city,
          timezone: state && state.timezone,
          accuracy: state && state.accuracy,
          offsetKm: state && state.offsetKm,
        },
        page: pageEnv,
        worker: workerEnv,
        webrtc: viewWebRtc(state),
        dns: dnsInput,
        locale,
        environment,
      });

      if (!isCurrent(myGeneration) || signal.aborted) return { discarded: true };
      const persisted = await persistIfChanged(diag, myGeneration);
      if (persisted.discarded || !isCurrent(myGeneration)) return { discarded: true };
      return diag;
    });

    if (isolated.value && isolated.value.discarded) {
      stats.discarded += 1;
      return { ok: true, discarded: true, diagnostics: last };
    }
    if (!isolated.ok) {
      if (!isCurrent(myGeneration) || isAbortLike(isolated.error)) {
        stats.discarded += 1;
        return { ok: true, discarded: true, diagnostics: last };
      }
      stats.failures += 1;
      return { ok: false, error: isolated.error, diagnostics: last };
    }
    return { ok: true, diagnostics: isolated.value };
  }

  async function run({ state, settings, locale, environment, page, worker, force = false, reason } = {}) {
    const detectedIp = detectedExitIp(state);
    const normalized = normalizeDiagnosticsReason(reason, force);
    const incomingForce = normalized === "manual" || !!force;
    const incoming = {
      detectedIp,
      force: incomingForce,
      reason: normalized,
    };

    if (activeRun && !diagnosticsShouldSupersede(activeRun, incoming)) {
      stats.skipped += 1;
      return activeRun.promise;
    }

    const myGeneration = ++diagnosticsGeneration;
    if (activeRun && activeRun.controller && !activeRun.controller.signal.aborted) {
      try {
        activeRun.controller.abort();
        stats.aborts += 1;
      } catch {
        /* ignore */
      }
    }

    const ac = new AbortController();
    const myRun = {
      generation: myGeneration,
      detectedIp,
      force: incomingForce,
      reason: normalized,
      controller: ac,
      promise: null,
    };
    stats.runs += 1;

    const work = (async () => {
      try {
        return await execute(
          { state, settings, locale, environment, page, worker, force: incomingForce },
          myRun,
        );
      } finally {
        if (activeRun === myRun) activeRun = null;
      }
    })();
    myRun.promise = work;
    activeRun = myRun;
    return work;
  }

  return {
    hydrate,
    snapshot,
    run,
    dnsNeedsRefresh,
    stats,
    get generation() {
      return diagnosticsGeneration;
    },
    get activeRun() {
      return viewActive();
    },
  };
}
