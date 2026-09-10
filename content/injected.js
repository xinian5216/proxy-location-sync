/**
 * MAIN world。默认 fail-closed：尚无虚拟坐标时视为 pending，
 * 绝不把原生 geolocation 成功回调交给页面。
 *
 * 页面 JS 能读写的任何 globalThis / CustomEvent / __PLS_BOOTSTRAP__
 * 都不是「允许返回真实定位」的授权。没有 trusted 布尔。
 * apply 忽略 settings.enabled=false，也不能清空已有虚拟时区。
 *
 * 用户暂停自动同步：停止检测；已打开页面保持 fail-closed 虚拟状态。
 * 要恢复系统定位，需在 chrome://extensions 关闭本扩展（或刷新且内容脚本不再注入）。
 * 不伪装 Function#toString。不修改 navigator.language。
 */
(function proxyLocationSyncMainWorld() {
  "use strict";

  const EVENT = "__pls_v1";
  const native = {
    getCurrentPosition: navigator.geolocation && navigator.geolocation.getCurrentPosition.bind(navigator.geolocation),
    watchPosition: navigator.geolocation && navigator.geolocation.watchPosition.bind(navigator.geolocation),
    clearWatch: navigator.geolocation && navigator.geolocation.clearWatch.bind(navigator.geolocation),
    permissionsQuery: navigator.permissions && navigator.permissions.query.bind(navigator.permissions),
    Date: Date,
    DTF: Intl.DateTimeFormat,
    createElement: document.createElement && document.createElement.bind(document),
  };
  const geoProto = (typeof Geolocation === "function" && Geolocation.prototype) ||
    (navigator.geolocation && Object.getPrototypeOf(navigator.geolocation));
  if (geoProto) {
    try {
      if (typeof geoProto.getCurrentPosition === "function") {
        native.getCurrentPosition = geoProto.getCurrentPosition.bind(navigator.geolocation);
      }
      if (typeof geoProto.watchPosition === "function") {
        native.watchPosition = geoProto.watchPosition.bind(navigator.geolocation);
      }
      if (typeof geoProto.clearWatch === "function") {
        native.clearWatch = geoProto.clearWatch.bind(navigator.geolocation);
      }
    } catch { /* ignore */ }
  }
  const dateProto = Date.prototype;
  const nativeDate = {
    getTime: dateProto.getTime,
    getTimezoneOffset: dateProto.getTimezoneOffset,
    getFullYear: dateProto.getFullYear,
    getMonth: dateProto.getMonth,
    getDate: dateProto.getDate,
    getDay: dateProto.getDay,
    getHours: dateProto.getHours,
    getMinutes: dateProto.getMinutes,
    getSeconds: dateProto.getSeconds,
    getMilliseconds: dateProto.getMilliseconds,
    toString: dateProto.toString,
    toDateString: dateProto.toDateString,
    toTimeString: dateProto.toTimeString,
    toLocaleString: dateProto.toLocaleString,
    toLocaleDateString: dateProto.toLocaleDateString,
    toLocaleTimeString: dateProto.toLocaleTimeString,
    setHours: dateProto.setHours,
    setFullYear: dateProto.setFullYear,
    setMonth: dateProto.setMonth,
    setDate: dateProto.setDate,
    setMinutes: dateProto.setMinutes,
    setSeconds: dateProto.setSeconds,
    setMilliseconds: dateProto.setMilliseconds,
    setTime: dateProto.setTime,
    getYear: dateProto.getYear,
    setYear: dateProto.setYear,
  };

  let settings = { enabled: true };
  let state = null;
  const watchers = new Map();
  const pendingGets = new Set();
  const geoElements = new Map();
  let watchSeq = 1;
  let lastEmittedKey = "";
  let prevMode = "pending";
  let htmlGeoPatched = false;
  let nativeHtmlGeoErrorDescriptor = null;
  let permStatus = null;
  let permHooked = false;

  function switchingExit() {
    if (!state) return false;
    if (state.pendingIp && !state.ip) return true;
    if (state.pendingIp && state.ip && state.pendingIp !== state.ip) return true;
    return false;
  }

  /** MAIN world 永不进入 native disabled。页面伪造 enabled:false 无效。 */
  function geoMode() {
    if (!state) return "pending";
    if (state.echoStale) return state.geoStatus === "error" ? "error" : "pending";
    if (switchingExit()) return state.geoStatus === "error" ? "error" : "pending";
    if (state.geoStatus === "pending") return "pending";
    if (state.geoStatus === "error") return "error";
    if (
      state.ip &&
      Number.isFinite(state.latitude) &&
      Number.isFinite(state.longitude) &&
      (state.geoStatus === "ready" || !state.geoStatus)
    ) {
      return "ready";
    }
    return "pending";
  }

  function ready() {
    return geoMode() === "ready";
  }

  function tzReady() {
    return !!(state && state.timezone);
  }

  function applyPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.settings && typeof payload.settings === "object") {
      const next = Object.assign({}, payload.settings);
      settings = Object.assign({}, settings, next, { enabled: true });
    }
    if (payload.state !== undefined) {
      const incoming = payload.state;
      if (incoming && typeof incoming === "object") {
        const prevTz = state && state.timezone;
        state = incoming;
        if (!(state && state.timezone) && prevTz) {
          state = Object.assign({}, state, { timezone: prevTz });
        }
      }
    }
    const mode = geoMode();
    if (mode !== prevMode) {
      onModeChange(prevMode, mode);
      prevMode = mode;
    } else if (mode === "ready") {
      flushPendingGets();
      notifyWatchersIfChanged();
      notifyGeoElements();
    } else if (mode === "error") {
      failPendingGets();
      failWatchersOnce();
    }
  }

  globalThis.__PLS_APPLY__ = applyPayload;
  if (globalThis.__PLS_BOOTSTRAP__) applyPayload(globalThis.__PLS_BOOTSTRAP__);

  window.addEventListener(EVENT, (ev) => {
    const detail = ev && ev.detail;
    if (detail && detail.type === "STATE") applyPayload(detail);
    if (detail && detail.type === "PROBE") replyPageEnv();
  });

  function isPatchAlive() {
    try {
      if (Intl.DateTimeFormat !== native.DTF) return true;
    } catch { /* ignore */ }
    try {
      if (dateProto.getTimezoneOffset !== nativeDate.getTimezoneOffset) return true;
    } catch { /* ignore */ }
    try {
      const proto = (typeof Geolocation === "function" && Geolocation.prototype) ||
        (navigator.geolocation && Object.getPrototypeOf(navigator.geolocation));
      if (proto && proto.getCurrentPosition && proto.getCurrentPosition !== native.getCurrentPosition) return true;
    } catch { /* ignore */ }
    return false;
  }

  function probeWorker() {
    return new Promise((resolve) => {
      try {
        if (typeof Worker !== "function" || typeof Blob !== "function" || typeof URL === "undefined") {
          resolve({ ok: false, reason: "Worker unavailable" });
          return;
        }
        const src =
          "self.onmessage=function(){try{self.postMessage({ok:true,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,offsetMin:new Date().getTimezoneOffset(),language:navigator.language||\"\"});}catch(e){self.postMessage({ok:false,reason:String(e)});}};";
        const blob = new Blob([src], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        const w = new Worker(url);
        const timer = setTimeout(() => {
          try { w.terminate(); } catch { /* ignore */ }
          try { URL.revokeObjectURL(url); } catch { /* ignore */ }
          resolve({ ok: false, reason: "worker timeout" });
        }, 1500);
        w.onmessage = function (ev) {
          clearTimeout(timer);
          try { w.terminate(); } catch { /* ignore */ }
          try { URL.revokeObjectURL(url); } catch { /* ignore */ }
          resolve(ev && ev.data ? ev.data : { ok: false });
        };
        w.onerror = function () {
          clearTimeout(timer);
          try { w.terminate(); } catch { /* ignore */ }
          try { URL.revokeObjectURL(url); } catch { /* ignore */ }
          resolve({ ok: false, reason: "worker error" });
        };
        w.postMessage("probe");
      } catch (err) {
        resolve({ ok: false, reason: String(err && err.message ? err.message : err) });
      }
    });
  }

  function replyPageEnv() {
    const payload = {
      type: "PAGE_ENV",
      timezone: "",
      offsetMin: Number.NaN,
      locale: "",
      language: navigator.language || "",
      languages: Array.prototype.slice.call(navigator.languages || []),
      geoMode: geoMode(),
      htmlGeo: typeof HTMLGeolocationElement === "function",
      patchAlive: isPatchAlive(),
      latitude: state && state.latitude,
      longitude: state && state.longitude,
    };
    try {
      const opt = Intl.DateTimeFormat().resolvedOptions();
      payload.timezone = opt.timeZone || "";
      payload.locale = opt.locale || "";
    } catch { /* ignore */ }
    try {
      payload.offsetMin = new Date().getTimezoneOffset();
    } catch { /* ignore */ }
    probeWorker().then(function (worker) {
      payload.worker = worker;
      try {
        window.dispatchEvent(new CustomEvent(EVENT, { detail: payload }));
      } catch { /* ignore */ }
    });
  }

  function hookPermissionStatus(st) {
    if (!st || permHooked) {
      permStatus = st || permStatus;
      return permStatus;
    }
    permStatus = st;
    permHooked = true;
    const onChange = () => {
      if (st.state === "denied") revokeVirtualWatchers();
    };
    try {
      if (typeof st.addEventListener === "function") st.addEventListener("change", onChange);
      else st.onchange = onChange;
    } catch { /* ignore */ }
    return st;
  }

  function currentPermissionState() {
    if (permStatus && permStatus.state) return permStatus.state;
    return null;
  }

  function revokeVirtualWatchers() {
    const err = makeError(1, "User denied Geolocation");
    for (const [id, rec] of [...watchers]) {
      watchers.delete(id);
      if (typeof rec.error === "function") {
        try { rec.error(err); } catch { /* keep others */ }
      }
    }
  }

  function makeError(code, message) {
    const err = new Error(message);
    err.name = "GeolocationPositionError";
    err.code = code;
    err.message = message;
    err.PERMISSION_DENIED = 1;
    err.POSITION_UNAVAILABLE = 2;
    err.TIMEOUT = 3;
    try {
      if (typeof GeolocationPositionError === "function") Object.setPrototypeOf(err, GeolocationPositionError.prototype);
    } catch { /* ignore */ }
    return err;
  }

  function buildPosition() {
    const coords = {};
    Object.defineProperties(coords, {
      latitude: { value: state.latitude, enumerable: true, configurable: true },
      longitude: { value: state.longitude, enumerable: true, configurable: true },
      altitude: { value: null, enumerable: true, configurable: true },
      accuracy: { value: Number(state.accuracy) || 1500, enumerable: true, configurable: true },
      altitudeAccuracy: { value: null, enumerable: true, configurable: true },
      heading: { value: null, enumerable: true, configurable: true },
      speed: { value: null, enumerable: true, configurable: true },
      toJSON: {
        value() {
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
        enumerable: false,
      },
    });
    const pos = {};
    Object.defineProperties(pos, {
      coords: { value: coords, enumerable: true, configurable: true },
      timestamp: { value: Date.now(), enumerable: true, configurable: true },
      toJSON: {
        value() {
          return { coords: this.coords.toJSON(), timestamp: this.timestamp };
        },
        enumerable: false,
      },
    });
    try {
      if (typeof GeolocationCoordinates === "function") Object.setPrototypeOf(coords, GeolocationCoordinates.prototype);
    } catch { /* own fields shadow native getters */ }
    try {
      if (typeof GeolocationPosition === "function") Object.setPrototypeOf(pos, GeolocationPosition.prototype);
    } catch { /* own fields shadow native getters */ }
    return pos;
  }

  function locationKey() {
    if (!state) return "";
    return [state.ip, state.latitude, state.longitude, state.accuracy].join("|");
  }

  /**
   * 权限门控：granted/denied 走 permissions.query。
   * 仅 prompt 才调用原生 getCurrentPosition 弹出授权框；真实坐标丢弃。
   */
  function nativeGate(error, deliver) {
    if (!native.getCurrentPosition) {
      if (typeof error === "function") error(makeError(2, "Geolocation unavailable"));
      return;
    }
    native.getCurrentPosition(
      function onNativeOk(realPos) {
        void realPos;
        deliver();
      },
      function onNativeErr(err) {
        const code = err && err.code;
        if (typeof error === "function") error(makeError(code === 1 ? 1 : code || 2, (err && err.message) || "Position unavailable"));
      },
      { maximumAge: Infinity, timeout: 15000, enableHighAccuracy: false },
    );
  }

  function withPermission(error, deliver) {
    const apply = (st) => {
      const s = st && st.state;
      if (s === "granted") deliver();
      else if (s === "denied") {
        if (typeof error === "function") error(makeError(1, "User denied Geolocation"));
      } else nativeGate(error, deliver);
    };
    if (permStatus && permStatus.state) {
      apply(permStatus);
      return;
    }
    if (!native.permissionsQuery) {
      nativeGate(error, deliver);
      return;
    }
    Promise.resolve(native.permissionsQuery({ name: "geolocation" }))
      .then((st) => {
        apply(hookPermissionStatus(st));
      })
      .catch(() => nativeGate(error, deliver));
  }

  function wrapNativeGet(success, error, options) {
    if (!native.getCurrentPosition) {
      if (typeof error === "function") error(makeError(2, "Geolocation unavailable"));
      return;
    }
    native.getCurrentPosition(
      function onNativeOk(realPos) {
        void realPos;
        afterPermission(success, error, options);
      },
      function onNativeErr(err) {
        if (typeof error === "function") error(makeError((err && err.code) || 2, (err && err.message) || "Position unavailable"));
      },
      options,
    );
  }

  function afterPermission(success, error, options) {
    const mode = geoMode();
    if (mode === "error") {
      if (typeof error === "function") error(makeError(2, "Position unavailable"));
      return;
    }
    if (ready()) {
      setTimeout(() => {
        if (geoMode() === "ready") {
          try {
            success(buildPosition());
          } catch (err) {
            if (typeof error === "function") error(err);
          }
        } else afterPermission(success, error, options);
      }, 0);
      return;
    }
    enqueueGet(success, error, options);
  }

  function enqueueGet(success, error, options) {
    const timeout = options && Number(options.timeout);
    const rec = { success, error, options, timer: null, done: false };
    const finish = (fn) => {
      if (rec.done) return;
      rec.done = true;
      if (rec.timer != null) clearTimeout(rec.timer);
      pendingGets.delete(rec);
      fn();
    };
    if (Number.isFinite(timeout) && timeout <= 0) {
      if (typeof error === "function") error(makeError(3, "Timeout expired"));
      return;
    }
    if (Number.isFinite(timeout)) {
      rec.timer = setTimeout(() => {
        finish(() => {
          if (typeof error === "function") error(makeError(3, "Timeout expired"));
        });
      }, timeout);
    }
    rec.deliver = () => {
      finish(() => {
        if (currentPermissionState() === "denied") {
          if (typeof error === "function") error(makeError(1, "User denied Geolocation"));
          return;
        }
        try {
          success(buildPosition());
        } catch (err) {
          if (typeof error === "function") error(err);
        }
      });
    };
    rec.fail = (err) => {
      finish(() => {
        if (typeof error === "function") error(err);
      });
    };
    pendingGets.add(rec);
  }

  function flushPendingGets() {
    if (!ready()) return;
    for (const rec of [...pendingGets]) {
      if (typeof rec.deliver === "function") rec.deliver();
    }
  }

  function failPendingGets() {
    const err = makeError(2, "Position unavailable");
    for (const rec of [...pendingGets]) {
      if (typeof rec.fail === "function") rec.fail(err);
    }
  }

  function notifyWatchersIfChanged() {
    if (!ready() || watchers.size === 0) return;
    if (currentPermissionState() === "denied") return;
    const key = locationKey();
    if (key === lastEmittedKey) return;
    lastEmittedKey = key;
    const pos = buildPosition();
    for (const rec of watchers.values()) {
      if (!rec.gated) continue;
      rec.errorSent = false;
      try {
        rec.success(pos);
      } catch { /* keep others */ }
    }
  }

  function failWatchersOnce() {
    const err = makeError(2, "Position unavailable");
    for (const rec of watchers.values()) {
      if (!rec.gated || rec.errorSent) continue;
      rec.errorSent = true;
      if (typeof rec.error === "function") {
        try { rec.error(err); } catch { /* keep others */ }
      }
    }
  }

  function patchedGetCurrentPosition(success, error, options) {
    if (typeof success !== "function") return;
    withPermission(error, () => afterPermission(success, error, options));
  }

  function patchedWatchPosition(success, error, options) {
    if (typeof success !== "function") return -1;
    const id = watchSeq++;
    const rec = { success, error, options, gated: false, errorSent: false };
    watchers.set(id, rec);
    withPermission(
      (err) => {
        watchers.delete(id);
        if (typeof error === "function") error(err);
      },
      () => {
        if (!watchers.has(id)) return;
        rec.gated = true;
        if (geoMode() === "error") {
          failWatchersOnce();
          return;
        }
        if (ready()) {
          lastEmittedKey = locationKey();
          setTimeout(() => {
            if (!watchers.has(id) || geoMode() !== "ready") return;
            if (currentPermissionState() === "denied") return;
            try {
              success(buildPosition());
            } catch (e) {
              if (typeof error === "function") error(e);
            }
          }, 0);
        }
      },
    );
    return id;
  }

  function patchedClearWatch(id) {
    const rec = watchers.get(id);
    if (rec) {
      watchers.delete(id);
      return;
    }
    if (native.clearWatch) native.clearWatch(id);
  }

  function onModeChange(_prev, next) {
    if (next === "ready") {
      flushPendingGets();
      notifyWatchersIfChanged();
      notifyGeoElements();
    } else if (next === "error") {
      failPendingGets();
      failWatchersOnce();
      notifyGeoElements();
    } else {
      lastEmittedKey = "";
    }
  }

  function assignGeoMethod(obj, name, fn) {
    if (!obj) return false;
    try {
      obj[name] = fn;
      return true;
    } catch {
      try {
        Object.defineProperty(obj, name, { configurable: true, writable: true, value: fn });
        return true;
      } catch {
        return false;
      }
    }
  }

  if (geoProto) {
    assignGeoMethod(geoProto, "getCurrentPosition", patchedGetCurrentPosition);
    assignGeoMethod(geoProto, "watchPosition", patchedWatchPosition);
    assignGeoMethod(geoProto, "clearWatch", patchedClearWatch);
  }
  if (navigator.geolocation) {
    assignGeoMethod(navigator.geolocation, "getCurrentPosition", patchedGetCurrentPosition);
    assignGeoMethod(navigator.geolocation, "watchPosition", patchedWatchPosition);
    assignGeoMethod(navigator.geolocation, "clearWatch", patchedClearWatch);
  }

  /* -------------------------------------------------------------------------- */
  /* Date / Intl                                                                */
  /* -------------------------------------------------------------------------- */

  const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function invalid(date) {
    return Number.isNaN(nativeDate.getTime.call(date));
  }

  function tz() {
    return state && state.timezone;
  }

  function offsetMinutes(date) {
    const dtf = new native.DTF("en-US", {
      timeZone: tz(),
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const map = {};
    for (const p of dtf.formatToParts(date)) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    const asUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
    return Math.round((date.getTime() - asUtc) / 60000);
  }

  function wallTimeToUtcMs(y, monthIndex, d, h, min, s, ms) {
    const overflow = new native.Date(Date.UTC(y, monthIndex, d, h, min, s, ms));
    const yy = overflow.getUTCFullYear();
    const mo = overflow.getUTCMonth();
    const dd = overflow.getUTCDate();
    const hh = overflow.getUTCHours();
    const mi = overflow.getUTCMinutes();
    const ss = overflow.getUTCSeconds();
    const mss = overflow.getUTCMilliseconds();
    const utcGuess = Date.UTC(yy, mo, dd, hh, mi, ss, mss);
    const oEarly = offsetMinutes(new native.Date(utcGuess - 24 * 3600000));
    const oLate = offsetMinutes(new native.Date(utcGuess + 24 * 3600000));
    const tEarly = utcGuess + oEarly * 60000;
    const tLate = utcGuess + oLate * 60000;
    const matchEarly = wallMatches(tEarly, yy, mo, dd, hh, mi, ss);
    const matchLate = wallMatches(tLate, yy, mo, dd, hh, mi, ss);
    if (matchEarly && matchLate) return Math.min(tEarly, tLate);
    if (matchEarly) return tEarly;
    if (matchLate) return tLate;
    return Math.max(tEarly, tLate);
  }

  function wallMatches(epochMs, y, monthIndex, d, h, min, s) {
    const p = tzParts(new native.Date(epochMs));
    return (
      p.year === y &&
      p.month === monthIndex + 1 &&
      p.day === d &&
      p.hour === h &&
      p.minute === min &&
      p.second === s
    );
  }

  function tzParts(date) {
    const dtf = new native.DTF("en-US", {
      timeZone: tz(),
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      timeZoneName: "long",
    });
    const map = {};
    for (const p of dtf.formatToParts(date)) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    const offsetMin = offsetMinutes(date);
    return {
      weekday: map.weekday,
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
      second: Number(map.second),
      timeZoneName: map.timeZoneName || tz(),
      offsetMin,
      gmt: formatGmt(offsetMin),
    };
  }

  function formatGmt(offsetMin) {
    const sign = offsetMin <= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const h = String(Math.floor(abs / 60)).padStart(2, "0");
    const m = String(abs % 60).padStart(2, "0");
    return `GMT${sign}${h}${m}`;
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function formatToString(date) {
    if (invalid(date)) return "Invalid Date";
    const p = tzParts(date);
    const wd = p.weekday || WEEKDAY[date.getUTCDay()];
    const mon = MONTHS[p.month - 1];
    return `${wd} ${mon} ${pad(p.day)} ${p.year} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${p.gmt} (${p.timeZoneName})`;
  }

  function mergeTz(options) {
    if (options && options.timeZone) return options;
    const next = options ? Object.assign({}, options) : {};
    next.timeZone = tz();
    return next;
  }

  function hasExplicitZone(s) {
    const t = String(s).trim().replace(/\s+\([^)]*\)$/, "");
    if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(t)) return true;
    if (/\b(?:GMT|UTC)\b/i.test(t)) return true;
    if (/\b(?:EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/i.test(t)) return true;
    return false;
  }

  function parseDateString(str) {
    const s = String(str).trim();
    if (hasExplicitZone(s)) return native.Date.parse(s);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
    if (m) {
      if (m[4] == null && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return Date.UTC(+m[1], +m[2] - 1, +m[3]);
      }
      const frac = m[7] ? Number(String(m[7]).padEnd(3, "0").slice(0, 3)) : 0;
      return wallTimeToUtcMs(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), frac);
    }
    const nativeMs = native.Date.parse(s);
    if (Number.isNaN(nativeMs)) return nativeMs;
    const d = new native.Date(nativeMs);
    return wallTimeToUtcMs(
      nativeDate.getFullYear.call(d),
      nativeDate.getMonth.call(d),
      nativeDate.getDate.call(d),
      nativeDate.getHours.call(d),
      nativeDate.getMinutes.call(d),
      nativeDate.getSeconds.call(d),
      nativeDate.getMilliseconds.call(d),
    );
  }

  function constructDate(args) {
    if (!tzReady()) return new native.Date(...args);
    if (args.length === 0) return new native.Date();
    if (args.length === 1) {
      const v = args[0];
      if (typeof v === "number") return new native.Date(v);
      if (typeof v === "string") return new native.Date(parseDateString(v));
      return new native.Date(v);
    }
    const y = args[0];
    const m = args[1];
    const d = args[2] == null ? 1 : args[2];
    const h = args[3] == null ? 0 : args[3];
    const mi = args[4] == null ? 0 : args[4];
    const s = args[5] == null ? 0 : args[5];
    const ms = args[6] == null ? 0 : args[6];
    return new native.Date(wallTimeToUtcMs(y, m, d, h, mi, s, ms));
  }

  function PlsDate(...args) {
    if (!new.target) {
      return tzReady() ? formatToString(new native.Date()) : native.Date();
    }
    return constructDate(args);
  }
  Object.setPrototypeOf(PlsDate, native.Date);
  PlsDate.prototype = native.Date.prototype;
  PlsDate.now = native.Date.now.bind(native.Date);
  PlsDate.UTC = native.Date.UTC.bind(native.Date);
  PlsDate.parse = function parse(s) {
    if (!tzReady()) return native.Date.parse(s);
    return parseDateString(s);
  };
  try {
    globalThis.Date = PlsDate;
  } catch { /* ignore */ }
  try {
    const ctorDesc = Object.getOwnPropertyDescriptor(dateProto, "constructor") || {
      writable: true,
      enumerable: false,
      configurable: true,
    };
    Object.defineProperty(dateProto, "constructor", {
      value: PlsDate,
      writable: ctorDesc.writable !== false,
      enumerable: ctorDesc.enumerable === true,
      configurable: ctorDesc.configurable !== false,
    });
  } catch { /* ignore */ }

  function patchDateMethod(name, impl) {
    try {
      dateProto[name] = function patched() {
        if (!tzReady() || invalid(this)) return nativeDate[name].apply(this, arguments);
        return impl.apply(this, arguments);
      };
    } catch { /* ignore */ }
  }

  patchDateMethod("getTimezoneOffset", function getTimezoneOffset() {
    return offsetMinutes(this);
  });
  patchDateMethod("getYear", function getYear() {
    return tzParts(this).year - 1900;
  });
  patchDateMethod("getFullYear", function getFullYear() { return tzParts(this).year; });

  function yearFromSetYear(y) {
    const n = Number(y);
    if (Number.isNaN(n)) return n;
    if (n >= 0 && n <= 99) return 1900 + n;
    return n;
  }

  function applySetFullYear(date, y, m, d) {
    const year = Number(y);
    if (Number.isNaN(year)) {
      nativeDate.setTime.call(date, Number.NaN);
      return Number.NaN;
    }
    let base;
    if (invalid(date)) {
      base = {
        year: year,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
        ms: 0,
      };
    } else {
      const p = tzParts(date);
      base = {
        year: p.year,
        month: p.month,
        day: p.day,
        hour: p.hour,
        minute: p.minute,
        second: p.second,
        ms: nativeDate.getMilliseconds.call(date),
      };
    }
    base.year = year;
    if (m !== undefined) base.month = Number(m) + 1;
    if (d !== undefined) base.day = Number(d);
    if (Number.isNaN(base.month) || Number.isNaN(base.day)) {
      nativeDate.setTime.call(date, Number.NaN);
      return Number.NaN;
    }
    const utc = wallTimeToUtcMs(base.year, base.month - 1, base.day, base.hour, base.minute, base.second, base.ms);
    nativeDate.setTime.call(date, utc);
    return date.getTime();
  }
  patchDateMethod("getMonth", function getMonth() { return tzParts(this).month - 1; });
  patchDateMethod("getDate", function getDate() { return tzParts(this).day; });
  patchDateMethod("getDay", function getDay() {
    const idx = WEEKDAY.indexOf(tzParts(this).weekday);
    return idx >= 0 ? idx : nativeDate.getDay.call(this);
  });
  patchDateMethod("getHours", function getHours() { return tzParts(this).hour; });
  patchDateMethod("getMinutes", function getMinutes() { return tzParts(this).minute; });
  patchDateMethod("getSeconds", function getSeconds() { return tzParts(this).second; });
  patchDateMethod("getMilliseconds", function getMilliseconds() {
    return nativeDate.getMilliseconds.call(this);
  });
  patchDateMethod("toString", function toString() { return formatToString(this); });
  patchDateMethod("toDateString", function toDateString() {
    const p = tzParts(this);
    return `${p.weekday || WEEKDAY[this.getUTCDay()]} ${MONTHS[p.month - 1]} ${pad(p.day)} ${p.year}`;
  });
  patchDateMethod("toTimeString", function toTimeString() {
    const p = tzParts(this);
    return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${p.gmt} (${p.timeZoneName})`;
  });
  patchDateMethod("toLocaleString", function toLocaleString(locales, options) {
    return nativeDate.toLocaleString.call(this, locales, mergeTz(options));
  });
  patchDateMethod("toLocaleDateString", function toLocaleDateString(locales, options) {
    return nativeDate.toLocaleDateString.call(this, locales, mergeTz(options));
  });
  patchDateMethod("toLocaleTimeString", function toLocaleTimeString(locales, options) {
    return nativeDate.toLocaleTimeString.call(this, locales, mergeTz(options));
  });

  function setLocal(date, fields) {
    if (invalid(date)) {
      nativeDate.setTime.call(date, Number.NaN);
      return Number.NaN;
    }
    const vals = Object.values(fields).map(Number);
    if (vals.some((n) => Number.isNaN(n))) {
      nativeDate.setTime.call(date, Number.NaN);
      return Number.NaN;
    }
    const p = tzParts(date);
    const next = Object.assign({
      year: p.year,
      month: p.month,
      day: p.day,
      hour: p.hour,
      minute: p.minute,
      second: p.second,
      ms: nativeDate.getMilliseconds.call(date),
    }, fields);
    const utc = wallTimeToUtcMs(next.year, next.month - 1, next.day, next.hour, next.minute, next.second, next.ms);
    nativeDate.setTime.call(date, utc);
    return date.getTime();
  }

  patchDateMethod("setHours", function setHours(h, m, s, ms) {
    const fields = { hour: Number(h) };
    if (m !== undefined) fields.minute = Number(m);
    if (s !== undefined) fields.second = Number(s);
    if (ms !== undefined) fields.ms = Number(ms);
    return setLocal(this, fields);
  });
  patchDateMethod("setMinutes", function setMinutes(m, s, ms) {
    const fields = { minute: Number(m) };
    if (s !== undefined) fields.second = Number(s);
    if (ms !== undefined) fields.ms = Number(ms);
    return setLocal(this, fields);
  });
  patchDateMethod("setSeconds", function setSeconds(s, ms) {
    const fields = { second: Number(s) };
    if (ms !== undefined) fields.ms = Number(ms);
    return setLocal(this, fields);
  });
  patchDateMethod("setMilliseconds", function setMilliseconds(ms) {
    return setLocal(this, { ms: Number(ms) });
  });
  try {
    dateProto.setFullYear = function setFullYear(y, m, d) {
      if (!tzReady()) return nativeDate.setFullYear.apply(this, arguments);
      return applySetFullYear(this, y, m, d);
    };
  } catch { /* ignore */ }
  try {
    dateProto.setYear = function setYear(y) {
      if (!tzReady()) {
        if (typeof nativeDate.setYear === "function") return nativeDate.setYear.apply(this, arguments);
        return nativeDate.setFullYear.call(this, yearFromSetYear(y));
      }
      return applySetFullYear(this, yearFromSetYear(y));
    };
  } catch { /* ignore */ }
  patchDateMethod("setMonth", function setMonth(m, d) {
    const fields = { month: Number(m) + 1 };
    if (d !== undefined) fields.day = Number(d);
    return setLocal(this, fields);
  });
  patchDateMethod("setDate", function setDate(d) {
    return setLocal(this, { day: Number(d) });
  });

  function patchedOptions(options) {
    if (!tzReady()) return options;
    return mergeTz(options);
  }

  function PatchedDTF(locales, options) {
    const args = [locales, patchedOptions(options)];
    if (new.target) return Reflect.construct(native.DTF, args, new.target);
    return Reflect.construct(native.DTF, args);
  }
  PatchedDTF.prototype = native.DTF.prototype;
  PatchedDTF.supportedLocalesOf = native.DTF.supportedLocalesOf.bind(native.DTF);
  try {
    Intl.DateTimeFormat = PatchedDTF;
  } catch {
    Object.defineProperty(Intl, "DateTimeFormat", { configurable: true, value: PatchedDTF });
  }
  try {
    const dtfProto = native.DTF.prototype;
    const dtfDesc = Object.getOwnPropertyDescriptor(dtfProto, "constructor") || {
      writable: true,
      enumerable: false,
      configurable: true,
    };
    Object.defineProperty(dtfProto, "constructor", {
      value: PatchedDTF,
      writable: dtfDesc.writable !== false,
      enumerable: dtfDesc.enumerable === true,
      configurable: dtfDesc.configurable !== false,
    });
  } catch { /* ignore */ }

  /* Temporal.Now（Chromium 正式 API）：未显式传 timezone 时用代理时区。不碰 instant()。
   * 正式方法：timeZoneId / zonedDateTimeISO / plainDateTimeISO / plainDateISO / plainTimeISO
   * 旧草案 zonedDateTime(calendar, tz) 若仍存在则同样包裹。
   */
  const Now = globalThis.Temporal && Temporal.Now;
  if (Now) {
    function wrapTz(name, tzIndex) {
      if (typeof Now[name] !== "function") return;
      const orig = Now[name].bind(Now);
      try {
        Now[name] = function () {
          const args = [...arguments];
          if (tzReady() && args[tzIndex] === undefined) args[tzIndex] = tz();
          return orig(...args);
        };
      } catch { /* ignore */ }
    }
    if (typeof Now.timeZoneId === "function") {
      const origId = Now.timeZoneId.bind(Now);
      try {
        Now.timeZoneId = function timeZoneId() {
          return tzReady() ? tz() : origId();
        };
      } catch { /* ignore */ }
    }
    wrapTz("zonedDateTimeISO", 0);
    wrapTz("plainDateTimeISO", 0);
    wrapTz("plainDateISO", 0);
    wrapTz("plainTimeISO", 0);
    wrapTz("zonedDateTime", 1);
    wrapTz("plainDateTime", 1);
    wrapTz("plainDate", 1);
  }

  /* -------------------------------------------------------------------------- */
  /* Chrome 144+ HTMLGeolocationElement / <geolocation>                         */
  /* -------------------------------------------------------------------------- */

  function elementPermission(el) {
    if (el && typeof el.permissionStatus === "string" && el.permissionStatus) {
      return el.permissionStatus;
    }
    const shared = currentPermissionState();
    if (shared) return shared;
    return "granted";
  }

  function elementUsable(el) {
    if (!el) return false;
    if (el.isValid === false) return false;
    return elementPermission(el) === "granted";
  }

  function readNativeHtmlGeoError(el) {
    try {
      const get = nativeHtmlGeoErrorDescriptor && nativeHtmlGeoErrorDescriptor.get;
      if (typeof get === "function") return get.call(el);
    } catch {
      /* ignore */
    }
    return null;
  }

  function htmlGeoErrorValue(el) {
    if (!el) return null;
    const perm = elementPermission(el);
    if (perm === "denied" && el.isValid !== false) {
      return makeError(1, "User denied Geolocation");
    }
    if (el.isValid === false) return readNativeHtmlGeoError(el);
    if (perm !== "granted") return null;
    return geoMode() === "error" ? makeError(2, "Position unavailable") : null;
  }

  function wrapGeoElementInstance(el) {
    if (!el || geoElements.has(el)) return;
    const rec = { activated: false, oneShotDone: false };
    geoElements.set(el, rec);
    if (elementUsable(el) && (el.watch || el.autolocate)) rec.activated = true;
    try {
      Object.defineProperty(el, "position", {
        configurable: true,
        enumerable: true,
        get() {
          if (!elementUsable(el)) return null;
          if (!ready()) return null;
          rec.activated = true;
          if (!el.watch) rec.oneShotDone = true;
          return buildPosition();
        },
      });
      Object.defineProperty(el, "error", {
        configurable: true,
        enumerable: true,
        get() {
          return htmlGeoErrorValue(el);
        },
      });
    } catch {
      try {
        el.autolocate = false;
        el.watch = false;
      } catch { /* ignore */ }
    }
  }

  function dispatchLocation(el) {
    if (typeof Event !== "function") return;
    try {
      el.dispatchEvent(new Event("location"));
    } catch { /* ignore */ }
  }

  function notifyGeoElements() {
    for (const [el, rec] of [...geoElements]) {
      if (!el || !rec) continue;
      if (!elementUsable(el)) continue;
      if (el.watch) {
        if (ready()) {
          rec.activated = true;
          dispatchLocation(el);
        }
        continue;
      }
      if (!rec.oneShotDone && ready() && (el.autolocate || rec.activated)) {
        rec.oneShotDone = true;
        rec.activated = true;
        dispatchLocation(el);
      }
    }
  }

  function trackAddedNode(node) {
    if (!node) return;
    if (node.nodeName && String(node.nodeName).toLowerCase() === "geolocation") {
      wrapGeoElementInstance(node);
    }
    if (node.querySelectorAll) {
      try {
        const list = node.querySelectorAll("geolocation");
        if (list) for (const el of list) wrapGeoElementInstance(el);
      } catch { /* ignore */ }
    }
  }

  function patchHtmlGeolocation() {
    if (htmlGeoPatched) return;
    htmlGeoPatched = true;
    const Ctor = globalThis.HTMLGeolocationElement;
    if (typeof Ctor === "function" && Ctor.prototype) {
      const proto = Ctor.prototype;
      const errDesc = Object.getOwnPropertyDescriptor(proto, "error");
      nativeHtmlGeoErrorDescriptor = errDesc || nativeHtmlGeoErrorDescriptor;
      try {
        Object.defineProperty(proto, "position", {
          configurable: true,
          enumerable: true,
          get() {
            wrapGeoElementInstance(this);
            if (!elementUsable(this)) return null;
            if (!ready()) return null;
            const rec = geoElements.get(this);
            if (rec) {
              rec.activated = true;
              if (!this.watch) rec.oneShotDone = true;
            }
            return buildPosition();
          },
        });
        Object.defineProperty(proto, "error", {
          configurable: true,
          enumerable: true,
          get() {
            wrapGeoElementInstance(this);
            return htmlGeoErrorValue(this);
          },
        });
      } catch {
        /* instance wrapping below */
      }
    }
    if (native.createElement && document.createElement) {
      try {
        document.createElement = function patchedCreateElement(name, options) {
          const el = native.createElement(name, options);
          if (String(name).toLowerCase() === "geolocation") wrapGeoElementInstance(el);
          return el;
        };
      } catch { /* ignore */ }
    }
    const scanRoot = () => {
      try {
        const list = document.querySelectorAll && document.querySelectorAll("geolocation");
        if (list) for (const el of list) wrapGeoElementInstance(el);
      } catch { /* ignore */ }
    };
    scanRoot();
    try {
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations || []) {
          if (!m.addedNodes) continue;
          for (const n of m.addedNodes) trackAddedNode(n);
        }
      });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch { /* ignore */ }
  }

  patchHtmlGeolocation();
})();
