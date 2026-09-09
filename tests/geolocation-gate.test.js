import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createGeolocationController } from "../lib/geolocation-gate.js";

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createNative({ permission = "granted", delayMs = 0 } = {}) {
  const watches = new Map();
  let watchId = 1;
  let perm = permission;
  const realPos = {
    coords: { latitude: 37.7749, longitude: -122.4194, accuracy: 12 },
    timestamp: 1,
  };
  const calls = { get: 0, watch: 0, successToPage: 0, query: 0 };
  const fire = (fn) => {
    if (delayMs > 0) setTimeout(fn, delayMs);
    else queueMicrotask(fn);
  };
  return {
    realPos,
    calls,
    getCurrentPosition(success, error) {
      calls.get += 1;
      fire(() => {
        if (perm === "denied") {
          error && error({ code: 1, message: "User denied Geolocation" });
          return;
        }
        success(realPos);
      });
    },
    watchPosition(success, error) {
      calls.watch += 1;
      const id = watchId++;
      watches.set(id, { success, error });
      fire(() => success(realPos));
      return id;
    },
    clearWatch(id) {
      watches.delete(id);
    },
    permissionsQuery: async () => {
      calls.query += 1;
      return { state: perm };
    },
    setPermission(p) {
      perm = p;
    },
    emitWatch() {
      for (const rec of watches.values()) rec.success(realPos);
    },
    watchCount() {
      return watches.size;
    },
  };
}

function makeCtl({ mode, coords, native }) {
  let currentMode = mode;
  let currentCoords = coords;
  const ctl = createGeolocationController({
    getMode: () => currentMode,
    getCoords: () => currentCoords,
    native,
    now: () => 1_700_000_000_000,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancelSchedule: (id) => clearTimeout(id),
  });
  return {
    ctl,
    setMode(m) {
      currentMode = m;
      ctl.onModeOrCoordsChange();
    },
    setCoords(c) {
      currentCoords = c;
      ctl.onModeOrCoordsChange();
    },
  };
}

const TOKYO = { latitude: 35.6762, longitude: 139.6503, accuracy: 1500, ip: "103.1.2.3" };
const LA = { latitude: 34.0522, longitude: -118.2437, accuracy: 1600, ip: "104.1.2.3" };

