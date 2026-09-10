import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DNS_CACHE_MS, DNS_FAIL_CACHE_MS } from "../lib/constants.js";
import {
  buildDiagnostics,
  detectedExitIp,
  diagnosticsFingerprint,
  evaluateDns,
  evaluateFonts,
  evaluateGeolocation,
  evaluateLocale,
  evaluateTimezone,
  evaluateWebRtc,
  evaluateWorker,
  isChinaMainlandIsp,
  isPublicAnycastDns,
  isSwitchingExit,
  runIsolated,
  stableDnsResolvers,
} from "../lib/diagnostics.js";
import { createDiagnosticsController, dnsCacheValid, dnsTtlMs } from "../lib/diagnostics-runner.js";
import { createDnsProbe, DNS_PROVIDER_IDS, parseIpleakDetectionBody } from "../lib/dns-providers.js";
import { createExitPipeline } from "../lib/exit-pipeline.js";
import { haversineKm } from "../lib/geo.js";
import { isValidIpLiteral } from "../lib/ip-compare.js";
import { getOffsetMinutes } from "../lib/timezone.js";

const JP = {
  ip: "203.0.113.10",
  country: "Japan",
  countryCode: "JP",
  city: "Tokyo",
  latitude: 35.6762,
  longitude: 139.6503,
  rawLatitude: 35.6762,
  rawLongitude: 139.6503,
  timezone: "Asia/Tokyo",
  isp: "NTT",
  accuracy: 1500,
  geoStatus: "ready",
};

const US = {
  ip: "198.51.100.20",
  country: "United States",
  countryCode: "US",
  city: "New York",
  latitude: 40.7128,
  longitude: -74.006,
  rawLatitude: 40.7128,
  rawLongitude: -74.006,
  timezone: "America/New_York",
  isp: "Example",
  accuracy: 1600,
  geoStatus: "ready",
};

const TOKYO_OFFSET = getOffsetMinutes("Asia/Tokyo", new Date(Date.UTC(2026, 0, 15)));
const NY_OFFSET = getOffsetMinutes("America/New_York", new Date(Date.UTC(2026, 6, 1)));
const TORONTO_OFFSET = getOffsetMinutes("America/Toronto", new Date(Date.UTC(2026, 6, 1)));
const SHANGHAI_OFFSET = getOffsetMinutes("Asia/Shanghai", new Date(Date.UTC(2026, 0, 15)));

function japanPage(extra = {}) {
  return {
    timezone: "Asia/Tokyo",
    offsetMin: TOKYO_OFFSET,
    language: "zh-CN",
    languages: ["zh-CN", "zh"],
    locale: "zh-CN",
    geoMode: "ready",
    htmlGeo: false,
    patchAlive: true,
    latitude: JP.latitude,
    longitude: JP.longitude,
    ...extra,
  };
}

describe("haversine + geo consistency", () => {
  test("Tokyo vs New York is thousands of km", () => {
    const km = haversineKm(JP.latitude, JP.longitude, US.latitude, US.longitude);
    assert.ok(km > 9000);
  });

  test("city-level 15km is not error", () => {
    const r = evaluateGeolocation({
      ip: { ...JP, accuracy: 8000 },
      virtual: { ...JP, latitude: JP.latitude + 0.12, accuracy: 8000 },
      locationMode: "raw",
    });
    assert.notEqual(r.status, "error");
    assert.ok(r.distanceKm > 10);
    assert.ok(r.distanceKm < 20);
  });
});

