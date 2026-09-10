import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

describe("source guards (no leak / no fake / no extra perms)", () => {
  const injected = read("content/injected.js");
  const isolated = read("content/isolated.js");
  const options = read("options/options.js");
  const offscreen = read("offscreen/offscreen.js");
  const sw = read("background/service-worker.js");
  const manifest = JSON.parse(read("manifest.json"));
  const constants = read("lib/constants.js");

  const pipeline = read("lib/exit-pipeline.js");
  const timezone = read("lib/timezone.js");

  test("manifest 1.1.4, no tabs permission, min Chrome 116", () => {
    assert.equal(manifest.version, "1.1.4");
    assert.equal(manifest.minimum_chrome_version, "116");
    assert.deepEqual(manifest.permissions.sort(), [
      "alarms",
      "offscreen",
      "scripting",
      "storage",
      "webNavigation",
    ]);
    assert.equal(manifest.optional_permissions, undefined);
    assert.ok(!JSON.stringify(manifest).includes("debugger"));
    assert.ok(!JSON.stringify(manifest).includes("privacy"));
    assert.ok(!manifest.permissions.includes("tabs"));
  });

  test("default locationMode is raw", () => {
    assert.match(constants, /locationMode:\s*"raw"/);
  });

  test("MAIN world is fail-closed pending", () => {
    assert.match(injected, /return "pending"/);
    assert.match(injected, /void realPos/);
    assert.match(injected, /enqueueGet/);
    assert.match(injected, /failPendingGets/);
    assert.match(injected, /function tzReady/);
    assert.match(injected, /geoProto/);
  });

  test("no caller-declared trusted flag; page apply cannot disable", () => {
    assert.doesNotMatch(injected, /trusted\s*===\s*true/);
    assert.doesNotMatch(injected, /payload\.trusted/);
    assert.match(injected, /enabled:\s*true/);
    assert.doesNotMatch(isolated, /trusted:\s*true/);
  });

  test("does not fake permissions.query as granted", () => {
    assert.doesNotMatch(injected, /permissions\.query[\s\S]{0,180}granted/);
    assert.doesNotMatch(injected, /state:\s*"granted"/);
    assert.match(injected, /s === "granted"/);
  });

  test("does not hook Function#toString", () => {
    assert.doesNotMatch(injected, /Function\.prototype\.toString/);
    assert.doesNotMatch(injected, /toString\(\)\s*\{\s*return\s*"function/);
  });

  test("does not wrap Temporal.Now.instant", () => {
    assert.doesNotMatch(injected, /wrapTz\(\s*"instant"/);
    assert.match(injected, /instant\(\)/);
  });

  test("options page uses textContent, not innerHTML", () => {
    assert.doesNotMatch(options, /innerHTML/);
    assert.match(options, /textContent/);
    assert.match(options, /replaceChildren/);
  });

  test("offscreen: no fake RTCPeerConnection keepalive; mutex; abort on stop", () => {
    assert.doesNotMatch(offscreen, /keepalive/);
    assert.match(offscreen, /pollInFlight/);
    assert.match(offscreen, /OFFSCREEN_STOP/);
    assert.match(offscreen, /webrtcSlot/);
    assert.match(offscreen, /sendAck/);
    assert.match(offscreen, /nextPollDelayMs/);
  });

  test("isolated world only bridges storage → CustomEvent", () => {
    assert.doesNotMatch(isolated, /chrome\.tabs\./);
    assert.match(isolated, /CustomEvent/);
  });

  test("service worker uses exit pipeline, lookupGeo(targetIp), tabs.query", () => {
    assert.match(sw, /createExitPipeline/);
    assert.match(sw, /lookupGeo/);
    assert.match(sw, /pipeline\.onEcho/);
    assert.match(sw, /chrome\.tabs\.query/);
    assert.match(sw, /collectTabIds/);
    assert.match(sw, /nextPollDelayMs/);
    assert.doesNotMatch(sw, /STATE_PUSH/);
    assert.doesNotMatch(sw, /tab\.title|favIconUrl/);
  });

  test("ip echo prefers api64; timezone uses Intl not slash heuristic", () => {
    const ip = read("lib/ip-providers.js");
    const geo = read("lib/geo-providers.js");
    assert.match(ip, /api64\.ipify\.org/);
    assert.match(geo, /isValidTimeZone/);
    assert.doesNotMatch(geo, /timezone\.includes\("\/"\)/);
  });

  test("1.1.4 generation / native error helper / EST abbreviations present", () => {
    assert.match(pipeline, /exitGeneration/);
    assert.match(pipeline, /myGeneration/);
    assert.match(injected, /nativeHtmlGeoErrorDescriptor/);
    assert.match(injected, /htmlGeoErrorValue/);
    assert.match(injected, /readNativeHtmlGeoError/);
    assert.doesNotMatch(injected, /isValid === false\) return el\.error/);
    assert.match(injected, /EST\|EDT\|CST\|CDT\|MST\|MDT\|PST\|PDT/);
    assert.match(timezone, /EST\|EDT\|CST\|CDT\|MST\|MDT\|PST\|PDT/);
  });
});
