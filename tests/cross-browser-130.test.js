import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { parseDateString } from "../lib/timezone.js";
import { badgeCountryCode } from "../lib/badge.js";
import { classifyWebRtc } from "../lib/webrtc.js";
import { probeExtensionWorker } from "../lib/worker-probe.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const version = JSON.parse(read("package.json")).version;

function mergeManifest(base, overlay) {
  return { ...base, ...overlay };
}

function loadManifest(target) {
  const base = JSON.parse(read("manifests/base.json"));
  const overlay = JSON.parse(read(`manifests/${target}.json`));
  const merged = mergeManifest(base, overlay);
  merged.version = version;
  return merged;
}

describe("1.3.0 Chromium vs Firefox manifests", () => {
  test("shared base has MAIN + ISOLATED, match_origin_as_fallback, no background/permissions", () => {
    const base = JSON.parse(read("manifests/base.json"));
    assert.equal(base.manifest_version, 3);
    assert.equal(base.background, undefined);
    assert.equal(base.permissions, undefined);
    assert.equal(base.content_scripts.length, 2);
    const worlds = base.content_scripts.map((c) => c.world).sort();
    assert.deepEqual(worlds, ["ISOLATED", "MAIN"]);
    for (const c of base.content_scripts) {
      assert.equal(c.all_frames, true);
      assert.equal(c.match_about_blank, true);
      assert.equal(c.match_origin_as_fallback, true);
      assert.equal(c.run_at, "document_start");
    }
  });

  test("Chromium overlay keeps SW + offscreen; must not include background.scripts (Chrome 116–120)", () => {
    const m = loadManifest("chromium");
    assert.equal(m.version, version);
    assert.equal(m.minimum_chrome_version, "116");
    assert.equal(m.background.service_worker, "background/service-worker.js");
    assert.equal(m.background.type, "module");
    assert.equal(m.background.scripts, undefined);
    assert.ok(m.permissions.includes("offscreen"));
    assert.equal(m.browser_specific_settings, undefined);
  });

  test("Firefox overlay is event page, gecko id, min 128, no offscreen permission", () => {
    const m = loadManifest("firefox");
    assert.equal(m.version, version);
    assert.deepEqual(m.background.scripts, ["background/service-worker.js"]);
    assert.equal(m.background.persistent, false);
    assert.equal(m.background.type, "module");
    assert.equal(m.background.service_worker, undefined);
    assert.ok(!m.permissions.includes("offscreen"));
    assert.deepEqual(m.permissions.sort(), ["alarms", "scripting", "storage", "webNavigation"]);
    assert.equal(m.browser_specific_settings.gecko.id, "proxy-location-sync@xinian5216");
    assert.equal(m.browser_specific_settings.gecko.strict_min_version, "128.0");
    assert.equal(m.minimum_chrome_version, undefined);
  });

  test("mergeManifest is shallow overlay; Chrome 116 cannot ship both scripts and service_worker", () => {
    const merged = mergeManifest(
      { name: "x", version: "0" },
      { background: { scripts: ["a.js"] }, permissions: ["storage"] },
    );
    assert.deepEqual(merged.background, { scripts: ["a.js"] });
    const chromium = loadManifest("chromium");
    const firefox = loadManifest("firefox");
    assert.ok(chromium.background.service_worker);
    assert.ok(!chromium.background.scripts);
    assert.ok(firefox.background.scripts);
    assert.ok(!firefox.background.service_worker);
  });
});

describe("1.3.0 Date.parse follows this engine's native parser", () => {
  test("explicit TZ strings equal Date.parse, not a Chromium-only EST table", () => {
    const samples = [
      "Jan 1 2026 00:00 EST",
      "Jan 1 2026 00:00 EDT",
      "Jan 1 2026 00:00 PST",
      "Jan 1 2026 00:00 PDT",
      "2026-01-15T12:00:00Z",
      "January 1, 2026 00:00:00 GMT",
    ];
    for (const s of samples) {
      assert.equal(parseDateString("Asia/Tokyo", s), Date.parse(s), s);
    }
  });

  test("explicit-zone path is native Date.parse; no Chromium EST epoch table in timezone.js", () => {
    const src = read("lib/timezone.js");
    const injected = read("content/injected.js");
    assert.match(src, /if \(hasExplicitTimeZone\(s\)\) return Date\.parse\(s\)/);
    assert.match(injected, /if \(hasExplicitZone\(s\)\) return native\.Date\.parse\(s\)/);
    assert.doesNotMatch(src, /1767243600000/);
    assert.doesNotMatch(injected, /1767243600000/);
    const samples = ["Jan 1 2026 00:00 EST", "Jan 1 2026 00:00 PDT", "2026-01-15T12:00:00Z"];
    for (const s of samples) {
      assert.equal(parseDateString("Asia/Tokyo", s), Date.parse(s), s);
    }
  });

  test("naive ISO still uses virtual timezone wall time", () => {
    const ms = parseDateString("Asia/Tokyo", "2026-01-15T12:00:00");
    assert.equal(ms, Date.UTC(2026, 0, 15, 3, 0, 0, 0));
  });
});

describe("1.3.0 badge / WebRTC / Worker stay fail-closed across adapters", () => {
  test("badge still two-letter uppercase; empty/disabled clear", () => {
    assert.equal(badgeCountryCode({ countryCode: "jp" }, true), "JP");
    assert.equal(badgeCountryCode({ countryCode: "US" }, false), "");
    assert.equal(badgeCountryCode(null, true), "");
  });

  test("WebRTC with no ICE is unknown, not ok", () => {
    const r = classifyWebRtc({
      localIps: [],
      publicIps: [],
      mdns: false,
      currentExitIp: "1.1.1.1",
      hadError: false,
    });
    assert.equal(r.status, "unknown");
  });

  test("packaged Worker probe failure is {ok:false}, never throws", async () => {
    const result = await probeExtensionWorker({ Worker: undefined, workerUrl: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "Worker unavailable");
  });
});

describe("1.3.0 iframe / MAIN inject source contract", () => {
  test("webNavigation injectBootstrap uses world MAIN for empty-iframe gap", () => {
    const sw = read("background/service-worker.js");
    assert.match(sw, /webNavigation\.onCommitted/);
    assert.match(sw, /injectBootstrap/);
    assert.match(sw, /world:\s*"MAIN"/);
    assert.match(sw, /injectImmediately:\s*true/);
  });

  test("README documents Firefox empty about:blank document_start gap", () => {
    const readme = read("README.md");
    assert.match(readme, /document_start/);
    assert.match(readme, /about:blank/);
    assert.match(readme, /Firefox/);
  });
});