describe("environment consistency evaluators", () => {
  test("1. IP Japan + Geo Japan + Tokyo timezone → overall ok", () => {
    const d = buildDiagnostics({
      exit: JP,
      virtual: JP,
      page: japanPage(),
      webrtc: { status: "ok", publicIps: [JP.ip], checkedForIp: JP.ip },
      dns: {
        resolvers: [{ ip: "203.0.113.8", countryCode: "JP", country: "Japan", org: "NTT" }],
        provider: "bash.ws",
      },
      locale: { language: "zh-CN", languages: ["zh-CN"] },
      now: Date.UTC(2026, 0, 15),
    });
    assert.equal(d.network.status, "ok");
    assert.equal(d.geolocation.status, "ok");
    assert.equal(d.timezone.status, "ok");
    assert.equal(d.overall.label, "Good");
    assert.equal(d.overall.issues.length, 0);
  });

  test("2. IP Japan + Geo US → geo error", () => {
    const d = buildDiagnostics({
      exit: JP,
      virtual: US,
      page: japanPage({ timezone: US.timezone, offsetMin: NY_OFFSET, latitude: US.latitude, longitude: US.longitude }),
    });
    assert.equal(d.geolocation.status, "error");
    assert.equal(d.overall.label, "Needs attention");
    assert.ok(d.overall.issues.length >= 1);
  });

  test("3. IP Japan + Asia/Shanghai → timezone error", () => {
    const tz = evaluateTimezone({
      expected: "Asia/Tokyo",
      intlTimezone: "Asia/Shanghai",
      actualOffsetMin: SHANGHAI_OFFSET,
      now: Date.UTC(2026, 0, 15),
    });
    assert.equal(tz.status, "error");
    const d = buildDiagnostics({
      exit: JP,
      virtual: { ...JP, timezone: "Asia/Tokyo" },
      page: japanPage({ timezone: "Asia/Shanghai", offsetMin: SHANGHAI_OFFSET }),
    });
    assert.equal(d.timezone.status, "error");
    assert.equal(d.overall.label, "Needs attention");
  });

  test("4. timezone name 不同但 offset 合理 → warning", () => {
    assert.equal(NY_OFFSET, TORONTO_OFFSET);
    const tz = evaluateTimezone({
      expected: "America/New_York",
      intlTimezone: "America/Toronto",
      actualOffsetMin: NY_OFFSET,
      now: Date.UTC(2026, 6, 1),
    });
    assert.equal(tz.status, "warning");
  });

  test("5. DNS China Unicom + Japan exit → warning", () => {
    assert.equal(isChinaMainlandIsp({ org: "China Unicom" }), true);
    const dns = evaluateDns(
      {
        resolvers: [
          { ip: "112.86.1.1", countryCode: "CN", country: "China", org: "China Unicom", asn: "AS4837" },
        ],
      },
      JP,
    );
    assert.equal(dns.status, "warning");
    assert.match(dns.note, /DNS 环境可能与代理出口不一致/);
    const d = buildDiagnostics({ exit: JP, virtual: JP, dns: { resolvers: dns.resolvers } });
    assert.equal(d.overall.label, "Needs attention");
  });

  test("6. Cloudflare DNS + Japan exit → unknown / not error", () => {
    assert.equal(isPublicAnycastDns({ org: "Cloudflare", ip: "1.1.1.1" }), true);
    const dns = evaluateDns(
      { resolvers: [{ ip: "1.1.1.1", countryCode: "AU", country: "Australia", org: "Cloudflare" }] },
      JP,
    );
    assert.equal(dns.status, "unknown");
    assert.equal(dns.consistency, "public-dns");
    assert.match(dns.note, /全球公共 DNS/);
    const d = buildDiagnostics({
      exit: JP,
      virtual: JP,
      dns: { resolvers: [{ ip: "1.1.1.1", org: "Cloudflare" }] },
    });
    assert.notEqual(d.overall.status, "error");
    assert.equal(d.overall.label, "Good");
  });

  test("7. WebRTC different public IP → error", () => {
    const w = evaluateWebRtc(
      { status: "leak", publicIps: ["8.8.8.8"], reason: "STUN public IP differs from HTTP exit IP", checkedForIp: JP.ip },
      JP.ip,
    );
    assert.equal(w.status, "error");
    const d = buildDiagnostics({
      exit: JP,
      virtual: JP,
      webrtc: { status: "leak", publicIps: ["8.8.8.8"], reason: "STUN public IP differs" },
    });
    assert.equal(d.webrtc.status, "error");
    assert.equal(d.overall.label, "Needs attention");
  });

  test("8. zh-CN + Japan IP 不得 error", () => {
    const loc = evaluateLocale({ language: "zh-CN", languages: ["zh-CN", "zh"], intlLocale: "zh-CN" });
    assert.equal(loc.status, "ok");
    assert.match(loc.label, /中文/);
    const d = buildDiagnostics({
      exit: JP,
      virtual: JP,
      locale: { language: "zh-CN", languages: ["zh-CN", "zh"], intlLocale: "zh-CN" },
      dns: { resolvers: [{ ip: "203.0.113.8", countryCode: "JP", org: "NTT" }] },
    });
    assert.equal(d.locale.status, "ok");
    assert.equal(d.overall.issues.length, 0);
    assert.ok(d.overall.infos.some((x) => /语言/.test(x)));
    assert.doesNotMatch(JSON.stringify(d.overall.issues), /风险|异常|泄漏/);
  });

  test("9. Chinese fonts + US IP 不得 error", () => {
    const fonts = evaluateFonts(["Microsoft YaHei", "SimSun"]);
    assert.equal(fonts.status, "ok");
    assert.ok(fonts.cjk.length >= 1);
    const d = buildDiagnostics({
      exit: US,
      virtual: US,
      environment: { fonts: ["Microsoft YaHei", "SimSun"] },
      locale: { language: "zh-CN" },
      dns: { resolvers: [{ ip: "8.8.8.8", org: "Google" }] },
    });
    assert.equal(d.fonts.status, "ok");
    assert.ok(!d.overall.issues.some((x) => /字体|font/i.test(x)));
    assert.ok(d.overall.infos.some((x) => /中文字体/.test(x)));
  });

  test("10. Worker timezone 与 MAIN 不一致 → warning", () => {
    const w = evaluateWorker({
      mainTimezone: "Asia/Tokyo",
      worker: { ok: true, timezone: "Asia/Shanghai", offsetMin: SHANGHAI_OFFSET },
    });
    assert.equal(w.status, "warning");
    assert.match(w.note, /已知限制/);
    const d = buildDiagnostics({
      exit: JP,
      virtual: JP,
      page: japanPage({
        worker: { ok: true, timezone: "Asia/Shanghai" },
      }),
    });
    assert.equal(d.worker.status, "warning");
    assert.equal(d.overall.label, "Needs attention");
  });
});

