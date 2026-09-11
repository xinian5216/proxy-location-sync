import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ALARM_FIREFOX_POLL } from "../lib/constants.js";
import { createExitPipeline } from "../lib/exit-pipeline.js";
import {
  echoesForAlarmFires,
  firefoxPollAlarmInfo,
  firefoxPollAlarmNeedsUpdate,
  intervalSecToPeriodMinutes,
  planFirefoxPolling,
  shouldImmediateEcho,
} from "../lib/firefox-poll.js";

const TOKYO = {
  ip: "203.0.113.10",
  latitude: 35.6762,
  longitude: 139.6503,
  timezone: "Asia/Tokyo",
  city: "Tokyo",
  country: "Japan",
  countryCode: "JP",
  accuracy: 1500,
};

describe("1.3.1 Firefox Event Page poll alarm", () => {
  test("intervalSec 2/3/5/10 convert to periodInMinutes", () => {
    assert.equal(intervalSecToPeriodMinutes(2), 2 / 60);
    assert.equal(intervalSecToPeriodMinutes(3), 0.05);
    assert.equal(intervalSecToPeriodMinutes(5), 5 / 60);
    assert.equal(intervalSecToPeriodMinutes(10), 10 / 60);
    assert.equal(firefoxPollAlarmInfo(3).periodInMinutes, 0.05);
  });

  test("invalid interval falls back to default 3s = 0.05 min", () => {
    assert.equal(intervalSecToPeriodMinutes(0), 0.05);
    assert.equal(intervalSecToPeriodMinutes(-1), 0.05);
    assert.equal(intervalSecToPeriodMinutes(Number.NaN), 0.05);
  });

  test("Firefox load / poll / activate do not immediate-Echo; installed/startup/settings do", () => {
    const fx = { offscreenAvailable: false };
    assert.equal(shouldImmediateEcho("load", fx), false);
    assert.equal(shouldImmediateEcho("poll", fx), false);
    assert.equal(shouldImmediateEcho("activate", fx), false);
    assert.equal(shouldImmediateEcho("installed", fx), true);
    assert.equal(shouldImmediateEcho("startup", fx), true);
    assert.equal(shouldImmediateEcho("settings", fx), true);
  });

  test("Chromium still immediate-Echo on load/installed/startup/activate/settings", () => {
    const cr = { offscreenAvailable: true };
    for (const reason of ["load", "installed", "startup", "activate", "settings"]) {
      assert.equal(shouldImmediateEcho(reason, cr), true, reason);
    }
    assert.equal(shouldImmediateEcho("poll", cr), false);
  });

  test("plan: missing alarm after session restart is created, never setTimeout fallback", () => {
    const plan = planFirefoxPolling({
      enabled: true,
      offscreenAvailable: false,
      existingAlarm: undefined,
      intervalSec: 3,
    });
    assert.equal(plan.action, "create");
    assert.equal(plan.info.periodInMinutes, 0.05);
    assert.equal(plan.startSwFallback, false);
  });

  test("plan: same period keeps alarm (does not reset timer)", () => {
    const existing = { name: ALARM_FIREFOX_POLL, periodInMinutes: 0.05 };
    const plan = planFirefoxPolling({
      enabled: true,
      offscreenAvailable: false,
      existingAlarm: existing,
      intervalSec: 3,
    });
    assert.equal(plan.action, "keep");
    assert.equal(plan.startSwFallback, false);
    assert.equal(firefoxPollAlarmNeedsUpdate(existing, 3), false);
  });

  test("plan: intervalSec change rebuilds alarm", () => {
    const existing = { name: ALARM_FIREFOX_POLL, periodInMinutes: 0.05 };
    const plan = planFirefoxPolling({
      enabled: true,
      offscreenAvailable: false,
      existingAlarm: existing,
      intervalSec: 5,
    });
    assert.equal(plan.action, "create");
    assert.equal(plan.info.periodInMinutes, 5 / 60);
  });

  test("plan: enabled=false and Chromium offscreen both clear Firefox poll alarm", () => {
    assert.equal(
      planFirefoxPolling({
        enabled: false,
        offscreenAvailable: false,
        existingAlarm: { periodInMinutes: 0.05 },
        intervalSec: 3,
      }).action,
      "clear",
    );
    assert.equal(
      planFirefoxPolling({
        enabled: true,
        offscreenAvailable: true,
        existingAlarm: { periodInMinutes: 0.05 },
        intervalSec: 3,
      }).action,
      "clear",
    );
  });

  test("Event Page idle: load hydrates without Echo; later alarm fires one Echo each", () => {
    const session = createEventPageSession();
    session.onLoad();
    assert.equal(session.echoes.length, 0);
    assert.equal(session.hydrates, 1);
    assert.ok(session.alarm);
    session.onPollAlarm();
    session.onPollAlarm();
    session.onPollAlarm();
    assert.equal(session.echoes.length, 3);
    assert.deepEqual(session.echoes, ["poll", "poll", "poll"]);
    assert.equal(echoesForAlarmFires(3), 3);
  });

  test("browser startup clears persisted alarms and recreates pls-firefox-poll", () => {
    const session = createEventPageSession();
    session.onLoad();
    session.dropAlarms();
    assert.equal(session.alarm, null);
    session.onStartup();
    assert.ok(session.alarm);
    assert.equal(session.alarm.periodInMinutes, 0.05);
    assert.deepEqual(session.echoes, ["startup"]);
  });

  test("enabled=false clears poll alarm; Event Page load still does not Echo", () => {
    const session = createEventPageSession();
    session.onLoad();
    session.setEnabled(false);
    assert.equal(session.alarm, null);
    session.onLoad();
    assert.equal(session.echoes.length, 0);
  });
});

