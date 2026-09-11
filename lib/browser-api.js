/**
 * 统一 Promise 风格 WebExtension API。
 * Firefox 用 browser.*；Chromium 116–147 用 chrome.*（MV3 已返回 Promise）；
 * Chrome 148+ 也有 browser.*。业务代码不要混用两套命名空间。
 *
 * 2026 MDN：Firefox 仍不支持 background.service_worker（bug 1573659），
 * 也没有 chrome.offscreen。MAIN world / match_origin_as_fallback 自 Firefox 128。
 */

export function resolveExtApi(globals = globalThis) {
  const b = globals.browser;
  const c = globals.chrome;
  if (b && b.runtime) return b;
  if (c && c.runtime) return c;
  return b || c || null;
}

export const ext = resolveExtApi();

export function detectPlatform(globals = globalThis, api = resolveExtApi(globals)) {
  try {
    if (api && typeof api.runtime.getBrowserInfo === "function") return "firefox";
  } catch {
    /* ignore */
  }
  const ua = (globals.navigator && globals.navigator.userAgent) || "";
  if (/Firefox\//i.test(ua) || /Fennec\//i.test(ua)) return "firefox";
  return "chromium";
}

export function shouldUseOffscreen(api = ext) {
  return !!(api && api.offscreen && typeof api.offscreen.createDocument === "function");
}

export function canCreateDedicatedWorker(globals = globalThis) {
  return typeof globals.Worker === "function";
}

export function hasHtmlGeolocationElement(globals = globalThis) {
  return typeof globals.HTMLGeolocationElement === "function";
}

export function hasBadgeTextColor(api = ext) {
  return !!(api && api.action && typeof api.action.setBadgeTextColor === "function");
}

export function isServiceWorkerScope(globals = globalThis) {
  try {
    return typeof globals.ServiceWorkerGlobalScope !== "undefined" && globals instanceof globals.ServiceWorkerGlobalScope;
  } catch {
    return false;
  }
}
