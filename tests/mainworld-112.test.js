import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const injectedSrc = readFileSync(join(root, "content/injected.js"), "utf8");

const NATIVE = {
  coords: { latitude: 37.7749, longitude: -122.4194, accuracy: 12 },
  timestamp: 1,
};

const TOKYO = {
  ip: "103.1.2.3",
  latitude: 35.6762,
  longitude: 139.6503,
  accuracy: 1500,
  timezone: "Asia/Tokyo",
  geoStatus: "ready",
  countryCode: "JP",
  city: "Tokyo",
};

const LA = {
  ip: "104.1.2.3",
  latitude: 34.0522,
  longitude: -118.2437,
  accuracy: 1600,
  timezone: "America/Los_Angeles",
  geoStatus: "ready",
  countryCode: "US",
  city: "Los Angeles",
};

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadInjected({ bootstrap, permission = "granted" } = {}) {
  const isolated = vm.runInNewContext("({ Date, Intl })");
  const hostTz = new isolated.Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hostOffset = new isolated.Date().getTimezoneOffset();
  const calls = { get: 0, watch: 0, clear: [] };

  const perm = {
    state: permission,
    listeners: [],
    addEventListener(_type, fn) {
      this.listeners.push(fn);
    },
    fire() {
      for (const fn of this.listeners) fn();
    },
  };

  function Geolocation() {}
  Geolocation.prototype.getCurrentPosition = function getCurrentPosition(success) {
    calls.get += 1;
    queueMicrotask(() => success(NATIVE));
  };
  Geolocation.prototype.watchPosition = function watchPosition(success) {
    calls.watch += 1;
    queueMicrotask(() => success(NATIVE));
    return 77;
  };
  Geolocation.prototype.clearWatch = function clearWatch(id) {
    calls.clear.push(id);
  };

  const instance = Object.create(Geolocation.prototype);
  instance.getCurrentPosition = Geolocation.prototype.getCurrentPosition;
  instance.watchPosition = Geolocation.prototype.watchPosition;
  instance.clearWatch = Geolocation.prototype.clearWatch;

  class HTMLGeolocationElement {
    constructor() {
      this.autolocate = false;
      this.watch = false;
      this.permissionStatus = permission;
      this.initialPermissionStatus = permission;
      this.isValid = true;
      this.invalidReason = "";
      this._native = NATIVE;
      this._loc = [];
    }
    addEventListener(type, fn) {
      if (type === "location") this._loc.push(fn);
    }
    dispatchEvent(ev) {
      if (ev && ev.type === "location") {
        for (const fn of this._loc) fn.call(this, ev);
      }
      return true;
    }
    get position() {
      return this._native;
    }
    get error() {
      if (this.isValid === false) {
        return this._nativeError || { code: 2, message: "native invalid" };
      }
      return null;
    }
  }

  function GeolocationCoordinates() {}
  function GeolocationPosition() {}
  class GeolocationPositionError extends Error {
    static PERMISSION_DENIED = 1;
    static POSITION_UNAVAILABLE = 2;
    static TIMEOUT = 3;
  }

  const listeners = [];
  const created = [];
  const parserEl = new HTMLGeolocationElement();
  created.push(parserEl);

  const document = {
    documentElement: { nodeName: "HTML" },
    createElement(name, options) {
      if (String(name).toLowerCase() === "geolocation") {
        const el = new HTMLGeolocationElement();
        created.push(el);
        return el;
      }
      return { nodeName: String(name), options };
    },
    querySelectorAll() {
      return created.slice();
    },
  };

  const sandbox = {
    navigator: {
      geolocation: instance,
      permissions: { query: async () => perm },
    },
    document,
    Date: isolated.Date,
    Intl: isolated.Intl,
    Error,
    Object,
    Array,
    Number,
    String,
    Math,
    JSON,
    Reflect,
    Set,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Event: class Event {
      constructor(type) {
        this.type = type;
        this.isTrusted = false;
      }
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    MutationObserver: class {
      observe() {}
    },
    Geolocation,
    GeolocationCoordinates,
    GeolocationPosition,
    GeolocationPositionError,
    HTMLGeolocationElement,
    console,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (type, fn) => listeners.push({ type, fn });
  sandbox.window.dispatchEvent = (ev) => {
    for (const rec of listeners) {
      if (!rec.type || rec.type === ev.type) rec.fn(ev);
    }
    return true;
  };
  if (bootstrap) sandbox.__PLS_BOOTSTRAP__ = bootstrap;

  vm.runInNewContext(injectedSrc, sandbox, { filename: "injected.js" });
  return { sandbox, calls, created, parserEl, NATIVE, isolated, hostTz, hostOffset, perm };
}

function applyReady(sandbox, state) {
  sandbox.__PLS_APPLY__({
    settings: { enabled: true },
    state,
  });
}

function currentPosition(sandbox, via = "instance", options = { timeout: 250 }) {
  const geo = sandbox.navigator.geolocation;
  return new Promise((resolve, reject) => {
    const ok = (p) => resolve(p);
    const err = (e) => reject(e);
    if (via === "proto") {
      sandbox.Geolocation.prototype.getCurrentPosition.call(geo, ok, err, options);
    } else if (via === "getPrototypeOf") {
      Object.getPrototypeOf(geo).getCurrentPosition.call(geo, ok, err, options);
    } else {
      geo.getCurrentPosition(ok, err, options);
    }
  });
}

function assertNotNative(pos) {
  assert.ok(pos && pos.coords);
  assert.notEqual(pos.coords.latitude, NATIVE.coords.latitude);
  assert.notEqual(pos.coords.longitude, NATIVE.coords.longitude);
}

describe("MAIN world injected.js — P0 trusted / bootstrap attacks", () => {
  test("page __PLS_APPLY__({trusted:true, settings:{enabled:false}}) cannot restore native GPS", async () => {
    const { sandbox, calls } = loadInjected();
    applyReady(sandbox, TOKYO);
    const before = await currentPosition(sandbox);
    assert.equal(before.coords.latitude, TOKYO.latitude);
    assert.equal(calls.get, 0);

    sandbox.__PLS_APPLY__({
      trusted: true,
      settings: { enabled: false },
    });

    const after = await currentPosition(sandbox);
    assert.equal(after.coords.latitude, TOKYO.latitude);
    assertNotNative(after);
    assert.equal(calls.get, 0, "granted path must not invoke native getCurrentPosition");
  });

  test("pre-seeded __PLS_BOOTSTRAP__={settings:{enabled:false}} does not initialize native mode", async () => {
    const { sandbox, calls } = loadInjected({
      bootstrap: { settings: { enabled: false } },
    });
    let pos = null;
    let err = null;
    try {
      pos = await currentPosition(sandbox, "instance", { timeout: 40 });
    } catch (e) {
      err = e;
    }
    assert.equal(pos, null);
    assert.ok(err, "pending must not deliver a position");
    assert.notEqual(err && err.code, undefined);
    assert.equal(calls.get, 0);
    assert.equal(calls.watch, 0);
  });

  test("forged CustomEvent STATE with trusted+disabled after ready stays virtual", async () => {
    const { sandbox, calls } = loadInjected();
    applyReady(sandbox, TOKYO);
    sandbox.window.dispatchEvent(
      new sandbox.CustomEvent("__pls_v1", {
        detail: {
          type: "STATE",
          trusted: true,
          settings: { enabled: false },
        },
      }),
    );
    const pos = await currentPosition(sandbox);
    assert.equal(pos.coords.latitude, TOKYO.latitude);
    assertNotNative(pos);
    assert.equal(calls.get, 0);
  });
});

describe("MAIN world injected.js — Geolocation.prototype", () => {
  test("prototype.getCurrentPosition.call is virtual, not native", async () => {
    const { sandbox, calls } = loadInjected();
    applyReady(sandbox, TOKYO);
    const pos = await currentPosition(sandbox, "proto");
    assert.equal(pos.coords.latitude, TOKYO.latitude);
    assertNotNative(pos);
    assert.equal(calls.get, 0);
  });

  test("Object.getPrototypeOf(geolocation).getCurrentPosition.call is virtual", async () => {
    const { sandbox, calls } = loadInjected();
    applyReady(sandbox, TOKYO);
    const pos = await currentPosition(sandbox, "getPrototypeOf");
    assert.equal(pos.coords.latitude, TOKYO.latitude);
    assertNotNative(pos);
    assert.equal(calls.get, 0);
  });

  test("prototype.watchPosition.call uses logical id; clearWatch does not hit native 77", async () => {
    const { sandbox, calls } = loadInjected();
    applyReady(sandbox, TOKYO);
    const events = [];
    const geo = sandbox.navigator.geolocation;
    const id = sandbox.Geolocation.prototype.watchPosition.call(
      geo,
      (p) => events.push(p.coords.latitude),
      (e) => events.push(`err:${e.code}`),
    );
    assert.notEqual(id, 77);
    assert.ok(id >= 1);
    await wait(30);
    assert.ok(events.includes(TOKYO.latitude));
    assert.ok(!events.includes(NATIVE.coords.latitude));
    sandbox.Geolocation.prototype.clearWatch.call(geo, id);
    assert.deepEqual(calls.clear, [], "logical id must not be forwarded to native clearWatch");
    assert.equal(calls.watch, 0);
  });
});

describe("MAIN world injected.js — Date / Intl constructor", () => {
  test("Date() and Date.prototype.constructor() both use virtual timezone", () => {
    const { sandbox, hostOffset } = loadInjected();
    applyReady(sandbox, TOKYO);
    assert.equal(sandbox.Date, sandbox.Date.prototype.constructor);
    const a = sandbox.Date();
    const b = sandbox.Date.prototype.constructor();
    assert.equal(typeof a, "string");
    assert.equal(typeof b, "string");
    assert.match(a, /GMT\+0900/);
    assert.match(b, /GMT\+0900/);
    assert.equal(new sandbox.Date().getTimezoneOffset(), -540);
    assert.equal(new sandbox.Date.prototype.constructor().getTimezoneOffset(), -540);
    if (hostOffset !== -540) {
      assert.notEqual(new sandbox.Date().getTimezoneOffset(), hostOffset);
    }
    const desc = Object.getOwnPropertyDescriptor(sandbox.Date.prototype, "constructor");
    assert.equal(desc.enumerable, false);
    assert.equal(desc.value, sandbox.Date);
  });

  test("new Date(...) and new Date.prototype.constructor(...) match Tokyo wall time", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const expected = Date.UTC(2026, 0, 15, 3, 0, 0);
    assert.equal(new sandbox.Date(2026, 0, 15, 12, 0, 0).getTime(), expected);
    assert.equal(new sandbox.Date.prototype.constructor(2026, 0, 15, 12, 0, 0).getTime(), expected);
  });

  test("Date.parse and Date.prototype.constructor.parse do not use host local TZ", () => {
    const { sandbox, isolated, hostOffset } = loadInjected();
    applyReady(sandbox, TOKYO);
    const expected = Date.UTC(2026, 0, 15, 3, 0, 0);
    assert.equal(sandbox.Date.parse("2026-01-15T12:00:00"), expected);
    assert.equal(sandbox.Date.prototype.constructor.parse("2026-01-15T12:00:00"), expected);
    if (hostOffset !== -540) {
      assert.notEqual(sandbox.Date.parse("2026-01-15T12:00:00"), isolated.Date.parse("2026-01-15T12:00:00"));
    }
  });

  test("Intl.DateTimeFormat.prototype.constructor uses virtual TZ; explicit timeZone wins", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    assert.equal(sandbox.Intl.DateTimeFormat, sandbox.Intl.DateTimeFormat.prototype.constructor);
    assert.equal(new sandbox.Intl.DateTimeFormat().resolvedOptions().timeZone, "Asia/Tokyo");
    assert.equal(
      new sandbox.Intl.DateTimeFormat.prototype.constructor().resolvedOptions().timeZone,
      "Asia/Tokyo",
    );
    assert.equal(
      new sandbox.Intl.DateTimeFormat("en-US", { timeZone: "Europe/London" }).resolvedOptions().timeZone,
      "Europe/London",
    );
    assert.equal(
      new sandbox.Intl.DateTimeFormat.prototype.constructor("en-US", { timeZone: "Europe/London" }).resolvedOptions()
        .timeZone,
      "Europe/London",
    );
  });
});