describe("1.3.1 Firefox poll vs pipeline: same-IP zero storage; slow Geo does not block next Echo", () => {
  test("same-IP alarm Echoes are heartbeats with zero persist", async () => {
    const persistCalls = [];
    const pipeline = createExitPipeline({
      lookupGeo: async (ip) => ({ ...TOKYO, ip }),
      persist: async (payload) => {
        persistCalls.push(payload);
      },
      probeWebrtc: async () => {},
    });
    await pipeline.onEcho({ ip: TOKYO.ip, provider: "t", reason: "poll" });
    if (pipeline.snapshot().state && pipeline.snapshot().state.geoStatus !== "ready") {
      await new Promise((r) => setTimeout(r, 20));
    }
    persistCalls.length = 0;
    pipeline.stats.storageSets = 0;
    const first = await pipeline.onEcho({ ip: TOKYO.ip, provider: "t", reason: "poll" });
    const second = await pipeline.onEcho({ ip: TOKYO.ip, provider: "t", reason: "poll" });
    assert.equal(first.heartbeat, true);
    assert.equal(second.heartbeat, true);
    assert.equal(persistCalls.length, 0);
    assert.equal(pipeline.stats.storageSets, 0);
  });

  test("slow Geo from alarm 1 does not block alarm 2 Echo ACK", async () => {
    let geoStarted = 0;
    let geoFinished = 0;
    const pipeline = createExitPipeline({
      lookupGeo: async (ip) => {
        geoStarted += 1;
        await new Promise((r) => setTimeout(r, 60));
        geoFinished += 1;
        return { ...TOKYO, ip };
      },
      persist: async () => {},
      probeWebrtc: async () => {},
    });
    const ackAt = [];
    const a = pipeline.onEcho({ ip: "203.0.113.10", provider: "t", reason: "poll" }).then((r) => {
      ackAt.push(Date.now());
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = pipeline.onEcho({ ip: "198.51.100.20", provider: "t", reason: "poll" }).then((r) => {
      ackAt.push(Date.now());
      return r;
    });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ack, true);
    assert.equal(rb.ack, true);
    assert.equal(ackAt.length, 2);
    assert.ok(ackAt[1] - ackAt[0] < 50, `second Echo waited on Geo: ${ackAt[1] - ackAt[0]}ms`);
    assert.ok(geoFinished < 2 || geoStarted === 2);
  });
});

function createEventPageSession() {
  let enabled = true;
  let alarm = null;
  const echoes = [];
  let hydrates = 0;
  const offscreenAvailable = false;

  function applyPlan() {
    const plan = planFirefoxPolling({
      enabled,
      offscreenAvailable,
      existingAlarm: alarm,
      intervalSec: 3,
    });
    if (plan.action === "clear") alarm = null;
    if (plan.action === "create") alarm = { name: ALARM_FIREFOX_POLL, ...plan.info };
  }

  return {
    get alarm() {
      return alarm;
    },
    get echoes() {
      return echoes.slice();
    },
    get hydrates() {
      return hydrates;
    },
    onLoad() {
      hydrates += 1;
      applyPlan();
      if (shouldImmediateEcho("load", { offscreenAvailable })) echoes.push("load");
    },
    onPollAlarm() {
      hydrates += 1;
      if (!enabled) {
        alarm = null;
        return;
      }
      applyPlan();
      echoes.push("poll");
    },
    onStartup() {
      alarm = null;
      hydrates += 1;
      applyPlan();
      if (shouldImmediateEcho("startup", { offscreenAvailable })) echoes.push("startup");
    },
    dropAlarms() {
      alarm = null;
    },
    setEnabled(next) {
      enabled = next;
      applyPlan();
    },
  };
}
