import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { createAbortSlot, runExclusive } from "../lib/abort-slot.js";
import { applyEchoFailure, isEchoStale } from "../lib/echo-stale.js";
import { resolveGeoMode, resolveMainWorldGeoMode, mergePublicSettings, mergePublicState } from "../lib/geo-mode.js";
import {
  elementErrorForMode,
  elementPositionForMode,
  failClosedGeolocationElement,
  patchHtmlGeolocationPrototype,
} from "../lib/html-geo-element.js";
import { collectTabIds } from "../lib/tab-targets.js";
import { createGeolocationController, installGeolocationPatches } from "../lib/geolocation-gate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const TOKYO = { latitude: 35.6762, longitude: 139.6503, accuracy: 1500, ip: "103.1.2.3" };
const LA = { latitude: 34.0522, longitude: -118.2437, accuracy: 1600, ip: "104.1.2.3" };

describe("SW restart tab discovery", () => {
  test("seenTabs empty + queried tabs [1,2,3] → all updated", () => {
    const ids = collectTabIds([], [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.deepEqual(ids.sort(), [1, 2, 3]);
  });

  test("merges leftover seenTabs with query", () => {
    const ids = collectTabIds([2, 9], [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(ids.sort(), [1, 2, 9]);
  });
});

describe("WebRTC AbortController A/B race", () => {
  test("A start → B start aborts A; A finally keeps B; stop aborts B", async () => {
    const slot = createAbortSlot();
    let aAborted = false;
    let bAborted = false;
    const a = runExclusive(slot, (signal) => {
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve("a-done"), 80);
        signal.addEventListener("abort", () => {
          aAborted = true;
          clearTimeout(t);
          resolve("a-aborted");
        });
      });
    });
    await wait(5);
    const b = runExclusive(slot, (signal) => {
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve("b-done"), 80);
        signal.addEventListener("abort", () => {
          bAborted = true;
          clearTimeout(t);
          resolve("b-aborted");
        });
      });
    });
    const aResult = await a;
    assert.equal(aResult, "a-aborted");
    assert.equal(aAborted, true);
    assert.ok(slot.getCurrent(), "B controller must still be current after A finally");
    slot.abortCurrent();
    const bResult = await b;
    assert.equal(bResult, "b-aborted");
    assert.equal(bAborted, true);
  });
});

describe("watchPosition error then recovery", () => {
  test("ready A → B error once → later ready B position on same watcher", async () => {
    let mode = "ready";
    let coords = TOKYO;
    const native = {
      getCurrentPosition() {},
      watchPosition() {
        return 1;
      },
      clearWatch() {},
      permissionsQuery: async () => ({ state: "granted" }),
    };
    const ctl = createGeolocationController({
      getMode: () => mode,
      getCoords: () => coords,
      native,
    });
    const events = [];
    const errors = [];
    const id = ctl.watchPosition(
      (p) => events.push(p.coords.latitude),
      (e) => errors.push(e.code),
    );
    await wait(15);
    assert.ok(events.includes(TOKYO.latitude));
    mode = "error";
    coords = TOKYO;
    ctl.onModeOrCoordsChange();
    await wait(15);
    assert.deepEqual(errors, [2]);
    ctl.onModeOrCoordsChange();
    await wait(10);
    assert.deepEqual(errors, [2], "must not repeat the same error");
    coords = LA;
    mode = "ready";
    ctl.onModeOrCoordsChange();
    await wait(15);
    assert.equal(events[events.length - 1], LA.latitude);
    ctl.clearWatch(id);
  });
});

describe("echo stale + MAIN world apply sanitizers", () => {
  test("lastSuccessfulEchoAt older than 20s is stale", () => {
    const now = 1_700_000_020_000;
    assert.equal(
      isEchoStale({ ip: "1.1.1.1", lastSuccessfulEchoAt: now - 21_000, geoStatus: "ready" }, now),
      true,
    );
    assert.equal(
      isEchoStale({ ip: "1.1.1.1", lastSuccessfulEchoAt: now - 5_000, geoStatus: "ready" }, now),
      false,
    );
  });

  test("applyEchoFailure marks pending and keeps timezone", () => {
    const now = 1_700_000_020_000;
    const next = applyEchoFailure(
      {
        ip: "1.1.1.1",
        timezone: "Asia/Tokyo",
        lastSuccessfulEchoAt: now - 30_000,
        geoStatus: "ready",
        latitude: 35,
        longitude: 139,
      },
      { error: "timeout", now },
    );
    assert.equal(next.echoStale, true);
    assert.equal(next.geoStatus, "pending");
    assert.equal(next.timezone, "Asia/Tokyo");
    assert.equal(resolveGeoMode({ enabled: true }, next), "pending");
    assert.equal(resolveMainWorldGeoMode(next), "pending");
  });

  test("MAIN geo mode ignores persisted lastSuccessfulEchoAt unless echoStale flag", () => {
    const state = {
      ip: "1.1.1.1",
      geoStatus: "ready",
      latitude: 35,
      longitude: 139,
      lastSuccessfulEchoAt: Date.now() - 60_000,
      echoStale: false,
    };
    assert.equal(resolveMainWorldGeoMode(state), "ready");
    assert.equal(resolveGeoMode({ enabled: true }, state), "ready");
  });

  test("public apply cannot disable or wipe timezone", () => {
    const settings = mergePublicSettings({ enabled: true }, { enabled: false, intervalSec: 5 });
    assert.equal(settings.enabled, true);
    assert.equal(settings.intervalSec, 5);
    const state = mergePublicState(
      { timezone: "Asia/Tokyo", ip: "1.1.1.1" },
      { ip: "8.8.8.8", timezone: "" },
    );
    assert.equal(state.timezone, "Asia/Tokyo");
    const prev = { timezone: "Asia/Tokyo" };
    assert.equal(mergePublicState(prev, null), prev);
  });
});