describe("MAIN world injected.js — HTMLGeolocationElement", () => {
  test("createElement('geolocation') position is virtual, never native", () => {
    const { sandbox, created } = loadInjected();
    const pendingEl = sandbox.document.createElement("geolocation");
    assert.equal(pendingEl.position, null, "fail-closed while pending");
    applyReady(sandbox, TOKYO);
    const el = sandbox.document.createElement("geolocation");
    assert.equal(el.position.coords.latitude, TOKYO.latitude);
    assert.notEqual(el.position.coords.latitude, NATIVE.coords.latitude);
    assert.equal(pendingEl.position.coords.latitude, TOKYO.latitude);
    assert.ok(created.length >= 2);
    const loc = new sandbox.Event("location");
    assert.equal(loc.isTrusted, false);
  });

  test("parser-created <geolocation> (querySelectorAll) is wrapped fail-closed then virtual", () => {
    const { sandbox, parserEl } = loadInjected();
    assert.equal(parserEl.position, null);
    applyReady(sandbox, TOKYO);
    assert.equal(parserEl.position.coords.latitude, TOKYO.latitude);
    assert.notEqual(parserEl.position.coords.latitude, NATIVE.coords.latitude);
    const protoPos = Object.getOwnPropertyDescriptor(sandbox.HTMLGeolocationElement.prototype, "position");
    assert.equal(typeof protoPos.get, "function");
    const viaProto = protoPos.get.call(parserEl);
    assert.equal(viaProto.coords.latitude, TOKYO.latitude);
  });
});

