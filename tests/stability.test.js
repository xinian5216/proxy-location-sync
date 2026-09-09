import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { createPollerSupervisor } from "../lib/poller-mode.js";
import { resolveGeoMode, tzSpoofActive } from "../lib/geo-mode.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("offscreen / SW fallback mutex", () => {
  test("offscreen fail → fallback start → recover → fallback stop, one poller", () => {
    const p = createPollerSupervisor();
    assert.equal(p.activePoller(), "none");
    const fail = p.onOffscreenFailed();
    assert.equal(fail.startFallback, true);
    assert.equal(p.activePoller(), "fallback");
    const failAgain = p.onOffscreenFailed();
    assert.equal(failAgain.startFallback, false);
    const recover = p.onOffscreenReady();
    assert.equal(recover.stopFallback, true);
    assert.equal(recover.startFallback, false);
    assert.equal(p.isFallback(), false);
    assert.equal(p.activePoller(), "offscreen");
    const recoverAgain = p.onOffscreenReady();
    assert.equal(recoverAgain.stopFallback, false);
    assert.equal(p.activePoller(), "offscreen");
  });
});

describe("geo mode during A→B switch", () => {
  const A = {
    ip: "1.1.1.1",
    pendingIp: "",
    geoStatus: "ready",
    latitude: 35.67,
    longitude: 139.65,
    timezone: "Asia/Tokyo",
  };

  test("ready requires no pendingIp", () => {
    assert.equal(resolveGeoMode({ enabled: true }, A), "ready");
  });

  test("A ready → detect B → Geolocation pending, Date still has A timezone", () => {
    const switching = { ...A, pendingIp: "8.8.8.8", geoStatus: "pending" };
    assert.equal(resolveGeoMode({ enabled: true }, switching), "pending");
    assert.equal(tzSpoofActive({ enabled: true }, switching), true);
  });

  test("B geo error is error, not leftover A as current location", () => {
    const failed = { ...A, pendingIp: "8.8.8.8", geoStatus: "error" };
    assert.equal(resolveGeoMode({ enabled: true }, failed), "error");
    assert.equal(tzSpoofActive({ enabled: true }, failed), true);
  });

  test("disabled ignores leftover coords", () => {
    assert.equal(resolveGeoMode({ enabled: false }, A), "disabled");
    assert.equal(tzSpoofActive({ enabled: false }, A), false);
  });
});

describe("iframe test page ships in the zip", () => {
  test("frames.html covers about:blank, data:, blob:", () => {
    const html = readFileSync(join(root, "tests/frames.html"), "utf8");
    assert.match(html, /about:blank/);
    assert.match(html, /data:/);
    assert.match(html, /blob:/);
    assert.match(html, /match_origin_as_fallback/);
  });
});