describe("HTMLGeolocationElement helper", () => {
  test("position getter returns virtual when ready, null when pending", () => {
    const virtual = { coords: { latitude: 1, longitude: 2 } };
    assert.equal(elementPositionForMode("ready", virtual), virtual);
    assert.equal(elementPositionForMode("pending", virtual), null);
    assert.equal(elementPositionForMode("ready", virtual, { permission: "prompt" }), null);
    assert.equal(elementPositionForMode("ready", virtual, { permission: "denied" }), null);
    assert.equal(elementPositionForMode("ready", virtual, { valid: false }), null);
    assert.equal(elementErrorForMode("error", (c) => ({ code: c })).code, 2);
  });

  test("prototype patch hides native position while spoofing", () => {
    const proto = {};
    let nativeHits = 0;
    Object.defineProperty(proto, "position", {
      configurable: true,
      get() {
        nativeHits += 1;
        return { coords: { latitude: 37.7, longitude: -122.4 } };
      },
    });
    let mode = "ready";
    const r = patchHtmlGeolocationPrototype({
      proto,
      getMode: () => mode,
      getVirtualPosition: () => ({ coords: { latitude: 35.67, longitude: 139.65 } }),
      makeError: (c, m) => ({ code: c, message: m }),
    });
    assert.equal(r.ok, true);
    const el = Object.create(proto);
    assert.equal(el.position.coords.latitude, 35.67);
    assert.equal(nativeHits, 0);
    mode = "pending";
    assert.equal(el.position, null);
  });

  test("fail-closed instance hides position if prototype cannot be patched", () => {
    const el = { position: { coords: { latitude: 37.7 } } };
    failClosedGeolocationElement(el);
    assert.equal(el.position, null);
  });
});

describe("geolocation-element.html ships", () => {
  test("covers autolocate / watch / skip below 144", () => {
    const html = readFileSync(join(root, "tests/geolocation-element.html"), "utf8");
    assert.match(html, /HTMLGeolocationElement/);
    assert.match(html, /autolocate/);
    assert.match(html, /watch/);
    assert.match(html, /isTrusted/);
  });
});

describe("installGeolocationPatches + popup copy", () => {
  test("proto.call and instance share the patched controller", async () => {
    const nativeHits = { get: 0 };
    function Geolocation() {}
    Geolocation.prototype.getCurrentPosition = function nativeGet(success) {
      nativeHits.get += 1;
      success({ coords: { latitude: 37.7, longitude: -122.4 } });
    };
    const instance = Object.create(Geolocation.prototype);
    instance.getCurrentPosition = Geolocation.prototype.getCurrentPosition;
    const ctl = createGeolocationController({
      getMode: () => "ready",
      getCoords: () => TOKYO,
      native: {
        getCurrentPosition: Geolocation.prototype.getCurrentPosition,
        watchPosition() {
          return 1;
        },
        clearWatch() {},
        permissionsQuery: async () => ({ state: "granted" }),
      },
    });
    installGeolocationPatches({
      proto: Geolocation.prototype,
      instance,
      getCurrentPosition: ctl.getCurrentPosition,
      watchPosition: ctl.watchPosition,
      clearWatch: ctl.clearWatch,
    });
    const viaInstance = await new Promise((resolve, reject) => instance.getCurrentPosition(resolve, reject));
    const viaProto = await new Promise((resolve, reject) =>
      Geolocation.prototype.getCurrentPosition.call(instance, resolve, reject),
    );
    assert.equal(viaInstance.coords.latitude, TOKYO.latitude);
    assert.equal(viaProto.coords.latitude, TOKYO.latitude);
    assert.equal(nativeHits.get, 0);
  });

  test("popup distinguishes current exit vs committed geo IP and stale echo", () => {
    const popup = readFileSync(join(root, "popup/popup.js"), "utf8");
    const html = readFileSync(join(root, "popup/popup.html"), "utf8");
    assert.match(html, /ip-kicker/);
    assert.match(popup, /当前检测出口/);
    assert.match(popup, /已同步定位对应 IP/);
    assert.match(popup, /出口检测失联/);
    assert.match(popup, /不会恢复系统定位/);
  });
});
