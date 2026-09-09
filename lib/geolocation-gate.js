/**
 * Geolocation 状态机。
 *
 * disabled → 包装后的原生（logical watch ID 仍由本控制器持有）
 * pending  → 排队，绝不把原生坐标交给页面
 * ready    → 虚拟代理位置
 * error    → POSITION_UNAVAILABLE（新出口地理失败，不假装旧坐标是当前定位）
 *
 * 权限：granted/denied 走 permissions.query；仅 prompt 才调用原生定位弹出授权框。
 */

export function makePositionError(code, message) {
  const err = new Error(message);
  err.name = "GeolocationPositionError";
  err.code = code;
  err.message = message;
  err.PERMISSION_DENIED = 1;
  err.POSITION_UNAVAILABLE = 2;
  err.TIMEOUT = 3;
  try {
    if (typeof GeolocationPositionError === "function") {
      Object.setPrototypeOf(err, GeolocationPositionError.prototype);
    }
  } catch {
    /* ignore */
  }
  return err;
}

export function attachPositionPrototypes(pos, coords) {
  try {
    if (typeof GeolocationCoordinates === "function") {
      Object.setPrototypeOf(coords, GeolocationCoordinates.prototype);
    }
  } catch {
    /* own properties still win */
  }
  try {
    if (typeof GeolocationPosition === "function") {
      Object.setPrototypeOf(pos, GeolocationPosition.prototype);
    }
  } catch {
    /* own properties still win */
  }
  return pos;
}

