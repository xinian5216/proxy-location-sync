import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { htmlGeolocationLabel, pickBackgroundPoller, runWebrtcProbe, runWorkerProbe } from "../lib/platform-runtime.js";
import { createPollerSupervisor } from "../lib/poller-mode.js";

describe("1.3.0 platform runtime", () => {
  test("Chromium with offscreen.createDocument stays on offscreen poller", () => {
    const api = { offscreen: { createDocument() {} } };
    assert.equal(pickBackgroundPoller(api, { fetch() {} }), "offscreen");
  });

  test("Firefox without offscreen uses background poller", () => {
    const api = { runtime: {}, alarms: {} };
    assert.equal(pickBackgroundPoller(api, { Worker: class {}, fetch() {} }), "background");
    assert.equal(pickBackgroundPoller({}, {}), "background");
  });

  test("WebRTC: offscreen send success does not run local probe", async () => {
    let local = 0;
    const sent = await runWebrtcProbe({
      offscreenAvailable: true,
      probeOffscreen: async () => true,
      probeLocal: async () => {
        local += 1;
        return { status: "ok" };
      },
      ip: "1.1.1.1",
    });
    assert.equal(sent, true);
    assert.equal(local, 0);
  });

  test("WebRTC: no offscreen → local probe; throw → unknown, never ok", async () => {
    const local = await runWebrtcProbe({
      offscreenAvailable: false,
      probeOffscreen: async () => true,
      probeLocal: async () => ({ status: "ok", reason: "srflx" }),
      ip: "8.8.8.8",
    });
    assert.equal(local.status, "ok");

    const missing = await runWebrtcProbe({ offscreenAvailable: false, ip: "8.8.8.8" });
    assert.equal(missing.status, "unknown");

    const boom = await runWebrtcProbe({
      offscreenAvailable: false,
      probeLocal: async () => {
        throw new Error("ice failed");
      },
      ip: "8.8.8.8",
    });
    assert.equal(boom.status, "unknown");
    assert.match(boom.reason, /ice failed/);
  });

  test("Worker: Firefox local probe; failure is ok:false unknown-class, not a throw", async () => {
    const ok = await runWorkerProbe({
      offscreenAvailable: false,
      probeLocal: async () => ({ ok: true, timezone: "Asia/Tokyo" }),
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.timezone, "Asia/Tokyo");

    const fail = await runWorkerProbe({
      offscreenAvailable: false,
      probeLocal: async () => {
        throw new Error("no Worker");
      },
    });
    assert.equal(fail.ok, false);
    assert.match(fail.reason, /no Worker/);

    const none = await runWorkerProbe({ offscreenAvailable: false });
    assert.equal(none.ok, false);
    assert.equal(none.reason, "Worker unavailable");
  });

  test("Worker: Chromium offscreen path used when document is open", async () => {
    let local = 0;
    const result = await runWorkerProbe({
      offscreenAvailable: true,
      hasOffscreenDocument: async () => true,
      probeOffscreen: async () => ({ ok: true, timezone: "America/New_York" }),
      probeLocal: async () => {
        local += 1;
        return { ok: true, timezone: "should-not-run" };
      },
    });
    assert.equal(result.timezone, "America/New_York");
    assert.equal(local, 0);
  });

  test("HTMLGeolocationElement missing → Not supported, never faked", () => {
    assert.equal(htmlGeolocationLabel(true), "present");
    assert.equal(htmlGeolocationLabel(false), "Not supported");
    assert.equal(htmlGeolocationLabel(undefined), "Not supported");
  });

  test("background poller alias starts fallback exactly once", () => {
    const p = createPollerSupervisor();
    const first = p.onBackgroundPoller();
    assert.equal(first.startFallback, true);
    assert.equal(p.activePoller(), "fallback");
    const second = p.onBackgroundPoller();
    assert.equal(second.startFallback, false);
  });
});
