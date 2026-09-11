/**
 * IANA 时区 ↔ Date 本地时间。用于 popup 展示，以及测试 Date 构造 / parse / DST。
 * injected.js 内有一份平行实现（MAIN world 不能 import）。
 *
 * 墙上时间 → epoch 的歧义处理尽量贴近 Temporal compatible：
 * - 缺口（春进）：用 later（跳过的小时落到 DST 之后）
 * - 重叠（秋回）：用 earlier（第一次出现，仍是 DST）
 */

function partsToMap(parts) {
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return map;
}

export function isInvalidDate(date) {
  return !date || Number.isNaN(date.getTime());
}

export function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function getOffsetMinutes(timeZone, date = new Date()) {
  if (!timeZone || isInvalidDate(date)) {
    return isInvalidDate(date) ? NaN : date.getTimezoneOffset();
  }
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const map = partsToMap(dtf.formatToParts(date));
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second),
    );
    return Math.round((date.getTime() - asUtc) / 60000);
  } catch {
    return date.getTimezoneOffset();
  }
}

function wallMatches(timeZone, epochMs, y, monthIndex, d, h, min, s) {
  const p = getTzParts(timeZone, new Date(epochMs));
  if (!p) return false;
  return (
    p.year === y &&
    p.month === monthIndex + 1 &&
    p.day === d &&
    p.hour === h &&
    p.minute === min &&
    p.second === s
  );
}

/**
 * 把「目标时区的墙上时间」转成 epoch ms。
 * 先按 UTC 溢出规范化（与 V8 本地 Date 构造一致），再按 Temporal compatible 消歧。
 */
export function wallTimeToUtcMs(timeZone, y, monthIndex, d = 1, h = 0, min = 0, s = 0, ms = 0) {
  const overflow = new Date(Date.UTC(y, monthIndex, d, h, min, s, ms));
  const yy = overflow.getUTCFullYear();
  const mo = overflow.getUTCMonth();
  const dd = overflow.getUTCDate();
  const hh = overflow.getUTCHours();
  const mi = overflow.getUTCMinutes();
  const ss = overflow.getUTCSeconds();
  const mss = overflow.getUTCMilliseconds();
  const utcGuess = Date.UTC(yy, mo, dd, hh, mi, ss, mss);

  const oEarly = getOffsetMinutes(timeZone, new Date(utcGuess - 24 * 3600000));
  const oLate = getOffsetMinutes(timeZone, new Date(utcGuess + 24 * 3600000));
  const tEarly = utcGuess + oEarly * 60000;
  const tLate = utcGuess + oLate * 60000;

  const matchEarly = wallMatches(timeZone, tEarly, yy, mo, dd, hh, mi, ss);
  const matchLate = wallMatches(timeZone, tLate, yy, mo, dd, hh, mi, ss);

  if (matchEarly && matchLate) return Math.min(tEarly, tLate);
  if (matchEarly) return tEarly;
  if (matchLate) return tLate;
  return Math.max(tEarly, tLate);
}

const HAS_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const ISO_NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
/** Chromium-supported legacy US abbreviations. Keep native-absolute; do not reinterpret as fake-local.
 *  Date.parse 必须走当前引擎原生结果，不要把 V8/Chromium 的 EST 表套到 Firefox。 */
const LEGACY_TZ_ABBR = /\b(?:EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/i;

export function hasExplicitTimeZone(str) {
  const t = String(str).trim().replace(/\s+\([^)]*\)$/, "");
  if (HAS_ZONE.test(t)) return true;
  if (/\b(?:GMT|UTC)\b/i.test(t)) return true;
  if (LEGACY_TZ_ABBR.test(t)) return true;
  return false;
}

export function parseDateString(timeZone, str) {
  const s = String(str).trim();
  if (hasExplicitTimeZone(s)) return Date.parse(s);
  const m = s.match(ISO_NAIVE);
  if (m) {
    const dateOnly = m[4] == null && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (dateOnly) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    let frac = 0;
    if (m[7]) frac = Number(String(m[7]).padEnd(3, "0").slice(0, 3));
    return wallTimeToUtcMs(
      timeZone,
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0),
      frac,
    );
  }
  const nativeMs = Date.parse(s);
  if (Number.isNaN(nativeMs)) return nativeMs;
  const d = new Date(nativeMs);
  return wallTimeToUtcMs(
    timeZone,
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  );
}

