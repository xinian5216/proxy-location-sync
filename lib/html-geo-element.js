/**
 * Chrome 144+ <geolocation> / HTMLGeolocationElement。
 * 内部走 Chromium GeolocationService，不一定经过 JS 的 Geolocation.prototype。
 * 能 patch 的：prototype/instance 的 position/error getter。
 * 不能伪造的：location 事件的 isTrusted。
 */

export function elementPositionForMode(mode, virtualPosition, opts = {}) {
  const permission = opts.permission || "granted";
  const valid = opts.valid !== false;
  if (permission !== "granted") return null;
  if (!valid) return null;
  if (mode === "ready") return virtualPosition || null;
  return null;
}

export function elementErrorForMode(mode, makeError, opts = {}) {
  const permission = opts.permission || "granted";
  if (permission === "denied" && typeof makeError === "function") {
    return makeError(1, "User denied Geolocation");
  }
  if (mode === "error" && permission === "granted" && typeof makeError === "function") {
    return makeError(2, "Position unavailable");
  }
  return null;
}

export function shouldDispatchLocation(el, rec) {
  if (!el || !rec) return false;
  if (el.watch) return true;
  if (rec.oneShotDone) return false;
  return !!(el.autolocate || rec.activated);
}

export function patchHtmlGeolocationPrototype({
  proto,
  getMode,
  getVirtualPosition,
  makeError,
}) {
  if (!proto) return { ok: false, reason: "no prototype" };
  const posDesc = Object.getOwnPropertyDescriptor(proto, "position");
  const errDesc = Object.getOwnPropertyDescriptor(proto, "error");
  try {
    Object.defineProperty(proto, "position", {
      configurable: true,
      enumerable: !posDesc || posDesc.enumerable !== false,
      get() {
        const mode = getMode();
        const virtual = elementPositionForMode(mode, getVirtualPosition());
        if (virtual) return virtual;
        if (mode === "pending" || mode === "error") return null;
        return posDesc && typeof posDesc.get === "function" ? posDesc.get.call(this) : null;
      },
    });
    Object.defineProperty(proto, "error", {
      configurable: true,
      enumerable: !errDesc || errDesc.enumerable !== false,
      get() {
        const mode = getMode();
        const spoofed = elementErrorForMode(mode, makeError);
        if (spoofed) return spoofed;
        if (mode === "ready" || mode === "pending") return null;
        return errDesc && typeof errDesc.get === "function" ? errDesc.get.call(this) : null;
      },
    });
    return { ok: true, reason: "prototype getters" };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

export function failClosedGeolocationElement(el) {
  if (!el) return false;
  try {
    el.autolocate = false;
  } catch {
    /* ignore */
  }
  try {
    el.watch = false;
  } catch {
    /* ignore */
  }
  try {
    Object.defineProperty(el, "position", {
      configurable: true,
      get() {
        return null;
      },
    });
    Object.defineProperty(el, "error", {
      configurable: true,
      get() {
        return null;
      },
    });
    return true;
  } catch {
    try {
      if (typeof el.remove === "function") el.remove();
    } catch {
      /* ignore */
    }
    return false;
  }
}
