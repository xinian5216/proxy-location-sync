import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createExitPipeline } from "../lib/exit-pipeline.js";
import { nextPollDelayMs, runResilientLoop, sendAck, COOLDOWN_SLEEP_CAP_MS } from "../lib/poll-sleep.js";

const A = "203.0.113.10";
const B = "198.51.100.20";
const C = "203.0.113.80";
const D = "198.51.100.90";

function geoFor(ip) {
  if (ip === A) {
    return {
      ip: A,
      latitude: 35.6762,
      longitude: 139.6503,
      timezone: "Asia/Tokyo",
      country: "Japan",
      countryCode: "JP",
      city: "Tokyo",
      region: "Tokyo",
      isp: "NTT",
      provider: "ipapi",
      accuracy: 1500,
    };
  }
  if (ip === B) {
    return {
      ip: B,
      latitude: 34.0522,
      longitude: -118.2437,
      timezone: "America/Los_Angeles",
      country: "United States",
      countryCode: "US",
      city: "Los Angeles",
      region: "CA",
      isp: "X",
      provider: "ipapi",
      accuracy: 1600,
    };
  }
  if (ip === C) {
    return {
      ip: C,
      latitude: 51.5074,
      longitude: -0.1278,
      timezone: "Europe/London",
      country: "United Kingdom",
      countryCode: "GB",
      city: "London",
      region: "England",
      isp: "BT",
      provider: "ipapi",
      accuracy: 1700,
    };
  }
  return {
    ip: D,
    latitude: -33.8688,
    longitude: 151.2093,
    timezone: "Australia/Sydney",
    country: "Australia",
    countryCode: "AU",
    city: "Sydney",
    region: "NSW",
    isp: "Telstra",
    provider: "ipapi",
    accuracy: 1800,
  };
}