describe("MAIN world injected.js — watch error recovery + echo stale + shape", () => {
  test("watch ready A → B error once → later ready B on same watcher", async () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const events = [];
    const errors = [];
    const id = sandbox.navigator.geolocation.watchPosition(
      (p) => events.push(p.coords.latitude),
      (e) => errors.push(e.code),
    );
    await wait(25);
    assert.ok(events.includes(TOKYO.latitude));
    sandbox.__PLS_APPLY__({
      state: { ...TOKYO, pendingIp: LA.ip, geoStatus: "error", timezone: TOKYO.timezone },
    });
    await wait(25);
    assert.deepEqual(errors, [2]);
    sandbox.__PLS_APPLY__({
      state: { ...TOKYO, pendingIp: LA.ip, geoStatus: "error", timezone: TOKYO.timezone },
    });
    await wait(15);
    assert.deepEqual(errors, [2], "must not repeat the same error");
    applyReady(sandbox, LA);
    await wait(25);
    assert.equal(events[events.length - 1], LA.latitude);
    sandbox.navigator.geolocation.clearWatch(id);
  });

  test("echoStale does not keep serving old coords; Date keeps last timezone", async () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    sandbox.__PLS_APPLY__({
      state: { ...TOKYO, echoStale: true, geoStatus: "ready" },
    });
    let pos = null;
    let err = null;
    try {
      pos = await currentPosition(sandbox, "instance", { timeout: 40 });
    } catch (e) {
      err = e;
    }
    assert.equal(pos, null);
    assert.ok(err);
    assert.match(sandbox.Date(), /GMT\+0900/);
    assert.equal(new sandbox.Intl.DateTimeFormat().resolvedOptions().timeZone, "Asia/Tokyo");
  });

  test("synthetic position tries GeolocationPosition prototype; own coords win", async () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const pos = await currentPosition(sandbox);
    assert.equal(Object.getPrototypeOf(pos), sandbox.GeolocationPosition.prototype);
    assert.equal(Object.getPrototypeOf(pos.coords), sandbox.GeolocationCoordinates.prototype);
    assert.equal(pos instanceof sandbox.GeolocationPosition, true);
    assert.equal(pos.coords.latitude, TOKYO.latitude);
    assert.ok(typeof pos.toJSON === "function");
  });
});

