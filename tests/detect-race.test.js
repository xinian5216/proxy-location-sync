import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { canCommitGeo, geoCacheGet, geoCacheKey, isCacheFresh, shouldDiscard, shouldSkipGeoRetry, GEO_CACHE_TTL_MS } from "../lib/detect-engine.js";
import { createDetectSession } from "../lib/detect-session.js";
import { lookupGeo, geoHealth } from "../lib/geo-providers.js";
import { ipsEqual } from "../lib/ip-compare.js";

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(t);
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      },
      { once: true },
    );
  });
}

describe("latest state wins", () => {
  test("stale generation is discarded", () => {
    assert.equal(shouldDiscard(1, 2), true);
    assert.equal(shouldDiscard(2, 2), false);
  });

  test("geo commit requires looked IP == target IP", () => {
    assert.equal(canCommitGeo("1.1.1.1", "1.1.1.1"), true);
    assert.equal(canCommitGeo("1.1.1.1", "8.8.8.8"), false);
    assert.equal(canCommitGeo("2001:db8::1", "2001:db8:0:0:0:0:0:1"), true);
  });

  test("delayed A geo cannot overwrite later B", async () => {
    const session = createDetectSession();
    let committed = null;

    async function run(ip, waitMs) {
      const { generation, signal } = session.begin();
      try {
        await delay(waitMs, signal);
      } catch (err) {
        if (err.name === "AbortError") return { discarded: true, ip };
        throw err;
      }
      if (!session.isCurrent(generation)) return { discarded: true, ip };
      if (!canCommitGeo(ip, ip)) return { discarded: true, ip };
      committed = ip;
      return { discarded: false, ip };
    }

    const a = run("A", 40);
    const b = run("B", 5);
    const results = await Promise.all([a, b]);
    assert.equal(committed, "B");
    assert.equal(results.find((r) => r.ip === "A").discarded, true);
  });

  test("A→B→C keeps C", async () => {
    const session = createDetectSession();
    let committed = null;
    async function run(ip, waitMs) {
      const { generation, signal } = session.begin();
      try {
        await delay(waitMs, signal);
      } catch {
        return;
      }
      if (!session.isCurrent(generation)) return;
      committed = ip;
    }
    const tasks = [run("A", 50), run("B", 30), run("C", 5)];
    await Promise.all(tasks);
    assert.equal(committed, "C");
  });

  test("cache hit of B aborts in-flight A lookup", async () => {
    const session = createDetectSession();
    let committed = null;
    const a = (async () => {
      const { generation, signal } = session.begin();
      try {
        await delay(40, signal);
      } catch {
        return "aborted";
      }
      if (!session.isCurrent(generation)) return "stale";
      committed = "A";
      return "wrote-A";
    })();
    await delay(5);
    const b = session.begin();
    committed = "B";
    assert.equal(session.isCurrent(b.generation), true);
    const aResult = await a;
    assert.ok(aResult === "aborted" || aResult === "stale");
    assert.equal(committed, "B");
  });
});

describe("geo cache TTL", () => {
  test("fresh within 7 days", () => {
    const now = 1_700_000_000_000;
    assert.equal(isCacheFresh({ fetchedAt: now - 1000 }, now), true);
    assert.equal(isCacheFresh({ fetchedAt: now - (GEO_CACHE_TTL_MS - 1) }, now), true);
  });
  test("stale after TTL", () => {
    const now = 1_700_000_000_000;
    assert.equal(isCacheFresh({ fetchedAt: now - GEO_CACHE_TTL_MS - 1 }, now), false);
    assert.equal(isCacheFresh({}, now), false);
  });
});

describe("lookupGeo binds targetIp", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    geoHealth.reset();
  });

  test("skips provider whose returned IP != targetIp", async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          success: true,
          ip: "9.9.9.9",
          country: "X",
          country_code: "XX",
          region: "R",
          city: "C",
          latitude: 1,
          longitude: 2,
          timezone: { id: "Asia/Tokyo" },
          connection: { isp: "x" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    await assert.rejects(() => lookupGeo("1.2.3.4"), /mismatch|failed|incomplete/i);
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((u) => u.includes("1.2.3.4")));
  });

  test("accepts matching explicit IP lookup", async () => {
    globalThis.fetch = async (url) => {
      const ip = "203.0.113.10";
      assert.ok(String(url).includes(ip));
      return new Response(
        JSON.stringify({
          success: true,
          ip,
          country: "Japan",
          country_code: "JP",
          region: "Tokyo",
          city: "Tokyo",
          latitude: 35.67,
          longitude: 139.65,
          timezone: { id: "Asia/Tokyo" },
          connection: { isp: "NTT" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const geo = await lookupGeo("203.0.113.10");
    assert.equal(ipsEqual(geo.ip, "203.0.113.10"), true);
    assert.equal(geo.timezone, "Asia/Tokyo");
    assert.equal(geo.city, "Tokyo");
  });

  test("HTTP 429 cools that provider and tries others", async () => {
    const hits = [];
    globalThis.fetch = async (url) => {
      hits.push(String(url));
      const err = new Error("HTTP 429");
      err.status = 429;
      throw err;
    };
    await assert.rejects(() => lookupGeo("198.51.100.4"));
    const firstRound = hits.length;
    assert.ok(firstRound >= 2, "should fail over after 429");
    const before = hits.length;
    await assert.rejects(() => lookupGeo("198.51.100.4"));
    assert.equal(hits.length - before, 0, "all-cooling auto lookup must not fetch");
  });
});

describe("IPv6 cache key + geo retry backoff", () => {
  test("compressed and expanded IPv6 share one cache key", () => {
    const compact = "2001:db8::1";
    const expanded = "2001:0db8:0000:0000:0000:0000:0000:0001";
    assert.equal(geoCacheKey(compact), geoCacheKey(expanded));
    const cache = { [geoCacheKey(compact)]: { city: "X", fetchedAt: Date.now() } };
    assert.equal(geoCacheGet(cache, expanded).city, "X");
    assert.equal(geoCacheGet(cache, compact).city, "X");
  });

  test("same pending IP skips geo retry until nextGeoRetryAt", () => {
    const now = 1_700_000_000_000;
    const state = { pendingIp: "1.2.3.4", nextGeoRetryAt: now + 10_000 };
    assert.equal(shouldSkipGeoRetry(state, "1.2.3.4", now), true);
    assert.equal(shouldSkipGeoRetry(state, "9.9.9.9", now), false);
    assert.equal(shouldSkipGeoRetry(state, "1.2.3.4", now + 11_000), false);
  });
});