function recordFor(ip, fetchedAt = Date.now()) {
  const g = geoFor(ip);
  return {
    ...g,
    rawLatitude: g.latitude,
    rawLongitude: g.longitude,
    offsetKm: 0,
    locationMode: "raw",
    fetchedAt,
  };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makePipeline(lookupGeo, { persistDelayMs = 0, delayWhen } = {}) {
  const writes = [];
  const probes = [];
  const pipeline = createExitPipeline({
    lookupGeo,
    persist: async ({ state, geoCache }) => {
      if (persistDelayMs && (!delayWhen || delayWhen(state))) {
        await wait(persistDelayMs);
      }
      writes.push({
        state: state ? { ...state, webrtc: state.webrtc ? { ...state.webrtc } : state.webrtc } : null,
        geoCache: geoCache ? { ...geoCache } : geoCache,
      });
    },
    probeWebrtc: async (ip) => {
      probes.push(ip);
    },
  });
  return { pipeline, writes, probes };
}

function hydrateReady(pipeline, ip = A, extraCache = {}) {
  pipeline.hydrate({
    settings: { enabled: true, intervalSec: 3, locationMode: "raw", webrtcProbe: true },
    state: {
      ...recordFor(ip),
      geoStatus: "ready",
      pendingIp: "",
      echoStale: false,
      lastSuccessfulEchoAt: Date.now(),
      webrtc: { status: "ok", checkedForIp: ip, reason: "srflx matches HTTP exit IP" },
    },
    geoCache: { [ip]: recordFor(ip), ...extraCache },
  });
}

describe("IP echo vs geo lookup decoupling", () => {
  test("Geo A stall 15s: IP B is accepted on the next tick without waiting for A", async () => {
    const lookups = [];
    let rejectA;
    const lookupGeo = (ip, { signal } = {}) => {
      lookups.push(ip);
      if (ip === A) {
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          };
          if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort, { once: true });
          }
          rejectA = reject;
        });
      }
      return Promise.resolve(geoFor(B));
    };
    const { pipeline } = makePipeline(lookupGeo);
    const t0 = Date.now();
    const ackA = await pipeline.onEcho({ ip: A, provider: "ipify64", reason: "echo" });
    assert.equal(ackA.ack, true);
    assert.equal(ackA.heartbeat, undefined);
    await wait(5);
    const ackB = await pipeline.onEcho({ ip: B, provider: "ipify64", reason: "echo" });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, "B must be accepted within one poll interval, not after Geo A");
    assert.equal(ackB.ack, true);
    assert.equal(ackB.pending, true);
    if (ackB.geoPromise) await ackB.geoPromise;
    const snap = pipeline.snapshot();
    assert.equal(snap.state.ip, B);
    assert.equal(snap.state.geoStatus, "ready");
    assert.equal(pipeline.stats.geoAborts >= 1, true);
    if (rejectA) {
      try {
        const e = new Error("late");
        e.name = "AbortError";
        rejectA(e);
      } catch {
        /* ignore */
      }
    }
    await wait(10);
    assert.equal(pipeline.snapshot().state.ip, B);
  });

  test("same committed IP 100 ticks → 0 storage / 0 geo / 0 cache touch", async () => {
    const lookups = [];
    const { pipeline } = makePipeline(async (ip) => {
      lookups.push(ip);
      return geoFor(ip);
    });
    pipeline.hydrate({
      settings: { enabled: true, intervalSec: 3, locationMode: "raw", webrtcProbe: true },
      state: {
        ...recordFor(A),
        geoStatus: "ready",
        pendingIp: "",
        echoStale: false,
        lastSuccessfulEchoAt: Date.now(),
      },
      geoCache: { [A]: recordFor(A) },
    });
    pipeline.stats.storageSets = 0;
    pipeline.stats.broadcasts = 0;
    pipeline.stats.cacheTouches = 0;
    pipeline.stats.geoLookups = 0;
    for (let i = 0; i < 100; i += 1) {
      const r = await pipeline.onEcho({ ip: A, reason: "echo", provider: "ipify64" });
      assert.equal(r.heartbeat, true);
    }
    assert.equal(lookups.length, 0);
    assert.equal(pipeline.stats.geoLookups, 0);
    assert.equal(pipeline.stats.storageSets, 0);
    assert.equal(pipeline.stats.broadcasts, 0);
    assert.equal(pipeline.stats.cacheTouches, 0);
    assert.equal(pipeline.stats.heartbeats, 100);
  });

  test("same-IP heartbeat does not abort manual RESYNC", async () => {
    let resolveA;
    const lookupGeo = (ip) => {
      if (ip === A) {
        return new Promise((resolve) => {
          resolveA = () => resolve(geoFor(A));
        });
      }
      return Promise.resolve(geoFor(ip));
    };
    const { pipeline } = makePipeline(lookupGeo);
    pipeline.hydrate({
      state: { ...recordFor(A), geoStatus: "ready", pendingIp: "" },
      geoCache: { [A]: recordFor(A) },
    });
    const resync = await pipeline.onEcho({ ip: A, reason: "resync", forceGeo: true });
    assert.equal(!!resync.geoPromise, true);
    for (let i = 0; i < 3; i += 1) {
      const beat = await pipeline.onEcho({ ip: A, reason: "echo" });
      assert.equal(beat.heartbeat, true);
    }
    assert.equal(pipeline.stats.geoAborts, 0);
    resolveA();
    const done = await resync.geoPromise;
    assert.equal(done.ok, true);
    assert.equal(pipeline.snapshot().state.geoStatus, "ready");
    assert.equal(pipeline.snapshot().state.ip, A);
  });

  test("different IP immediately aborts in-flight Geo A", async () => {
    const lookupGeo = (ip, { signal } = {}) => {
      if (ip === A) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      }
      return Promise.resolve(geoFor(B));
    };
    const { pipeline } = makePipeline(lookupGeo);
    const a = await pipeline.onEcho({ ip: A, reason: "resync", forceGeo: true });
    const b = await pipeline.onEcho({ ip: B, reason: "echo" });
    const aResult = await a.geoPromise;
    assert.equal(aResult.discarded, true);
    await b.geoPromise;
    assert.equal(pipeline.snapshot().state.ip, B);
    assert.ok(pipeline.stats.geoAborts >= 1);
  });

  test("Echo healthy + Geo error is not exit stale", async () => {
    const lookupGeo = async () => {
      throw new Error("geo providers failed");
    };
    const { pipeline } = makePipeline(lookupGeo);
    pipeline.hydrate({
      state: { ...recordFor(A), geoStatus: "ready", pendingIp: "", echoStale: false },
      geoCache: {},
    });
    const r = await pipeline.onEcho({ ip: A, reason: "resync", forceGeo: true });
    await r.geoPromise;
    const snap = pipeline.snapshot();
    assert.equal(snap.state.geoStatus, "error");
    assert.equal(snap.state.echoStale, false);
    pipeline.stats.storageSets = 0;
    for (let i = 0; i < 5; i += 1) {
      await pipeline.onEcho({ ip: A, reason: "echo" });
    }
    assert.equal(pipeline.snapshot().state.echoStale, false);
    assert.equal(pipeline.echoStaleNow(), false);
  });
});