describe("DNS providers", () => {
  test("provider ids are bash.ws and ipleak.net", () => {
    assert.deepEqual(DNS_PROVIDER_IDS, ["bash.ws", "ipleak.net"]);
  });

  test("11. DNS provider timeout → unknown", async () => {
    const fetchFn = async () => {
      const err = new Error("timeout 4000ms");
      err.name = "TimeoutError";
      throw err;
    };
    const probe = createDnsProbe({ fetchFn, now: () => 1_000_000 });
    const r = await probe.lookup();
    assert.equal(r.resolvers.length, 0);
    assert.equal(r.timedOut, true);
    const dns = evaluateDns({ ...r, timedOut: true }, JP);
    assert.equal(dns.status, "unknown");
  });

  test("12. DNS provider 429 → fallback to next", async () => {
    const fetchFn = async (url) => {
      const u = String(url);
      if (u.includes("bash.ws")) {
        const err = new Error("HTTP 429");
        err.status = 429;
        throw err;
      }
      if (u.includes("ipleak.net/dnsdetection")) {
        return { text: async () => "203.0.113.99" };
      }
      if (u.includes("ipleak.net/json")) {
        return {
          text: async () =>
            JSON.stringify({ country_name: "Japan", country_code: "JP", isp_name: "IIJ" }),
        };
      }
      throw new Error(`unexpected ${u}`);
    };
    const probe = createDnsProbe({ fetchFn, now: () => 2_000_000 });
    const r = await probe.lookup();
    assert.equal(r.provider, "ipleak.net");
    assert.equal(r.resolvers[0].ip, "203.0.113.99");
    assert.equal(r.resolvers[0].countryCode, "JP");
  });

  test("bash.ws invalid JSON falls through to ipleak", async () => {
    const fetchFn = async (url) => {
      const u = String(url);
      if (u.includes("bash.ws/id")) return { text: async () => "7654321" };
      if (u.includes(".bash.ws")) return { text: async () => "ok" };
      if (u.includes("bash.ws/dnsleak")) return { text: async () => "not-json{" };
      if (u.includes("ipleak.net/dnsdetection")) return { text: async () => "8.8.8.8" };
      if (u.includes("ipleak.net/json")) {
        return { text: async () => JSON.stringify({ country_code: "US", isp_name: "Google" }) };
      }
      throw new Error(u);
    };
    const r = await createDnsProbe({ fetchFn, now: () => 3_000_000 }).lookup();
    assert.equal(r.provider, "ipleak.net");
    assert.equal(isPublicAnycastDns(r.resolvers[0]), true);
  });
});

describe("diagnostics controller cache + isolation", () => {
  test("13. IP change invalidates DNS cache", async () => {
    let lookups = 0;
    const ctrl = createDiagnosticsController({
      now: () => 10_000_000,
      lookupDns: async () => {
        lookups += 1;
        return { resolvers: [{ ip: "203.0.113.8", countryCode: "JP", org: "NTT" }], provider: "bash.ws" };
      },
      persist: async () => {},
    });
    await ctrl.run({ state: JP, settings: { locationMode: "raw" } });
    await ctrl.run({ state: JP, settings: { locationMode: "raw" } });
    assert.equal(lookups, 1);
    assert.equal(dnsCacheValid(ctrl.snapshot().dns, JP.ip, 10_000_000, DNS_CACHE_MS), true);
    await ctrl.run({ state: { ...JP, ip: US.ip, countryCode: "US" }, settings: { locationMode: "raw" } });
    assert.equal(lookups, 2);
    assert.equal(dnsCacheValid(ctrl.snapshot().dns, JP.ip, 10_000_000), false);
  });

  test("14. manual diagnostics force refresh", async () => {
    let lookups = 0;
    const ctrl = createDiagnosticsController({
      now: () => 11_000_000,
      lookupDns: async () => {
        lookups += 1;
        return { resolvers: [{ ip: "1.1.1.1", org: "Cloudflare" }], provider: "bash.ws" };
      },
      persist: async () => {},
    });
    await ctrl.run({ state: JP });
    await ctrl.run({ state: JP, force: true });
    assert.equal(lookups, 2);
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip, true), true);
  });

  test("15. no unnecessary storage writes", async () => {
    let writes = 0;
    const ctrl = createDiagnosticsController({
      now: () => 12_000_000,
      lookupDns: async () => ({
        resolvers: [{ ip: "203.0.113.8", countryCode: "JP", org: "NTT" }],
        provider: "bash.ws",
      }),
      persist: async () => {
        writes += 1;
      },
    });
    await ctrl.run({ state: JP, locale: { language: "zh-CN" } });
    await ctrl.run({ state: JP, locale: { language: "zh-CN" } });
    await ctrl.run({ state: JP, locale: { language: "zh-CN" }, force: true });
    assert.equal(writes, 1);
    assert.equal(ctrl.stats.writes, 1);
  });

  test("16. diagnostics failure does not affect core pipeline", async () => {
    const pipeWrites = [];
    const pipeline = createExitPipeline({
      lookupGeo: async () => ({
        ...JP,
        provider: "ipapi",
        region: "Tokyo",
      }),
      persist: async () => {
        pipeWrites.push("pipe");
      },
      probeWebrtc: async () => {},
    });
    const ctrl = createDiagnosticsController({
      lookupDns: async () => {
        throw new Error("dns boom");
      },
      persist: async () => {
        throw new Error("diag persist boom");
      },
      probePage: async () => {
        throw new Error("probe boom");
      },
    });
    const echo = await pipeline.onEcho({ ip: JP.ip, provider: "t", reason: "boot" });
    if (echo && echo.geoPromise) await echo.geoPromise;
    const diag = await ctrl.run({ state: pipeline.snapshot().state || JP });
    assert.ok(pipeWrites.length >= 1);
    assert.equal(pipeline.snapshot().state.ip, JP.ip);
    assert.equal(diag.ok, true);
    assert.equal(diag.diagnostics.dns.status, "unknown");
    const iso = await runIsolated(async () => {
      throw new Error("font detector exploded");
    });
    assert.equal(iso.ok, false);
    assert.equal(pipeline.snapshot().state.timezone, "Asia/Tokyo");
  });

  test("controller never throws when every collaborator throws", async () => {
    const ctrl = createDiagnosticsController({
      lookupDns: async () => {
        throw new Error("x");
      },
      persist: async () => {
        throw new Error("y");
      },
      probePage: async () => {
        throw new Error("z");
      },
    });
    const r = await ctrl.run({ state: JP });
    assert.equal(r.ok, true);
    assert.ok(r.diagnostics);
  });
});

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      },
      { once: true },
    );
  });
}