describe("[runtime injected] Date getYear / setYear / Invalid setFullYear / non-ISO parse", () => {
  test("[runtime injected] getYear uses fake timezone year boundary", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const d = new sandbox.Date("2025-12-31T15:30:00Z");
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getYear(), 126);
    assert.equal(sandbox.Date.prototype.getYear.call(d), 126);
  });

  test("[runtime injected] setYear 0-99 is 1900+y in fake timezone", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const d = new sandbox.Date("2026-01-15T03:00:00Z");
    d.setYear(26);
    assert.equal(d.getFullYear(), 1926);
    assert.equal(d.getTime(), Date.UTC(1926, 0, 15, 3, 0, 0));
    const d2 = new sandbox.Date("2026-01-15T03:00:00Z");
    d2.setYear(2026);
    assert.equal(d2.getFullYear(), 2026);
    assert.equal(d2.getTime(), Date.UTC(2026, 0, 15, 3, 0, 0));
  });

  test("[runtime injected] Invalid Date.setFullYear recovers as Tokyo local midnight", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const d = new sandbox.Date(Number.NaN);
    const ret = d.setFullYear(2026);
    assert.equal(Number.isNaN(ret), false);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMonth(), 0);
    assert.equal(d.getDate(), 1);
    assert.equal(d.getTime(), Date.UTC(2025, 11, 31, 15, 0, 0, 0));
    assert.equal(d.getTime(), 1767193200000);
  });

  test("[runtime injected] Invalid Date.setFullYear recovers as Los Angeles local midnight", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, LA);
    const d = new sandbox.Date(Number.NaN);
    const ret = d.setFullYear(2026);
    assert.equal(Number.isNaN(ret), false);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getDate(), 1);
    assert.equal(d.getTime(), Date.UTC(2026, 0, 1, 8, 0, 0, 0));
    assert.equal(d.getTime(), 1767254400000);
  });

  test("[runtime injected] Invalid Date.setFullYear(2026, 5, 2) is June 2 00:00 fake TZ", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const d = new sandbox.Date(Number.NaN);
    d.setFullYear(2026, 5, 2);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 5);
    assert.equal(d.getDate(), 2);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getTime(), Date.UTC(2026, 5, 1, 15, 0, 0, 0));
  });

  test("[runtime injected] Invalid Date.setMonth/setHours stay Invalid; setYear recovers midnight", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const a = new sandbox.Date(Number.NaN);
    assert.equal(Number.isNaN(a.setMonth(0)), true);
    const b = new sandbox.Date(Number.NaN);
    assert.equal(Number.isNaN(b.setHours(12)), true);
    const c = new sandbox.Date(Number.NaN);
    assert.equal(Number.isNaN(c.setDate(1)), true);
    const d = new sandbox.Date(Number.NaN);
    d.setYear(26);
    assert.equal(d.getFullYear(), 1926);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getDate(), 1);
    assert.equal(d.getTime(), Date.UTC(1925, 11, 31, 15, 0, 0, 0));
  });

  test("[runtime injected] non-ISO Date.parse and new Date use fake timezone", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const expected = Date.UTC(2025, 11, 31, 15, 0, 0);
    assert.equal(sandbox.Date.parse("01/01/2026 00:00:00"), expected);
    assert.equal(sandbox.Date.parse("Jan 1 2026 00:00:00"), expected);
    assert.equal(sandbox.Date.parse("2026/01/01 00:00:00"), expected);
    assert.equal(new sandbox.Date("01/01/2026 00:00:00").getTime(), expected);
    assert.equal(new sandbox.Date("Jan 1 2026 00:00:00").getTime(), expected);
    assert.equal(new sandbox.Date("2026/01/01 00:00:00").getTime(), expected);
  });

  test("[runtime injected] explicit Z / GMT / numeric offset stay absolute", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    assert.equal(sandbox.Date.parse("2026-01-01T00:00:00Z"), Date.UTC(2026, 0, 1, 0, 0, 0));
    assert.equal(sandbox.Date.parse("01/01/2026 00:00:00 GMT+0900"), Date.UTC(2025, 11, 31, 15, 0, 0));
    const gmt = sandbox.Date.parse("January 1, 2026 00:00:00 GMT");
    assert.equal(gmt, Date.UTC(2026, 0, 1, 0, 0, 0));
    assert.notEqual(sandbox.Date.parse("2026-01-01T00:00:00Z"), Date.UTC(2025, 11, 31, 15, 0, 0));
  });

  test("[runtime injected] EST/EDT/PST/PDT stay native-absolute under fake Tokyo", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    assert.equal(sandbox.Date.parse("Jan 1 2026 00:00 EST"), Date.parse("Jan 1 2026 00:00 EST"));
    assert.equal(sandbox.Date.parse("Jan 1 2026 00:00 EST"), Date.UTC(2026, 0, 1, 5, 0, 0, 0));
    assert.equal(sandbox.Date.parse("Jan 1 2026 00:00 EDT"), Date.parse("Jan 1 2026 00:00 EDT"));
    assert.equal(sandbox.Date.parse("Jan 1 2026 00:00 PST"), Date.parse("Jan 1 2026 00:00 PST"));
    assert.equal(sandbox.Date.parse("Jan 1 2026 00:00 PDT"), Date.parse("Jan 1 2026 00:00 PDT"));
    assert.equal(sandbox.Date.parse("Jan 1 2026 00:00 EST"), 1767243600000);
    assert.notEqual(sandbox.Date.parse("Jan 1 2026 00:00 EST"), Date.UTC(2025, 11, 31, 20, 0, 0, 0));
    assert.equal(new sandbox.Date("Jan 1 2026 00:00 PST").getTime(), Date.parse("Jan 1 2026 00:00 PST"));
  });
});

