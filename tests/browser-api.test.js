import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canCreateDedicatedWorker,
  detectPlatform,
  hasBadgeTextColor,
  hasHtmlGeolocationElement,
  isServiceWorkerScope,
  resolveExtApi,
  shouldUseOffscreen,
} from "../lib/browser-api.js";

describe("1.3.0 browser-api adapter", () => {
  test("prefers browser.* when runtime exists (Firefox / Chrome 148+)", () => {
    const browser = { runtime: { id: "gecko" }, storage: {} };
    const chrome = { runtime: { id: "chrome" } };
    assert.equal(resolveExtApi({ browser, chrome }), browser);
  });

  test("falls back to chrome.* when browser.runtime is missing", () => {
    const chrome = { runtime: { id: "chrome" }, offscreen: { createDocument() {} } };
    assert.equal(resolveExtApi({ chrome }), chrome);
    assert.equal(resolveExtApi({ browser: { storage: {} }, chrome }), chrome);
  });

  test("detectPlatform uses getBrowserInfo then UA", () => {
    assert.equal(
      detectPlatform({ navigator: { userAgent: "Mozilla/5.0" } }, { runtime: { getBrowserInfo() {} } }),
      "firefox",
    );
    assert.equal(detectPlatform({ navigator: { userAgent: "Mozilla/5.0 Firefox/128.0" } }, {}), "firefox");
    assert.equal(detectPlatform({ navigator: { userAgent: "Mozilla/5.0 Chrome/120.0" } }, { runtime: {} }), "chromium");
  });

  test("shouldUseOffscreen is a function-presence check, not a UA guess", () => {
    assert.equal(shouldUseOffscreen({ offscreen: { createDocument() {} } }), true);
    assert.equal(shouldUseOffscreen({ offscreen: {} }), false);
    assert.equal(shouldUseOffscreen({}), false);
    assert.equal(shouldUseOffscreen(null), false);
  });

  test("Worker / HTMLGeolocationElement / badge text color / SW scope are feature-detected", () => {
    assert.equal(canCreateDedicatedWorker({ Worker: class {} }), true);
    assert.equal(canCreateDedicatedWorker({}), false);
    assert.equal(hasHtmlGeolocationElement({ HTMLGeolocationElement: class {} }), true);
    assert.equal(hasHtmlGeolocationElement({}), false);
    assert.equal(hasBadgeTextColor({ action: { setBadgeTextColor() {} } }), true);
    assert.equal(hasBadgeTextColor({ action: { setBadgeText() {} } }), false);
    assert.equal(isServiceWorkerScope({}), false);
  });
});
