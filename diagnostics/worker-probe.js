/**
 * Packaged Dedicated Worker for environment diagnostics.
 * Loaded from offscreen / diagnostics page via chrome-extension URL.
 * Never used as a blob: URL on a target webpage (CSP worker-src).
 */
self.onmessage = function () {
  try {
    var timezone = "";
    var offsetMin = Number.NaN;
    var language = "";
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e1) {
      /* ignore */
    }
    try {
      offsetMin = new Date().getTimezoneOffset();
    } catch (e2) {
      /* ignore */
    }
    try {
      language = (self.navigator && self.navigator.language) || "";
    } catch (e3) {
      /* ignore */
    }
    self.postMessage({
      ok: true,
      timezone: timezone,
      offsetMin: offsetMin,
      language: language,
    });
  } catch (err) {
    self.postMessage({
      ok: false,
      reason: String(err && err.message ? err.message : err),
    });
  }
};
