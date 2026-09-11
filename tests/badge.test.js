import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { badgeCountryCode, updateBadge } from "../lib/badge.js";
import { createExitPipeline } from "../lib/exit-pipeline.js";

const US_STATE = {
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
  pendingIp: "",
  echoStale: false,
  lastSuccessfulEchoAt: 1_800_000_000_000,
};

const ENABLED = { enabled: true, intervalSec: 3, locationMode: "raw", webrtcProbe: true };

function mockAction() {
  const calls = { text: [], title: [], bg: [], fg: [] };
  const action = {
    async setBadgeText({ text }) {
      calls.text.push(text);
    },
    async setTitle({ title }) {
      calls.title.push(title);
    },
    async setBadgeBackgroundColor({ color }) {
      calls.bg.push(color);
    },
    async setBadgeTextColor({ color }) {
      calls.fg.push(color);
    },
  };
  return { action, calls };
}

async function refreshAction(action, state, settings) {
  await updateBadge(action, state, settings && settings.enabled);
}

async function simulateSwBoot({ state, settings = ENABLED, lookupGeo }) {
  const persistCalls = [];
  const { action, calls } = mockAction();
  let lookups = 0;
  const pipeline = createExitPipeline({
    lookupGeo:
      lookupGeo ||
      (async () => {
        lookups += 1;
        throw new Error("boot restore / heartbeat must not lookup Geo");
      }),
    persist: async (payload) => {
      persistCalls.push(payload);
      const snap = pipeline.snapshot();
      await refreshAction(action, snap.state, snap.settings);
    },
    probeWebrtc: async () => {},
  });
  pipeline.hydrate({
    settings,
    state,
    geoCache: state && state.ip ? { [state.ip]: { ...state, fetchedAt: Date.now() } } : {},
  });
  lookups = 0;
  pipeline.stats.storageSets = 0;
  pipeline.stats.geoLookups = 0;
  pipeline.stats.heartbeats = 0;
  const snap = pipeline.snapshot();
  await refreshAction(action, snap.state, snap.settings);
  return { pipeline, action, calls, persistCalls, lookups: () => lookups };
}

describe("1.2.4 badge restore after SW boot", () => {
  test("storage countryCode US → boot calls setBadgeText({text:\"US\"})", async () => {
    const { calls } = await simulateSwBoot({ state: US_STATE });
    assert.ok(calls.text.includes("US"));
    assert.equal(calls.text[calls.text.length - 1], "US");
  });

  test("boot then same-IP heartbeat keeps US and writes zero storage", async () => {
    const { pipeline, calls, persistCalls } = await simulateSwBoot({ state: US_STATE });
    const geoBefore = pipeline.stats.geoLookups;
    const storageBefore = pipeline.stats.storageSets;
    assert.equal(calls.text[calls.text.length - 1], "US");
    for (let i = 0; i < 20; i += 1) {
      const r = await pipeline.onEcho({ ip: US_STATE.ip, provider: "ipify64", reason: "echo" });
      assert.equal(r.heartbeat, true);
    }
    assert.equal(pipeline.stats.heartbeats, 20);
    assert.equal(pipeline.stats.storageSets, storageBefore);
    assert.equal(pipeline.stats.geoLookups, geoBefore);
    assert.equal(persistCalls.length, 0);
    assert.equal(calls.text[calls.text.length - 1], "US");
    assert.equal(calls.text.filter((t) => t === "US").length, 1);
  });

  test("JP / HK / SG show as two-letter uppercase", async () => {
    for (const code of ["JP", "HK", "SG", "jp", " hk "]) {
      const { calls } = await simulateSwBoot({
        state: { ...US_STATE, countryCode: code, country: code },
      });
      assert.equal(calls.text[calls.text.length - 1], code.trim().toUpperCase().slice(0, 2));
    }
    assert.equal(badgeCountryCode({ countryCode: "jp" }, true), "JP");
    assert.equal(badgeCountryCode({ countryCode: "HK" }, true), "HK");
    assert.equal(badgeCountryCode({ countryCode: "SG" }, true), "SG");
  });

  test("empty countryCode clears badge", async () => {
    const { action, calls } = mockAction();
    await updateBadge(action, { ...US_STATE, countryCode: "" }, true);
    assert.equal(calls.text[calls.text.length - 1], "");
    await updateBadge(action, { ...US_STATE, countryCode: "   " }, true);
    assert.equal(calls.text[calls.text.length - 1], "");
    await updateBadge(action, { ...US_STATE, countryCode: null }, true);
    assert.equal(calls.text[calls.text.length - 1], "");
    const boot = await simulateSwBoot({ state: { ...US_STATE, countryCode: "" } });
    assert.equal(boot.calls.text[boot.calls.text.length - 1], "");
  });

  test("settings.enabled=false clears badge even if countryCode is US", async () => {
    const { calls } = await simulateSwBoot({
      state: US_STATE,
      settings: { ...ENABLED, enabled: false },
    });
    assert.equal(calls.text[calls.text.length - 1], "");
    const { action, calls: direct } = mockAction();
    await updateBadge(action, US_STATE, false);
    assert.equal(direct.text[direct.text.length - 1], "");
  });

  test("boot restore badge does not lookup Geo or persist", async () => {
    const { pipeline, persistCalls, lookups } = await simulateSwBoot({ state: US_STATE });
    assert.equal(lookups(), 0);
    assert.equal(pipeline.stats.geoLookups, 0);
    assert.equal(pipeline.stats.storageSets, 0);
    assert.equal(persistCalls.length, 0);
  });
});