const IP_A = "203.0.113.10";
const IP_B = "198.51.100.20";
const IP_C = "192.0.2.88";

describe("1.2.1 diagnostics latest-run-wins + pending exit + DNS cache", () => {
  test("1. Diagnostics A slow → B fast → B wins", async () => {
    const persisted = [];
    let calls = 0;
    let abortedA = false;
    const ctrl = createDiagnosticsController({
      now: () => 20_000_000,
      lookupDns: async ({ signal }) => {
        calls += 1;
        const mine = calls;
        if (mine === 1 && signal) {
          signal.addEventListener("abort", () => {
            abortedA = true;
          });
        }
        await wait(mine === 1 ? 80 : 10, signal);
        return {
          resolvers: [{ ip: `9.9.9.${mine}`, countryCode: "JP", org: "NTT" }],
          provider: "bash.ws",
        };
      },
      persist: async (diag) => {
        persisted.push(diag);
      },
    });
    const pA = ctrl.run({ state: { ...JP, ip: IP_A } });
    await wait(5);
    const pB = ctrl.run({ state: { ...JP, ip: IP_B, country: "United States", countryCode: "US", city: "New York" } });
    const [ra, rb] = await Promise.all([pA, pB]);
    assert.equal(ra.discarded, true);
    assert.equal(rb.ok, true);
    assert.equal(ctrl.snapshot().network.ip, IP_B);
    assert.equal(ctrl.snapshot().network.detectedIp, IP_B);
    assert.equal(ctrl.snapshot().dns.checkedForIp, IP_B);
    assert.equal(persisted.at(-1).network.detectedIp, IP_B);
    assert.equal(persisted.at(-1).dns.checkedForIp, IP_B);
    assert.equal(abortedA, true);
    assert.notEqual(ctrl.snapshot().dns.technicalFailure, true);
  });

  test("2. A → B → C 乱序完成 → 只允许 C", async () => {
    const persisted = [];
    let calls = 0;
    const delays = [80, 40, 10];
    const ips = [IP_A, IP_B, IP_C];
    const ctrl = createDiagnosticsController({
      now: () => 21_000_000,
      lookupDns: async ({ signal }) => {
        const mine = calls;
        calls += 1;
        await wait(delays[mine], signal);
        return {
          resolvers: [{ ip: `1.0.0.${mine + 1}`, org: "NTT" }],
          provider: "bash.ws",
        };
      },
      persist: async (diag) => {
        persisted.push(diag);
      },
    });
    const pA = ctrl.run({ state: { ...JP, ip: ips[0] } });
    await wait(5);
    const pB = ctrl.run({ state: { ...JP, ip: ips[1] } });
    await wait(5);
    const pC = ctrl.run({ state: { ...JP, ip: ips[2] } });
    await Promise.all([pA, pB, pC]);
    assert.equal(ctrl.snapshot().network.detectedIp, IP_C);
    assert.equal(ctrl.snapshot().dns.checkedForIp, IP_C);
    assert.equal(persisted.at(-1).network.detectedIp, IP_C);
    assert.equal(persisted.at(-1).dns.checkedForIp, IP_C);
  });

  test("3. old diagnostics AbortController is aborted", async () => {
    let aborted = false;
    const ctrl = createDiagnosticsController({
      now: () => 22_000_000,
      lookupDns: async ({ signal }) => {
        assert.ok(signal);
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await wait(60, signal);
        return { resolvers: [{ ip: "1.1.1.1", org: "Cloudflare" }], provider: "bash.ws" };
      },
      persist: async () => {},
    });
    const pA = ctrl.run({ state: JP });
    await wait(5);
    const pB = ctrl.run({ state: { ...JP, ip: IP_B } });
    await Promise.all([pA, pB]);
    assert.equal(aborted, true);
    assert.ok(ctrl.stats.aborts >= 1);
  });

  test("4. pendingIp B invalidates DNS A cache", async () => {
    let lookups = 0;
    const ctrl = createDiagnosticsController({
      now: () => 30_000_000,
      lookupDns: async () => {
        lookups += 1;
        return { resolvers: [{ ip: "8.8.4.4", org: "Google" }], provider: "bash.ws" };
      },
      persist: async () => {},
    });
    ctrl.hydrate({
      dns: {
        resolvers: [{ ip: "203.0.113.8", countryCode: "JP", org: "NTT" }],
        provider: "bash.ws",
        checkedForIp: JP.ip,
        checkedAt: 30_000_000,
        status: "ok",
        technicalFailure: false,
      },
    });
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), false);
    assert.equal(ctrl.dnsNeedsRefresh(US.ip), true);
    const r = await ctrl.run({
      state: { ...JP, pendingIp: US.ip, geoStatus: "pending" },
    });
    assert.equal(lookups, 1);
    assert.equal(r.diagnostics.dns.checkedForIp, US.ip);
    assert.equal(detectedExitIp({ ...JP, pendingIp: US.ip }), US.ip);
    assert.equal(isSwitchingExit({ ...JP, pendingIp: US.ip }), true);
  });

  test("5. pendingIp B network shows B, not A", async () => {
    const r = await createDiagnosticsController({
      now: () => 31_000_000,
      lookupDns: async () => ({
        resolvers: [{ ip: "1.1.1.1", org: "Cloudflare" }],
        provider: "bash.ws",
      }),
      persist: async () => {},
    }).run({
      state: { ...JP, pendingIp: US.ip, geoStatus: "pending" },
    });
    const net = r.diagnostics.network;
    assert.equal(net.detectedIp, US.ip);
    assert.equal(net.ip, US.ip);
    assert.equal(net.switching, true);
    assert.notEqual(net.city, "Tokyo");
    assert.equal(net.country, "");
  });

  test("6. committed Geo still bound to A while B pending", async () => {
    const d = buildDiagnostics({
      exit: {
        ip: US.ip,
        detectedIp: US.ip,
        committedGeoIp: JP.ip,
        switching: true,
        country: "Japan",
        countryCode: "JP",
        city: "Tokyo",
        latitude: JP.latitude,
        longitude: JP.longitude,
        timezone: "Asia/Tokyo",
      },
      virtual: JP,
      dns: { resolvers: [{ ip: "1.1.1.1", org: "Cloudflare" }], checkedForIp: US.ip },
    });
    assert.equal(d.network.detectedIp, US.ip);
    assert.equal(d.network.committedGeoIp, JP.ip);
    assert.equal(d.geolocation.status, "pending");
    assert.equal(d.geolocation.city, "Tokyo");
    assert.match(d.geolocation.note, /203\.0\.113\.10/);
    assert.match(d.geolocation.note, /198\.51\.100\.20/);
    assert.match(d.timezone.note, /等待新地理/);
    assert.equal(d.dns.checkedForIp, US.ip);
  });

  test("7. resolver IP change triggers persist", async () => {
    let writes = 0;
    let n = 0;
    const ctrl = createDiagnosticsController({
      now: () => 32_000_000,
      lookupDns: async () => {
        n += 1;
        return {
          resolvers: [{ ip: n === 1 ? "203.0.113.10" : "203.0.113.11", countryCode: "JP", org: "NTT" }],
          provider: "bash.ws",
        };
      },
      persist: async () => {
        writes += 1;
      },
    });
    await ctrl.run({ state: JP, locale: { language: "zh-CN" } });
    await ctrl.run({ state: JP, locale: { language: "zh-CN" }, force: true });
    assert.equal(writes, 2);
  });

  test("8. resolver order-only change does not persist", async () => {
    let writes = 0;
    let n = 0;
    const a = { ip: "203.0.113.8", countryCode: "JP", org: "NTT" };
    const b = { ip: "203.0.113.9", countryCode: "JP", org: "NTT" };
    const ctrl = createDiagnosticsController({
      now: () => 33_000_000,
      lookupDns: async () => {
        n += 1;
        return { resolvers: n === 1 ? [a, b] : [b, a], provider: "bash.ws" };
      },
      persist: async () => {
        writes += 1;
      },
    });
    await ctrl.run({ state: JP, locale: { language: "zh-CN" } });
    await ctrl.run({ state: JP, locale: { language: "zh-CN" }, force: true });
    assert.equal(writes, 1);
    assert.deepEqual(stableDnsResolvers([b, a]), stableDnsResolvers([a, b]));
    const fp1 = diagnosticsFingerprint(
      buildDiagnostics({ exit: JP, virtual: JP, dns: { resolvers: [a, b], provider: "bash.ws" } }),
    );
    const fp2 = diagnosticsFingerprint(
      buildDiagnostics({ exit: JP, virtual: JP, dns: { resolvers: [b, a], provider: "bash.ws" } }),
    );
    assert.equal(fp1, fp2);
  });

  test("8b. resolver order-only with different countries still same fingerprint", () => {
    const a = { ip: "203.0.113.8", countryCode: "JP", org: "NTT" };
    const b = { ip: "203.0.113.9", countryCode: "US", org: "Example" };
    const fp1 = diagnosticsFingerprint(
      buildDiagnostics({ exit: JP, virtual: JP, dns: { resolvers: [a, b], provider: "bash.ws" } }),
    );
    const fp2 = diagnosticsFingerprint(
      buildDiagnostics({ exit: JP, virtual: JP, dns: { resolvers: [b, a], provider: "bash.ws" } }),
    );
    assert.equal(fp1, fp2);
  });

  test("9. DNS timeout uses short retry TTL", async () => {
    let t = 0;
    let lookups = 0;
    const ctrl = createDiagnosticsController({
      now: () => t,
      lookupDns: async () => {
        lookups += 1;
        return { resolvers: [], error: "timeout", timedOut: true };
      },
      persist: async () => {},
    });
    await ctrl.run({ state: JP });
    assert.equal(lookups, 1);
    assert.equal(ctrl.snapshot().dns.technicalFailure, true);
    assert.equal(dnsTtlMs(ctrl.snapshot().dns), DNS_FAIL_CACHE_MS);
    t = DNS_FAIL_CACHE_MS - 1;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), false);
    t = DNS_FAIL_CACHE_MS;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), true);
    t = DNS_CACHE_MS - 1;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), true);
    await ctrl.run({ state: JP });
    assert.equal(lookups, 2);
  });

  test("10. successful DNS result keeps 15 minute TTL", async () => {
    let t = 40_000_000;
    let lookups = 0;
    const ctrl = createDiagnosticsController({
      now: () => t,
      lookupDns: async () => {
        lookups += 1;
        return { resolvers: [{ ip: "203.0.113.8", countryCode: "JP", org: "NTT" }], provider: "bash.ws" };
      },
      persist: async () => {},
    });
    await ctrl.run({ state: JP });
    assert.equal(lookups, 1);
    assert.equal(ctrl.snapshot().dns.technicalFailure, false);
    assert.equal(dnsTtlMs(ctrl.snapshot().dns), DNS_CACHE_MS);
    t = 40_000_000 + DNS_CACHE_MS - 1;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), false);
    assert.equal(dnsCacheValid(ctrl.snapshot().dns, JP.ip, t), true);
    t = 40_000_000 + DNS_CACHE_MS;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), true);
  });

  test("10b. public-dns unknown is not technical failure (15 min TTL)", async () => {
    let t = 50_000_000;
    let lookups = 0;
    const ctrl = createDiagnosticsController({
      now: () => t,
      lookupDns: async () => {
        lookups += 1;
        return { resolvers: [{ ip: "1.1.1.1", org: "Cloudflare" }], provider: "bash.ws" };
      },
      persist: async () => {},
    });
    await ctrl.run({ state: JP });
    assert.equal(lookups, 1);
    assert.equal(ctrl.snapshot().dns.consistency, "public-dns");
    assert.equal(ctrl.snapshot().dns.status, "unknown");
    assert.notEqual(ctrl.snapshot().dns.technicalFailure, true);
    assert.equal(dnsTtlMs(ctrl.snapshot().dns), DNS_CACHE_MS);
    t = 50_000_000 + DNS_FAIL_CACHE_MS + 1;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), false);
    t = 50_000_000 + DNS_CACHE_MS - 1;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), false);
    t = 50_000_000 + DNS_CACHE_MS;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), true);
  });

  test("11. aborted old DNS run does not become current unknown/error", async () => {
    const persisted = [];
    let calls = 0;
    const ctrl = createDiagnosticsController({
      now: () => 41_000_000,
      lookupDns: async ({ signal }) => {
        calls += 1;
        if (calls === 1) {
          await wait(80, signal);
          return { resolvers: [], error: "timeout", timedOut: true };
        }
        await wait(10, signal);
        return { resolvers: [{ ip: "1.1.1.1", org: "Cloudflare" }], provider: "bash.ws" };
      },
      persist: async (diag) => {
        persisted.push(diag);
      },
    });
    const pA = ctrl.run({ state: { ...JP, ip: IP_A } });
    await wait(5);
    const pB = ctrl.run({ state: { ...JP, ip: IP_B } });
    await Promise.all([pA, pB]);
    const dns = ctrl.snapshot().dns;
    assert.equal(dns.checkedForIp, IP_B);
    assert.notEqual(dns.technicalFailure, true);
    assert.ok(dns.resolvers.length >= 1);
    assert.equal(persisted.every((d) => d.dns.checkedForIp !== IP_A || !d.dns.technicalFailure), true);
    assert.equal(persisted.at(-1).dns.checkedForIp, IP_B);
  });

  test("12. diagnostics concurrency cannot affect core pipeline", async () => {
    const pipeWrites = [];
    const pipeline = createExitPipeline({
      lookupGeo: async () => ({ ...JP, provider: "ipapi", region: "Tokyo" }),
      persist: async () => {
        pipeWrites.push("pipe");
      },
      probeWebrtc: async () => {},
    });
    let n = 0;
    const ctrl = createDiagnosticsController({
      lookupDns: async ({ signal }) => {
        n += 1;
        await wait(n === 1 ? 50 : 8, signal);
        return { resolvers: [{ ip: "1.1.1.1", org: "Cloudflare" }], provider: "bash.ws" };
      },
      persist: async () => {},
    });
    const echo = await pipeline.onEcho({ ip: JP.ip, provider: "t", reason: "boot" });
    const dA = ctrl.run({ state: JP });
    await wait(5);
    const dB = ctrl.run({ state: { ...US } });
    if (echo && echo.geoPromise) await echo.geoPromise;
    await Promise.all([dA, dB]);
    assert.ok(pipeWrites.length >= 1);
    assert.equal(pipeline.snapshot().state.ip, JP.ip);
    assert.equal(pipeline.snapshot().state.timezone, "Asia/Tokyo");
    assert.equal(ctrl.snapshot().network.detectedIp, US.ip);
  });
});