export function createGeolocationController({
  getMode,
  getCoords,
  native,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancelSchedule = (id) => clearTimeout(id),
}) {
  const watchers = new Map();
  const pendingGets = new Set();
  let watchSeq = 1;
  let lastKey = "";
  let permStatus = null;
  let permHooked = false;

  function hookPermissionStatus(st) {
    if (!st) return st;
    permStatus = st;
    if (permHooked) return st;
    permHooked = true;
    const onChange = () => {
      if (st.state === "denied") revokeVirtualWatchers();
    };
    if (typeof st.addEventListener === "function") st.addEventListener("change", onChange);
    else st.onchange = onChange;
    return st;
  }

  function revokeVirtualWatchers() {
    const err = makePositionError(1, "User denied Geolocation");
    for (const [id, rec] of [...watchers]) {
      if (rec.nativeWatchId != null) continue;
      watchers.delete(id);
      if (typeof rec.error === "function") {
        try {
          rec.error(err);
        } catch {
          /* keep others */
        }
      }
    }
  }

  function coordsAvailable() {
    const c = getCoords();
    return !!(c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
  }

  function buildPosition() {
    const c = getCoords();
    const coords = {
      latitude: c.latitude,
      longitude: c.longitude,
      altitude: null,
      accuracy: Number(c.accuracy) || 1500,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON() {
        return {
          latitude: this.latitude,
          longitude: this.longitude,
          altitude: this.altitude,
          accuracy: this.accuracy,
          altitudeAccuracy: this.altitudeAccuracy,
          heading: this.heading,
          speed: this.speed,
        };
      },
    };
    const pos = {
      coords,
      timestamp: now(),
      toJSON() {
        return { coords: this.coords.toJSON(), timestamp: this.timestamp };
      },
    };
    return attachPositionPrototypes(pos, coords);
  }

  function locationKey() {
    const c = getCoords();
    if (!c) return "";
    return [c.ip, c.latitude, c.longitude, c.accuracy].join("|");
  }

  function deliverVirtual(success, error) {
    try {
      success(buildPosition());
    } catch (err) {
      if (typeof error === "function") error(err);
    }
  }

  function handleAfterPermission(success, error, options) {
    const mode = getMode();
    if (mode === "disabled") {
      wrapNativeGet(success, error, options);
      return;
    }
    if (mode === "error") {
      if (typeof error === "function") error(makePositionError(2, "Position unavailable"));
      return;
    }
    if (mode === "ready" && coordsAvailable()) {
      schedule(() => {
        if (getMode() === "ready" && coordsAvailable()) deliverVirtual(success, error);
        else handleAfterPermission(success, error, options);
      }, 0);
      return;
    }
    enqueueGet(success, error, options);
  }

  function wrapNativeGet(success, error, options) {
    if (!native || typeof native.getCurrentPosition !== "function") {
      if (typeof error === "function") error(makePositionError(2, "Geolocation unavailable"));
      return;
    }
    native.getCurrentPosition(
      function onNativeOk(realPos) {
        const mode = getMode();
        if (mode === "disabled") {
          success(realPos);
          return;
        }
        void realPos;
        handleAfterPermission(success, error, options);
      },
      function onNativeErr(err) {
        if (getMode() === "disabled") {
          if (typeof error === "function") error(err);
          return;
        }
        const code = err && err.code;
        if (typeof error === "function") {
          error(makePositionError(code || 2, (err && err.message) || "Position unavailable"));
        }
      },
      options,
    );
  }

  function nativeGate(error, deliver) {
    if (!native || typeof native.getCurrentPosition !== "function") {
      if (typeof error === "function") error(makePositionError(2, "Geolocation unavailable"));
      return;
    }
    native.getCurrentPosition(
      function onNativeOk(realPos) {
        void realPos;
        deliver();
      },
      function onNativeErr(err) {
        const code = err && err.code;
        if (code === 1) {
          if (typeof error === "function") {
            error(makePositionError(1, (err && err.message) || "User denied Geolocation"));
          }
          return;
        }
        if (typeof error === "function") {
          error(makePositionError(code || 2, (err && err.message) || "Position unavailable"));
        }
      },
      { maximumAge: Infinity, timeout: 15000, enableHighAccuracy: false },
    );
  }

  function withPermission(error, deliver) {
    const apply = (st) => {
      const s = st && st.state;
      if (s === "granted") {
        deliver();
        return;
      }
      if (s === "denied") {
        if (typeof error === "function") error(makePositionError(1, "User denied Geolocation"));
        return;
      }
      nativeGate(error, deliver);
    };
    if (permStatus && permStatus.state) {
      apply(permStatus);
      return;
    }
    if (!native || typeof native.permissionsQuery !== "function") {
      nativeGate(error, deliver);
      return;
    }
    Promise.resolve(native.permissionsQuery({ name: "geolocation" }))
      .then((st) => apply(hookPermissionStatus(st)))
      .catch(() => nativeGate(error, deliver));
  }

  function enqueueGet(success, error, options) {
    const timeout = options && Number(options.timeout);
    const rec = { success, error, options, timer: null, done: false };
    const finish = (fn) => {
      if (rec.done) return;
      rec.done = true;
      if (rec.timer != null) cancelSchedule(rec.timer);
      pendingGets.delete(rec);
      fn();
    };
    if (Number.isFinite(timeout) && timeout <= 0) {
      if (typeof error === "function") error(makePositionError(3, "Timeout expired"));
      return;
    }
    if (Number.isFinite(timeout)) {
      rec.timer = schedule(() => {
        finish(() => {
          if (typeof error === "function") error(makePositionError(3, "Timeout expired"));
        });
      }, timeout);
    }
    rec.deliver = () => {
      finish(() => deliverVirtual(success, error));
    };
    rec.fail = (err) => {
      finish(() => {
        if (typeof error === "function") error(err);
      });
    };
    pendingGets.add(rec);
  }

  function flushPendingGets() {
    if (getMode() === "error") {
      for (const rec of [...pendingGets]) {
        if (typeof rec.fail === "function") rec.fail(makePositionError(2, "Position unavailable"));
      }
      return;
    }
    if (getMode() !== "ready" || !coordsAvailable()) return;
    for (const rec of [...pendingGets]) {
      if (typeof rec.deliver === "function") rec.deliver();
    }
  }

  function notifyWatchers(force) {
    if (getMode() !== "ready" || !coordsAvailable()) return;
    const key = locationKey();
    if (!force && key === lastKey) return;
    lastKey = key;
    const pos = buildPosition();
    for (const rec of watchers.values()) {
      if (rec.nativeWatchId != null) continue;
      if (!rec.gated) continue;
      rec.errorSent = false;
      try {
        rec.success(pos);
      } catch {
        /* keep others */
      }
    }
  }

  function failWatchersOnce() {
    const err = makePositionError(2, "Position unavailable");
    for (const rec of watchers.values()) {
      if (rec.nativeWatchId != null || !rec.gated) continue;
      if (rec.errorSent) continue;
      rec.errorSent = true;
      if (typeof rec.error === "function") {
        try {
          rec.error(err);
        } catch {
          /* keep others */
        }
      }
    }
  }

  function attachNativeWatch(rec) {
    if (!native || typeof native.watchPosition !== "function") return;
    rec.gated = false;
    rec.nativeWatchId = native.watchPosition(
      function onNativeWatch(realPos) {
        if (getMode() === "disabled") rec.success(realPos);
      },
      function onNativeWatchErr(err) {
        if (getMode() === "disabled" && typeof rec.error === "function") rec.error(err);
      },
      rec.options,
    );
  }

  function detachNativeWatch(rec) {
    if (rec.nativeWatchId != null && native && native.clearWatch) {
      native.clearWatch(rec.nativeWatchId);
    }
    rec.nativeWatchId = null;
  }

  function getCurrentPosition(success, error, options) {
    if (typeof success !== "function") return;
    const mode = getMode();
    if (mode === "disabled") {
      wrapNativeGet(success, error, options);
      return;
    }
    withPermission(error, () => handleAfterPermission(success, error, options));
  }

  function watchPosition(success, error, options) {
    if (typeof success !== "function") return -1;
    const id = watchSeq++;
    const rec = { success, error, options, nativeWatchId: null, gated: false, errorSent: false };
    watchers.set(id, rec);

    if (getMode() === "disabled") {
      attachNativeWatch(rec);
      return id;
    }

    withPermission(
      (err) => {
        watchers.delete(id);
        if (typeof error === "function") error(err);
      },
      () => {
        if (!watchers.has(id)) return;
        if (getMode() === "disabled") {
          attachNativeWatch(rec);
          return;
        }
        rec.gated = true;
        if (getMode() === "error") {
          failWatchersOnce();
          return;
        }
        if (getMode() === "ready" && coordsAvailable()) {
          lastKey = locationKey();
          schedule(() => {
            if (!watchers.has(id) || getMode() !== "ready") return;
            deliverVirtual(success, error);
          }, 0);
        }
      },
    );
    return id;
  }

  function clearWatch(id) {
    const rec = watchers.get(id);
    if (rec) {
      watchers.delete(id);
      detachNativeWatch(rec);
      return;
    }
    if (native && native.clearWatch) native.clearWatch(id);
  }

  function onModeOrCoordsChange() {
    const mode = getMode();
    if (mode === "disabled") {
      for (const rec of watchers.values()) {
        if (rec.nativeWatchId == null) attachNativeWatch(rec);
      }
      for (const rec of [...pendingGets]) {
        pendingGets.delete(rec);
        if (rec.timer != null) cancelSchedule(rec.timer);
        wrapNativeGet(rec.success, rec.error, rec.options);
      }
      return;
    }
    for (const rec of watchers.values()) {
      detachNativeWatch(rec);
      rec.gated = true;
    }
    if (mode === "ready") {
      flushPendingGets();
      notifyWatchers(false);
    } else if (mode === "error") {
      flushPendingGets();
      failWatchersOnce();
    }
  }

  return {
    getCurrentPosition,
    watchPosition,
    clearWatch,
    onModeOrCoordsChange,
    notifyWatchers,
    revokeVirtualWatchers,
    _debug: { watchers, pendingGets },
  };
}

export function installGeolocationPatches({ proto, instance, getCurrentPosition, watchPosition, clearWatch }) {
  const patched = { proto: false, instance: false };
  if (proto) {
    try {
      proto.getCurrentPosition = getCurrentPosition;
      proto.watchPosition = watchPosition;
      proto.clearWatch = clearWatch;
      patched.proto = true;
    } catch {
      try {
        Object.defineProperty(proto, "getCurrentPosition", { configurable: true, writable: true, value: getCurrentPosition });
        Object.defineProperty(proto, "watchPosition", { configurable: true, writable: true, value: watchPosition });
        Object.defineProperty(proto, "clearWatch", { configurable: true, writable: true, value: clearWatch });
        patched.proto = true;
      } catch {
        /* ignore */
      }
    }
  }
  if (instance) {
    try {
      instance.getCurrentPosition = getCurrentPosition;
      instance.watchPosition = watchPosition;
      instance.clearWatch = clearWatch;
      patched.instance = true;
    } catch {
      try {
        Object.defineProperty(instance, "getCurrentPosition", { configurable: true, writable: true, value: getCurrentPosition });
        Object.defineProperty(instance, "watchPosition", { configurable: true, writable: true, value: watchPosition });
        Object.defineProperty(instance, "clearWatch", { configurable: true, writable: true, value: clearWatch });
        patched.instance = true;
      } catch {
        /* ignore */
      }
    }
  }
  return patched;
}