describe("onEcho persist race / exit generation", () => {
  test("delayed B pending persist + newer C cache-hit → C wins; B does not abort or commit", async () => {
    const lookups = [];
    const { pipeline, probes } = makePipeline(
      async (ip) => {
        lookups.push(ip);
        return geoFor(ip);
      },
      {
        persistDelayMs: 50,
        delayWhen: (state) => state && state.pendingIp === B && state.geoStatus === "pending",
      },
    );
    hydrateReady(pipeline, A, { [B]: recordFor(B), [C]: recordFor(C) });
    const webrtcBeforeC = { status: "ok", checkedForIp: A };

    const bP = pipeline.onEcho({ ip: B, reason: "echo", provider: "ipify64" });
    await wait(5);
    const cAck = await pipeline.onEcho({ ip: C, reason: "echo", provider: "ipify64" });
    if (cAck.geoPromise) await cAck.geoPromise;
    const bAck = await bP;
    if (bAck.geoPromise) await bAck.geoPromise;
    await wait(20);

    const snap = pipeline.snapshot();
    assert.equal(snap.state.ip, C);
    assert.equal(snap.state.geoStatus, "ready");
    assert.equal(snap.state.pendingIp, "");
    assert.equal(snap.state.city, "London");
    assert.equal(snap.state.webrtc && snap.state.webrtc.checkedForIp, C);
    assert.notEqual(snap.state.webrtc && snap.state.webrtc.checkedForIp, B);
    assert.ok(bAck.discarded === true || !bAck.geoStarted);
    assert.ok(pipeline.stats.discarded >= 1);
    assert.equal(lookups.length, 0);
    assert.ok(!probes.includes(B));
    assert.notDeepEqual(snap.state.webrtc, webrtcBeforeC);
    assert.equal(pipeline.activeGeoTask(), null);
  });

  test("delayed B pending persist + newer C fresh lookup → C wins", async () => {
    const lookups = [];
    const { pipeline } = makePipeline(
      async (ip) => {
        lookups.push(ip);
        return geoFor(ip);
      },
      {
        persistDelayMs: 50,
        delayWhen: (state) => state && state.pendingIp === B && state.geoStatus === "pending",
      },
    );
    hydrateReady(pipeline, A, {});
    const bP = pipeline.onEcho({ ip: B, reason: "echo", provider: "ipify64" });
    await wait(5);
    const cAck = await pipeline.onEcho({ ip: C, reason: "echo", provider: "ipify64" });
    if (cAck.geoPromise) await cAck.geoPromise;
    const bAck = await bP;
    if (bAck.geoPromise) await bAck.geoPromise;
    await wait(20);

    const snap = pipeline.snapshot();
    assert.equal(snap.state.ip, C);
    assert.equal(snap.state.geoStatus, "ready");
    assert.equal(snap.state.pendingIp, "");
    assert.ok(!lookups.includes(B));
    assert.ok(lookups.includes(C));
    assert.ok(pipeline.stats.discarded >= 1);
    assert.equal(snap.state.webrtc && snap.state.webrtc.checkedForIp, C);
  });

  test("B→C→D persist interleave: only D commits", async () => {
    const lookups = [];
    const { pipeline } = makePipeline(
      async (ip) => {
        lookups.push(ip);
        return geoFor(ip);
      },
      {
        persistDelayMs: 50,
        delayWhen: (state) =>
          state &&
          state.geoStatus === "pending" &&
          (state.pendingIp === B || state.pendingIp === C),
      },
    );
    hydrateReady(pipeline, A, {
      [B]: recordFor(B),
      [C]: recordFor(C),
      [D]: recordFor(D),
    });
    const bP = pipeline.onEcho({ ip: B, reason: "echo" });
    await wait(2);
    const cP = pipeline.onEcho({ ip: C, reason: "echo" });
    await wait(2);
    const dAck = await pipeline.onEcho({ ip: D, reason: "echo" });
    if (dAck.geoPromise) await dAck.geoPromise;
    const [bAck, cAck] = await Promise.all([bP, cP]);
    if (bAck.geoPromise) await bAck.geoPromise;
    if (cAck.geoPromise) await cAck.geoPromise;
    await wait(20);

    const snap = pipeline.snapshot();
    assert.equal(snap.state.ip, D);
    assert.equal(snap.state.geoStatus, "ready");
    assert.equal(snap.state.city, "Sydney");
    assert.ok(!lookups.includes(B));
    assert.ok(!lookups.includes(C));
    assert.ok(pipeline.stats.discarded >= 2);
    assert.equal(pipeline.activeGeoTask(), null);
  });

  test("B→C→D lookups complete out of order: only D commits", async () => {
    const gates = {};
    const lookupGeo = (ip, { signal } = {}) =>
      new Promise((resolve, reject) => {
        const onAbort = () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        };
        if (signal) {
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
        }
        gates[ip] = () => resolve(geoFor(ip));
      });
    const { pipeline } = makePipeline(lookupGeo);
    hydrateReady(pipeline, A, {});
    const bAck = await pipeline.onEcho({ ip: B, reason: "echo" });
    const cAck = await pipeline.onEcho({ ip: C, reason: "echo" });
    const dAck = await pipeline.onEcho({ ip: D, reason: "echo" });
    assert.ok(gates[D], "D geo must start");
    if (gates[B]) gates[B]();
    if (gates[D]) gates[D]();
    if (gates[C]) gates[C]();
    const results = await Promise.all(
      [bAck.geoPromise, cAck.geoPromise, dAck.geoPromise].filter(Boolean),
    );
    assert.ok(results.some((r) => r && r.ok && r.ip === D));
    const snap = pipeline.snapshot();
    assert.equal(snap.state.ip, D);
    assert.equal(snap.state.geoStatus, "ready");
    assert.notEqual(snap.state.ip, B);
    assert.notEqual(snap.state.ip, C);
  });
});

describe("offscreen loop / poll sleep", () => {
  test("sendAck catch keeps going when sendMessage rejects", async () => {
    const r = await sendAck(async () => {
      throw new Error("no sw");
    }, { type: "IP_ECHO" });
    assert.equal(r.ok, false);
  });

  test("runResilientLoop continues after tick throw", async () => {
    let n = 0;
    const turns = await runResilientLoop({
      isStopped: () => n >= 3,
      tick: async () => {
        n += 1;
        if (n === 1) throw new Error("sendMessage failed");
      },
      sleep: async () => {},
      delayMs: 0,
    });
    assert.equal(turns, 3);
    assert.equal(n, 3);
  });

  test("cooldown sleep is capped and not shorter than interval", () => {
    const now = 1_000_000;
    assert.equal(nextPollDelayMs(3, 0, now), 3000);
    assert.equal(nextPollDelayMs(3, now + 15_000, now), 15_000);
    assert.equal(nextPollDelayMs(3, now + 60_000, now), COOLDOWN_SLEEP_CAP_MS);
  });
});