describe("geolocation fail-closed pending", () => {
  const native = createNative();
  afterEach(() => {
    native.calls.get = 0;
    native.calls.watch = 0;
  });

  test("document_start: enabled+pending never delivers native coords", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "pending", coords: null, native });
    let got = null;
    let err = null;
    box.ctl.getCurrentPosition(
      (p) => {
        got = p;
      },
      (e) => {
        err = e;
      },
    );
    await wait(20);
    assert.equal(got, null);
    assert.equal(err, null);
    assert.equal(native.calls.get, 0, "granted must not wake the native sensor");
  });

  test("pending getCurrentPosition delivers virtual coords after ready", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "pending", coords: null, native });
    const p = new Promise((resolve, reject) => {
      box.ctl.getCurrentPosition(resolve, reject);
    });
    await wait(10);
    box.setCoords(TOKYO);
    box.setMode("ready");
    const pos = await p;
    assert.equal(pos.coords.latitude, TOKYO.latitude);
    assert.notEqual(pos.coords.latitude, native.realPos.coords.latitude);
  });

  test("pending honors timeout", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "pending", coords: null, native });
    const err = await new Promise((resolve) => {
      box.ctl.getCurrentPosition(
        () => resolve(null),
        (e) => resolve(e),
        { timeout: 15 },
      );
    });
    await wait(30);
    assert.ok(err);
    assert.equal(err.code, 3);
  });

  test("pending watchPosition never starts native watch", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "pending", coords: null, native });
    const events = [];
    const id = box.ctl.watchPosition((p) => events.push(p.coords.latitude));
    await wait(20);
    assert.equal(native.watchCount(), 0);
    assert.equal(events.length, 0);
    box.setCoords(TOKYO);
    box.setMode("ready");
    await wait(20);
    assert.equal(events[0], TOKYO.latitude);
    box.ctl.clearWatch(id);
  });

  test("watchPosition first millisecond then Tokyo → LA", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "pending", coords: null, native });
    const events = [];
    const id = box.ctl.watchPosition((p) => events.push(`${p.coords.latitude}`));
    box.setCoords(TOKYO);
    box.setMode("ready");
    await wait(15);
    box.setCoords(LA);
    await wait(15);
    box.ctl.clearWatch(id);
    box.setCoords(TOKYO);
    await wait(15);
    assert.ok(events.includes(String(TOKYO.latitude)));
    assert.ok(events.includes(String(LA.latitude)));
    assert.equal(events[events.length - 1], String(LA.latitude));
  });

  test("clearWatch stops further events", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "ready", coords: TOKYO, native });
    const events = [];
    const id = box.ctl.watchPosition((p) => events.push(p.coords.latitude));
    await wait(15);
    box.ctl.clearWatch(id);
    const n = events.length;
    box.setCoords(LA);
    await wait(15);
    assert.equal(events.length, n);
  });

  test("disabled uses native coords", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "disabled", coords: TOKYO, native });
    const pos = await new Promise((resolve, reject) => {
      box.ctl.getCurrentPosition(resolve, reject);
    });
    assert.equal(pos.coords.latitude, native.realPos.coords.latitude);
  });

  test("disable while pending flushes to native, not virtual", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "pending", coords: null, native });
    const p = new Promise((resolve, reject) => {
      box.ctl.getCurrentPosition(resolve, reject);
    });
    await wait(10);
    box.setMode("disabled");
    const pos = await p;
    assert.equal(pos.coords.latitude, native.realPos.coords.latitude);
  });

  test("enable after disable does not leak native to page", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "disabled", coords: null, native });
    box.setMode("pending");
    let got = null;
    box.ctl.getCurrentPosition((p) => {
      got = p;
    });
    await wait(20);
    assert.equal(got, null);
    box.setCoords(LA);
    box.setMode("ready");
    await wait(20);
    assert.equal(got.coords.latitude, LA.latitude);
  });

  test("permission denied never delivers virtual or native coords", async () => {
    const native = createNative({ permission: "denied" });
    const box = makeCtl({ mode: "ready", coords: TOKYO, native });
    const err = await new Promise((resolve, reject) => {
      box.ctl.getCurrentPosition(reject, resolve);
    });
    assert.equal(err.code, 1);
  });

  test("A→B→C rapid watch updates only latest virtual coords", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "ready", coords: TOKYO, native });
    const events = [];
    const id = box.ctl.watchPosition((p) => events.push(p.coords.ip || p.coords.latitude));
    await wait(10);
    box.setCoords(LA);
    await wait(10);
    box.setCoords({ latitude: 1.35, longitude: 103.8, accuracy: 1400, ip: "8.8.8.8" });
    await wait(10);
    box.ctl.clearWatch(id);
    assert.ok(events.includes(TOKYO.latitude));
    assert.ok(events.includes(LA.latitude));
    assert.equal(events[events.length - 1], 1.35);
    assert.ok(!events.includes(native.realPos.coords.latitude));
  });
});

