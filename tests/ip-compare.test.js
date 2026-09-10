import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalizeIp, ipsEqual, isPublicIp, isPublicResolverIp, isValidIpLiteral } from "../lib/ip-compare.js";
import { applyLocationMode } from "../lib/geo.js";
import { DEFAULT_SETTINGS } from "../lib/constants.js";
import { createProviderHealth } from "../lib/provider-health.js";
import { fetchWithTimeout } from "../lib/net.js";
import { detectPublicIp, ipHealth, IP_PROVIDERS } from "../lib/ip-providers.js";

describe("IP compare", () => {
  test("IPv4 equality", () => {
    assert.equal(ipsEqual("1.2.3.4", "1.2.3.4"), true);
    assert.equal(ipsEqual("1.2.3.4", "1.2.3.5"), false);
  });

  test("IPv6 compact vs expanded", () => {
    assert.equal(canonicalizeIp("2001:db8::1"), "2001:0db8:0000:0000:0000:0000:0000:0001");
    assert.equal(ipsEqual("2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001"), true);
    assert.equal(ipsEqual("[2001:db8::1]", "2001:db8::1"), true);
  });

  test("IPv4-mapped IPv6", () => {
    assert.equal(canonicalizeIp("::ffff:8.8.8.8"), "8.8.8.8");
    assert.equal(ipsEqual("::ffff:8.8.8.8", "8.8.8.8"), true);
  });

  test("private / loopback / link-local are not public", () => {
    assert.equal(isPublicIp("10.0.0.1"), false);
    assert.equal(isPublicIp("192.168.0.1"), false);
    assert.equal(isPublicIp("127.0.0.1"), false);
    assert.equal(isPublicIp("172.16.5.1"), false);
    assert.equal(isPublicIp("169.254.1.1"), false);
    assert.equal(isPublicIp("8.8.8.8"), true);
    assert.equal(isPublicIp("2001:db8::1"), true);
    assert.equal(isPublicIp("fe80::1"), false);
    assert.equal(isPublicIp("::1"), false);
  });

  test("isValidIpLiteral rejects HTML / words / out-of-range IPv4", () => {
    assert.equal(isValidIpLiteral("Bad"), false);
    assert.equal(isValidIpLiteral("Bad Gateway"), false);
    assert.equal(isValidIpLiteral("abcdef"), false);
    assert.equal(isValidIpLiteral("999.999.999.999"), false);
    assert.equal(isValidIpLiteral("1.2.3"), false);
    assert.equal(isValidIpLiteral(""), false);
    assert.equal(isValidIpLiteral("8.8.8.8"), true);
    assert.equal(isValidIpLiteral("2001:4860:4860::8888"), true);
    assert.equal(isPublicResolverIp("8.8.8.8"), true);
    assert.equal(isPublicResolverIp("Bad"), false);
  });
});

describe("locationMode default raw + jitter stability", () => {
  test("default is raw", () => {
    assert.equal(DEFAULT_SETTINGS.locationMode, "raw");
  });

  test("raw returns provider coords", () => {
    const r = applyLocationMode(35.6762, 139.6503, "1.2.3.4", "raw");
    assert.equal(r.latitude, 35.6762);
    assert.equal(r.longitude, 139.6503);
    assert.equal(r.offsetKm, 0);
    assert.ok(r.accuracy >= 800 && r.accuracy <= 4200);
  });

  test("jitter is stable for the same IP", () => {
    const a = applyLocationMode(35.6762, 139.6503, "1.2.3.4", "jitter");
    const b = applyLocationMode(35.6762, 139.6503, "1.2.3.4", "jitter");
    assert.equal(a.latitude, b.latitude);
    assert.equal(a.longitude, b.longitude);
    assert.ok(a.offsetKm >= 1 && a.offsetKm <= 5);
    const c = applyLocationMode(35.6762, 139.6503, "9.9.9.9", "jitter");
    assert.notEqual(a.latitude, c.latitude);
  });
});