describe("[runtime injected] HTMLGeolocationElement permission + watch events", () => {
  test("[runtime injected] prompt → position=null", () => {
    const { sandbox } = loadInjected({ permission: "prompt" });
    applyReady(sandbox, TOKYO);
    const el = sandbox.document.createElement("geolocation");
    el.permissionStatus = "prompt";
    assert.equal(el.position, null);
  });

  test("[runtime injected] denied → position=null", () => {
    const { sandbox } = loadInjected({ permission: "denied" });
    applyReady(sandbox, TOKYO);
    const el = sandbox.document.createElement("geolocation");
    el.permissionStatus = "denied";
    el.isValid = true;
    assert.equal(el.position, null);
  });

  test("[runtime injected] granted + valid → virtual position", () => {
    const { sandbox } = loadInjected({ permission: "granted" });
    applyReady(sandbox, TOKYO);
    const el = sandbox.document.createElement("geolocation");
    el.permissionStatus = "granted";
    el.isValid = true;
    assert.equal(el.position.coords.latitude, TOKYO.latitude);
    assert.notEqual(el.position.coords.latitude, NATIVE.coords.latitude);
  });

  test("[runtime injected] invalid element does not return fake position", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const el = sandbox.document.createElement("geolocation");
    el.isValid = false;
    assert.equal(el.position, null);
  });

  test("[runtime injected] invalid HTMLGeolocationElement.error does not recurse", () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const el = sandbox.document.createElement("geolocation");
    el.isValid = false;
    el._nativeError = { code: 99, message: "native-invalid" };
    assert.equal(el.position, null);
    let last;
    for (let i = 0; i < 100; i += 1) {
      last = el.error;
    }
    assert.equal(last.code, 99);
    assert.equal(last.message, "native-invalid");
  });

  test("[runtime injected] denied + isValid → error.code PERMISSION_DENIED", () => {
    const { sandbox } = loadInjected({ permission: "denied" });
    applyReady(sandbox, TOKYO);
    const el = sandbox.document.createElement("geolocation");
    el.permissionStatus = "denied";
    el.isValid = true;
    assert.equal(el.position, null);
    assert.equal(el.error.code, 1);
    assert.equal(el.error.code, sandbox.GeolocationPositionError.PERMISSION_DENIED);
  });

  test("[runtime injected] granted + geo error + isValid → POSITION_UNAVAILABLE", () => {
    const { sandbox } = loadInjected({ permission: "granted" });
    applyReady(sandbox, { ...TOKYO, geoStatus: "error" });
    const el = sandbox.document.createElement("geolocation");
    el.permissionStatus = "granted";
    el.isValid = true;
    assert.equal(el.position, null);
    assert.equal(el.error.code, 2);
    assert.equal(el.error.code, sandbox.GeolocationPositionError.POSITION_UNAVAILABLE);
  });

  test("[runtime injected] watch=false does not keep pushing location on A→B", async () => {
    const { sandbox } = loadInjected();
    const el = sandbox.document.createElement("geolocation");
    el.watch = false;
    el.autolocate = true;
    el.permissionStatus = "granted";
    const events = [];
    el.addEventListener("location", (ev) => {
      events.push({ trusted: ev.isTrusted, lat: el.position && el.position.coords && el.position.coords.latitude });
    });
    applyReady(sandbox, TOKYO);
    await wait(20);
    const n = events.length;
    assert.ok(n >= 1);
    assert.equal(events[0].trusted, false);
    applyReady(sandbox, LA);
    await wait(20);
    assert.equal(events.length, n);
  });

  test("[runtime injected] watch=false position read is one-shot; A→B does not dispatch", async () => {
    const { sandbox } = loadInjected();
    applyReady(sandbox, TOKYO);
    const el = sandbox.document.createElement("geolocation");
    el.watch = false;
    el.autolocate = false;
    el.permissionStatus = "granted";
    const events = [];
    el.addEventListener("location", () => events.push(el.position && el.position.coords.latitude));
    assert.equal(el.position.coords.latitude, TOKYO.latitude);
    applyReady(sandbox, LA);
    await wait(20);
    assert.equal(events.length, 0);
    assert.equal(el.position.coords.latitude, LA.latitude);
  });

  test("[runtime injected] watch=true A→B synthetic location isTrusted=false", async () => {
    const { sandbox } = loadInjected();
    const el = sandbox.document.createElement("geolocation");
    el.watch = true;
    el.permissionStatus = "granted";
    const events = [];
    el.addEventListener("location", (ev) => {
      events.push({ trusted: ev.isTrusted, lat: el.position && el.position.coords && el.position.coords.latitude });
    });
    applyReady(sandbox, TOKYO);
    await wait(20);
    applyReady(sandbox, LA);
    await wait(20);
    const lats = events.map((e) => e.lat);
    assert.ok(lats.includes(TOKYO.latitude));
    assert.ok(lats.includes(LA.latitude));
    assert.ok(events.every((e) => e.trusted === false));
  });
});

describe("[runtime injected] watchPosition permission revoke", () => {
  test("[runtime injected] granted→denied errors once; old watcher never resumes", async () => {
    const { sandbox, perm } = loadInjected({ permission: "granted" });
    applyReady(sandbox, TOKYO);
    const events = [];
    const errors = [];
    sandbox.navigator.geolocation.watchPosition(
      (p) => events.push(p.coords.latitude),
      (e) => errors.push(e.code),
    );
    await wait(30);
    assert.ok(events.includes(TOKYO.latitude));
    perm.state = "denied";
    perm.fire();
    await wait(20);
    assert.deepEqual(errors, [1]);
    const n = events.length;
    applyReady(sandbox, LA);
    await wait(20);
    assert.equal(events.length, n, "denied watcher must not receive B");
    perm.state = "granted";
    perm.fire();
    await wait(20);
    assert.equal(events.length, n, "re-grant must not revive old watcher");
    sandbox.navigator.geolocation.watchPosition((p) => events.push(p.coords.latitude));
    await wait(30);
    assert.equal(events[events.length - 1], LA.latitude);
  });
});