describe("1.1.1 geolocation leak / switch / permission", () => {
  test("watch created while disabled, then enable: native watcher cleared, no real coords after", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "disabled", coords: null, native });
    const events = [];
    const id = box.ctl.watchPosition((p) => events.push(p.coords.latitude));
    await wait(20);
    assert.ok(native.watchCount() >= 1, "native watcher must exist while disabled");
    assert.equal(events[0], native.realPos.coords.latitude);
    assert.ok(id >= 1, "page must receive a logical watch id");

    box.setCoords(TOKYO);
    box.setMode("ready");
    await wait(20);
    assert.equal(native.watchCount(), 0, "native watcher must be cleared on enable");
    const nativeHits = events.filter((lat) => lat === native.realPos.coords.latitude).length;
    native.emitWatch();
    await wait(20);
    const nativeHitsAfter = events.filter((lat) => lat === native.realPos.coords.latitude).length;
    assert.equal(nativeHitsAfter, nativeHits, "later native emit must not reach the page");
    assert.ok(events.includes(TOKYO.latitude));
    assert.equal(events[events.length - 1], TOKYO.latitude);
    box.ctl.clearWatch(id);
    assert.equal(native.watchCount(), 0);
  });

  test("disabled getCurrentPosition delayed native success is discarded after enable", async () => {
    const native = createNative({ delayMs: 50 });
    const box = makeCtl({ mode: "disabled", coords: TOKYO, native });
    const got = [];
    box.ctl.getCurrentPosition((p) => got.push(p.coords.latitude));
    await wait(10);
    box.setMode("ready");
    await wait(80);
    assert.ok(!got.includes(native.realPos.coords.latitude), "native coords must be discarded");
    assert.ok(got.includes(TOKYO.latitude), "page should receive virtual coords");
  });

  test("A ready → B pending: getCurrentPosition must not return A", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "ready", coords: TOKYO, native });
    box.setMode("pending");
    let got = null;
    let err = null;
    box.ctl.getCurrentPosition(
      (p) => {
        got = p;
      },
      (e) => {
        err = e;
      },
    );
    await wait(20);
    assert.equal(got, null);
    assert.equal(err, null);
    box.setCoords(LA);
    box.setMode("ready");
    await wait(20);
    assert.equal(got.coords.latitude, LA.latitude);
    assert.notEqual(got.coords.latitude, TOKYO.latitude);
  });

  test("B geo error: new getCurrentPosition is POSITION_UNAVAILABLE, not A's coords", async () => {
    const native = createNative();
    const box = makeCtl({ mode: "ready", coords: TOKYO, native });
    box.setMode("error");
    const err = await new Promise((resolve, reject) => {
      box.ctl.getCurrentPosition(reject, resolve);
    });
    assert.equal(err.code, 2);
  });

  test("permission granted: virtual getCurrentPosition calls native get 0 times", async () => {
    const native = createNative({ permission: "granted" });
    const box = makeCtl({ mode: "ready", coords: TOKYO, native });
    const pos = await new Promise((resolve, reject) => {
      box.ctl.getCurrentPosition(resolve, reject);
    });
    assert.equal(pos.coords.latitude, TOKYO.latitude);
    assert.equal(native.calls.get, 0);
    assert.ok(native.calls.query >= 1);
  });

  test("permission denied: native getCurrentPosition is never called", async () => {
    const native = createNative({ permission: "denied" });
    const box = makeCtl({ mode: "ready", coords: TOKYO, native });
    const err = await new Promise((resolve, reject) => {
      box.ctl.getCurrentPosition(reject, resolve);
    });
    assert.equal(err.code, 1);
    assert.equal(native.calls.get, 0);
  });

  test("permission prompt: native getCurrentPosition is used as the gate", async () => {
    const native = createNative({ permission: "prompt" });
    const box = makeCtl({ mode: "ready", coords: TOKYO, native });
    const pos = await new Promise((resolve, reject) => {
      box.ctl.getCurrentPosition(resolve, reject);
    });
    assert.equal(pos.coords.latitude, TOKYO.latitude);
    assert.notEqual(pos.coords.latitude, native.realPos.coords.latitude);
    assert.ok(native.calls.get >= 1);
  });
});

describe("watchPosition permission revoke", () => {
  test("granted → denied errors once; re-grant does not revive watcher", async () => {
    const perm = {
      state: "granted",
      listeners: [],
      addEventListener(_t, fn) {
        this.listeners.push(fn);
      },
      fire() {
        for (const fn of this.listeners) fn();
      },
    };
    const native = createNative({ permission: "granted" });
    native.permissionsQuery = async () => perm;
    const box = makeCtl({ mode: "ready", coords: TOKYO, native });
    const events = [];
    const errors = [];
    box.ctl.watchPosition(
      (p) => events.push(p.coords.latitude),
      (e) => errors.push(e.code),
    );
    await wait(20);
    assert.ok(events.includes(TOKYO.latitude));
    perm.state = "denied";
    perm.fire();
    await wait(15);
    assert.deepEqual(errors, [1]);
    const n = events.length;
    box.setCoords(LA);
    await wait(15);
    assert.equal(events.length, n);
    perm.state = "granted";
    perm.fire();
    await wait(15);
    assert.equal(events.length, n);
    box.ctl.watchPosition((p) => events.push(p.coords.latitude));
    await wait(20);
    assert.equal(events[events.length - 1], LA.latitude);
  });
});