export function formatGmt(offsetMin) {
  if (!Number.isFinite(offsetMin)) return "";
  const sign = offsetMin <= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `GMT${sign}${h}${m}`;
}

export function formatOffsetLabel(offsetMin) {
  if (!Number.isFinite(offsetMin)) return "";
  const sign = offsetMin <= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m ? `GMT${sign}${h}:${String(m).padStart(2, "0")}` : `GMT${sign}${h}`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function getTzParts(timeZone, date = new Date()) {
  if (isInvalidDate(date)) return null;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
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
  const map = partsToMap(dtf.formatToParts(date));
  const offsetMin = getOffsetMinutes(timeZone, date);
  return {
    weekday: map.weekday,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    ms: Number(map.fractionalSecond || 0),
    timeZoneName: map.timeZoneName || timeZone,
    offsetMin,
    gmt: formatGmt(offsetMin),
  };
}

export function formatDateToString(timeZone, date) {
  if (isInvalidDate(date)) return "Invalid Date";
  const p = getTzParts(timeZone, date);
  const wd = p.weekday || WEEKDAY_SHORT[date.getUTCDay()];
  const mon = MONTH_SHORT[p.month - 1] || MONTH_SHORT[date.getUTCMonth()];
  const day = String(p.day).padStart(2, "0");
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  const ss = String(p.second).padStart(2, "0");
  return `${wd} ${mon} ${day} ${p.year} ${hh}:${mm}:${ss} ${p.gmt} (${p.timeZoneName})`;
}

export function positiveMod(n, m) {
  return ((n % m) + m) % m;
}

/** Date 本地 setter：NaN 字段 → Invalid Date。setMonth/Date/Hours 在 Invalid Date 上保持 Invalid。 */
export function applyLocalSetter(timeZone, date, fields) {
  if (isInvalidDate(date)) {
    date.setTime(Number.NaN);
    return Number.NaN;
  }
  const vals = Object.values(fields).map(Number);
  if (vals.some((n) => Number.isNaN(n))) {
    date.setTime(Number.NaN);
    return Number.NaN;
  }
  const p = getTzParts(timeZone, date);
  const next = {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    ms: date.getMilliseconds(),
    ...fields,
  };
  const utc = wallTimeToUtcMs(
    timeZone,
    next.year,
    next.month - 1,
    next.day,
    next.hour,
    next.minute,
    next.second,
    next.ms,
  );
  date.setTime(utc);
  return date.getTime();
}

/**
 * setFullYear / setYear：Invalid Date 按原生语义恢复。
 * ES: if this time value is NaN, t = +0 (not LocalTime(+0)).
 * MonthFromTime(+0)=0, DateFromTime(+0)=1, TimeWithinDay(+0)=0
 * → 目标时区的本地午夜，而不是 epoch +0 在该时区的墙上时间。
 */
export function applySetFullYear(timeZone, date, year, month, day) {
  const y = Number(year);
  if (Number.isNaN(y)) {
    date.setTime(Number.NaN);
    return Number.NaN;
  }
  let base;
  if (isInvalidDate(date)) {
    base = {
      year: y,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      ms: 0,
    };
  } else {
    const p = getTzParts(timeZone, date);
    base = {
      year: p.year,
      month: p.month,
      day: p.day,
      hour: p.hour,
      minute: p.minute,
      second: p.second,
      ms: date.getMilliseconds(),
    };
  }
  base.year = y;
  if (month !== undefined) base.month = Number(month) + 1;
  if (day !== undefined) base.day = Number(day);
  if (Number.isNaN(base.month) || Number.isNaN(base.day)) {
    date.setTime(Number.NaN);
    return Number.NaN;
  }
  const utc = wallTimeToUtcMs(
    timeZone,
    base.year,
    base.month - 1,
    base.day,
    base.hour,
    base.minute,
    base.second,
    base.ms,
  );
  date.setTime(utc);
  return date.getTime();
}

export function yearFromSetYear(y) {
  const n = Number(y);
  if (Number.isNaN(n)) return n;
  if (n >= 0 && n <= 99) return 1900 + n;
  return n;
}