describe("provider health", () => {
  test("429 cools the provider; ready sources go first", () => {
    const h = createProviderHealth();
    const now = 1_000_000;
    h.recordFail("a", { status: 429, now });
    h.recordOk("b", now);
    const ordered = h.order([{ id: "a" }, { id: "b" }, { id: "c" }], now + 1000);
    assert.equal(ordered[0].id, "b");
    assert.ok(h.isCooling("a", now + 1000));
    assert.equal(h.isCooling("a", now + 31_000), false);
  });

  test("if all cooling, automatic order is empty; bypass still tries one", () => {
    const h = createProviderHealth();
    const now = 1_000_000;
    h.recordFail("a", { now });
    h.recordFail("b", { now });
    const ordered = h.order([{ id: "a" }, { id: "b" }], now);
    assert.equal(ordered.length, 0);
    const bypass = h.order([{ id: "a" }, { id: "b" }], now, { allowCooling: true });
    assert.equal(bypass.length, 1);
  });
});

function hangingFetch(_url, init = {}) {
  return new Promise((_, reject) => {
    const fail = () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    }
  });
}

describe("fetch timeout vs abort", () => {
  test("timeout throws TimeoutError so failover can continue", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = hangingFetch;
    try {
      await assert.rejects(
        () => fetchWithTimeout("https://example.invalid/ip", { timeoutMs: 40 }),
        (err) => {
          assert.equal(err.name, "TimeoutError");
          return true;
        },
      );
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("parent abort throws AbortError", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = hangingFetch;
    const ac = new AbortController();
    const p = fetchWithTimeout("https://example.invalid/ip", { timeoutMs: 5000, signal: ac.signal });
    ac.abort();
    try {
      await assert.rejects(p, (err) => {
        assert.equal(err.name, "AbortError");
        return true;
      });
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("detectPublicIp skips a timed-out source and uses the next", async () => {
    ipHealth.reset();
    const orig = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async (url, init) => {
      n += 1;
      if (n === 1) return hangingFetch(url, init);
      return new Response("203.0.113.88", { status: 200 });
    };
    try {
      const echo = await detectPublicIp();
      assert.equal(echo.ip, "203.0.113.88");
      assert.ok(n >= 2);
    } finally {
      globalThis.fetch = orig;
      ipHealth.reset();
    }
  });
});

describe("IPv6-only echo + cooldown wait", () => {
  test("api64 is first so IPv6-only does not wait on v4-only endpoints", async () => {
    assert.equal(IP_PROVIDERS[0].id, "ipify64");
    assert.match(IP_PROVIDERS[0].url, /api64\.ipify\.org/);
    ipHealth.reset();
    const orig = globalThis.fetch;
    const hits = [];
    globalThis.fetch = async (url, init) => {
      hits.push(String(url));
      if (String(url).includes("api64.ipify.org")) {
        return new Response(JSON.stringify({ ip: "2001:db8::53" }), { status: 200 });
      }
      return hangingFetch(url, init);
    };
    try {
      const echo = await detectPublicIp();
      assert.equal(echo.provider, "ipify64");
      assert.equal(echo.ip, "2001:db8::53");
      assert.equal(hits.length, 1);
    } finally {
      globalThis.fetch = orig;
      ipHealth.reset();
    }
  });

  test("all providers cooling: auto detect does not fetch; manual bypass does", async () => {
    ipHealth.reset();
    const now = Date.now();
    for (const p of IP_PROVIDERS) ipHealth.recordFail(p.id, { status: 429, now });
    const orig = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async (url) => {
      fetches += 1;
      const u = String(url);
      if (u.includes("format=json")) {
        return new Response(JSON.stringify({ ip: "203.0.113.9" }), { status: 200 });
      }
      if (u.includes("cloudflare.com")) {
        return new Response("ip=203.0.113.9\n", { status: 200 });
      }
      return new Response("203.0.113.9", { status: 200 });
    };
    try {
      await assert.rejects(() => detectPublicIp(), (err) => err.name === "CooldownError");
      assert.equal(fetches, 0);
      const echo = await detectPublicIp({ bypassCooldown: true });
      assert.equal(echo.ip, "203.0.113.9");
      assert.ok(fetches >= 1);
    } finally {
      globalThis.fetch = orig;
      ipHealth.reset();
    }
  });
});