function dualDns({ bashBody, ipleakBody }) {
  return async (url) => {
    const u = String(url);
    if (u.includes("bash.ws/id")) return { text: async () => "7654321" };
    if (u.includes(".bash.ws")) return { text: async () => "ok" };
    if (u.includes("bash.ws/dnsleak")) {
      const body = typeof bashBody === "function" ? bashBody() : bashBody;
      return { text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
    }
    if (u.includes("ipleak.net/dnsdetection")) {
      const body = typeof ipleakBody === "function" ? ipleakBody() : ipleakBody;
      return { text: async () => body };
    }
    if (u.includes("ipleak.net/json")) {
      return { text: async () => JSON.stringify({ country_code: "US", isp_name: "Google" }) };
    }
    throw new Error(u);
  };
}

describe("1.2.2 diagnostics priority + DNS IP validation", () => {
  test("1. manual force A + auto A → manual survives", async () => {
    const persisted = [];
    let lookups = 0;
    let abortedManual = false;
    const ctrl = createDiagnosticsController({
      now: () => 50_000_000,
      lookupDns: async ({ signal }) => {
        lookups += 1;
        const mine = lookups;
        if (mine === 1 && signal) {
          signal.addEventListener("abort", () => {
            abortedManual = true;
          });
        }
        await wait(80, signal);
        return { resolvers: [{ ip: "9.9.9.9", org: "Quad9" }], provider: "bash.ws" };
      },
      persist: async (diag) => {
        persisted.push(diag);
      },
    });
    ctrl.hydrate({
      dns: {
        resolvers: [{ ip: "203.0.113.8", countryCode: "JP", org: "NTT" }],
        provider: "bash.ws",
        checkedForIp: JP.ip,
        checkedAt: 50_000_000,
        status: "ok",
        technicalFailure: false,
      },
    });
    const pManual = ctrl.run({ state: JP, force: true, reason: "manual" });
    await wait(5);
    const pAuto = ctrl.run({ state: JP, force: false, reason: "auto" });
    const [rm, ra] = await Promise.all([pManual, pAuto]);
    assert.equal(abortedManual, false);
    assert.equal(lookups, 1);
    assert.equal(ctrl.stats.skipped >= 1, true);
    assert.equal(ctrl.snapshot().dns.resolvers[0].ip, "9.9.9.9");
    assert.equal(ctrl.snapshot().dns.checkedForIp, JP.ip);
    assert.notEqual(ctrl.snapshot().dns.resolvers[0].ip, "203.0.113.8");
    assert.equal(rm.discarded, undefined);
    assert.equal(ra.ok, true);
    assert.equal(persisted.at(-1).dns.resolvers[0].ip, "9.9.9.9");
  });

  test("2. auto A + manual A → manual wins", async () => {
    let lookups = 0;
    let abortedAuto = false;
    const ctrl = createDiagnosticsController({
      now: () => 51_000_000,
      lookupDns: async ({ signal }) => {
        lookups += 1;
        const mine = lookups;
        if (mine === 1 && signal) {
          signal.addEventListener("abort", () => {
            abortedAuto = true;
          });
        }
        await wait(mine === 1 ? 80 : 10, signal);
        return {
          resolvers: [{ ip: mine === 1 ? "1.0.0.1" : "1.1.1.1", org: "Cloudflare" }],
          provider: "bash.ws",
        };
      },
      persist: async () => {},
    });
    const pAuto = ctrl.run({ state: JP, reason: "auto" });
    await wait(5);
    const pManual = ctrl.run({ state: JP, force: true, reason: "manual" });
    await Promise.all([pAuto, pManual]);
    assert.equal(abortedAuto, true);
    assert.equal(ctrl.snapshot().dns.resolvers[0].ip, "1.1.1.1");
    assert.equal(ctrl.activeRun, null);
  });

  test("3. manual A + new exit B → B wins", async () => {
    let abortedA = false;
    const ctrl = createDiagnosticsController({
      now: () => 52_000_000,
      lookupDns: async ({ signal }) => {
        if (signal && !abortedA) {
          signal.addEventListener("abort", () => {
            abortedA = true;
          });
        }
        await wait(80, signal);
        return { resolvers: [{ ip: "8.8.8.8", org: "Google" }], provider: "bash.ws" };
      },
      persist: async () => {},
    });
    const pA = ctrl.run({ state: JP, force: true, reason: "manual" });
    await wait(5);
    const pB = ctrl.run({ state: { ...US }, reason: "auto" });
    await Promise.all([pA, pB]);
    assert.equal(abortedA, true);
    assert.equal(ctrl.snapshot().network.detectedIp, US.ip);
    assert.equal(ctrl.snapshot().dns.checkedForIp, US.ip);
  });

  test("4. second manual replaces first manual", async () => {
    let lookups = 0;
    let abortedFirst = false;
    const ctrl = createDiagnosticsController({
      now: () => 53_000_000,
      lookupDns: async ({ signal }) => {
        lookups += 1;
        const mine = lookups;
        if (mine === 1 && signal) {
          signal.addEventListener("abort", () => {
            abortedFirst = true;
          });
        }
        await wait(mine === 1 ? 80 : 10, signal);
        return {
          resolvers: [{ ip: mine === 1 ? "9.9.9.9" : "149.112.112.112", org: "Quad9" }],
          provider: "bash.ws",
        };
      },
      persist: async () => {},
    });
    const p1 = ctrl.run({ state: JP, force: true, reason: "manual" });
    await wait(5);
    const p2 = ctrl.run({ state: JP, force: true, reason: "manual" });
    await Promise.all([p1, p2]);
    assert.equal(abortedFirst, true);
    assert.equal(ctrl.snapshot().dns.resolvers[0].ip, "149.112.112.112");
  });

  test("5. active controller is cleared after complete", async () => {
    const ctrl = createDiagnosticsController({
      now: () => 54_000_000,
      lookupDns: async () => ({ resolvers: [{ ip: "8.8.8.8", org: "Google" }], provider: "bash.ws" }),
      persist: async () => {},
    });
    assert.equal(ctrl.activeRun, null);
    const p = ctrl.run({ state: JP, reason: "auto" });
    assert.ok(ctrl.activeRun);
    assert.equal(ctrl.activeRun.reason, "auto");
    await p;
    assert.equal(ctrl.activeRun, null);
    const aborts = ctrl.stats.aborts;
    await ctrl.run({ state: JP, force: true, reason: "manual" });
    assert.equal(ctrl.activeRun, null);
    assert.equal(ctrl.stats.aborts, aborts);
  });

  test("6. Bad Gateway is not an IPv6 literal", () => {
    assert.equal(isValidIpLiteral("Bad"), false);
    assert.equal(isValidIpLiteral("Bad Gateway"), false);
    assert.equal(isValidIpLiteral("abcdef"), false);
    assert.throws(() => parseIpleakDetectionBody("Bad Gateway"), /unexpected response/);
  });

  test("7. HTML 502 does not produce a resolver", async () => {
    const html = "<html><body>502 Bad Gateway</body></html>";
    assert.throws(() => parseIpleakDetectionBody(html), /unexpected response/);
    const r = await createDnsProbe({
      fetchFn: dualDns({ bashBody: [{ type: "ip", ip: "1.2.3.4" }], ipleakBody: html }),
      now: () => 55_000_000,
    }).lookup();
    assert.equal(r.resolvers.length, 0);
    assert.ok(r.error);
  });

  test("8. invalid IPv4 999.999.999.999 is rejected", () => {
    assert.equal(isValidIpLiteral("999.999.999.999"), false);
    assert.equal(isValidIpLiteral("1.2.3"), false);
    assert.throws(() => parseIpleakDetectionBody("999.999.999.999"), /unexpected response/);
  });

  test("9. valid IPv4 is accepted", () => {
    assert.equal(isValidIpLiteral("8.8.8.8"), true);
    assert.equal(isValidIpLiteral(" 1.1.1.1 "), true);
    assert.equal(parseIpleakDetectionBody("8.8.8.8"), "8.8.8.8");
  });

  test("10. valid compressed IPv6 is accepted", () => {
    assert.equal(isValidIpLiteral("2001:4860:4860::8888"), true);
    assert.equal(isValidIpLiteral("::ffff:8.8.8.8"), true);
    assert.equal(parseIpleakDetectionBody("2001:4860:4860::8888"), "2001:4860:4860::8888");
  });

  test("11. bash 0 resolver → fallback ipleak", async () => {
    const r = await createDnsProbe({
      fetchFn: dualDns({
        bashBody: [{ type: "ip", ip: "203.0.113.1" }],
        ipleakBody: "8.8.8.8",
      }),
      now: () => 56_000_000,
    }).lookup();
    assert.equal(r.provider, "ipleak.net");
    assert.equal(r.resolvers[0].ip, "8.8.8.8");
  });

  test("12. bash invalid resolver rows → fallback ipleak", async () => {
    const r = await createDnsProbe({
      fetchFn: dualDns({
        bashBody: [
          { type: "dns", ip: "Bad" },
          { type: "dns", ip: "abcdef" },
          { type: "dns", ip: "999.999.999.999" },
        ],
        ipleakBody: "9.9.9.9",
      }),
      now: () => 57_000_000,
    }).lookup();
    assert.equal(r.provider, "ipleak.net");
    assert.equal(r.resolvers[0].ip, "9.9.9.9");
  });

  test("13. both providers 0 resolver → technicalFailure", async () => {
    const probe = createDnsProbe({
      fetchFn: dualDns({
        bashBody: [{ type: "dns", ip: "Bad" }],
        ipleakBody: "502 Bad Gateway",
      }),
      now: () => 58_000_000,
    });
    const looked = await probe.lookup();
    assert.equal(looked.resolvers.length, 0);
    const ctrl = createDiagnosticsController({
      now: () => 58_000_000,
      lookupDns: async () => looked,
      persist: async () => {},
    });
    const r = await ctrl.run({ state: JP, force: true });
    assert.equal(r.diagnostics.dns.technicalFailure, true);
    assert.equal(dnsTtlMs(r.diagnostics.dns), DNS_FAIL_CACHE_MS);
  });

  test("14. invalid resolver uses 60s failure TTL, not 15min", async () => {
    let t = 60_000_000;
    let lookups = 0;
    const ctrl = createDiagnosticsController({
      now: () => t,
      lookupDns: async () => {
        lookups += 1;
        return { resolvers: [{ ip: "Bad", org: "none" }], provider: "ipleak.net" };
      },
      persist: async () => {},
    });
    await ctrl.run({ state: JP, force: true });
    assert.equal(lookups, 1);
    assert.equal(ctrl.snapshot().dns.technicalFailure, true);
    assert.equal(dnsTtlMs(ctrl.snapshot().dns), DNS_FAIL_CACHE_MS);
    t = 60_000_000 + DNS_FAIL_CACHE_MS - 1;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), false);
    t = 60_000_000 + DNS_FAIL_CACHE_MS;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), true);
    t = 60_000_000 + DNS_CACHE_MS - 1;
    assert.equal(ctrl.dnsNeedsRefresh(JP.ip), true);
  });
});
