import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyLocalSetter,
  applySetFullYear,
  formatDateToString,
  getOffsetMinutes,
  getTzParts,
  isInvalidDate,
  isValidTimeZone,
  parseDateString,
  wallTimeToUtcMs,
} from "../lib/timezone.js";

function wall(tz, y, m, d, h = 0, min = 0, s = 0, ms = 0) {
  return wallTimeToUtcMs(tz, y, m, d, h, min, s, ms);
}

function parts(tz, epoch) {
  return getTzParts(tz, new Date(epoch));
}

describe("Date / timezone", () => {
  test("Tokyo has no DST and offset is -540", () => {
    const tz = "Asia/Tokyo";
    const winter = wall(tz, 2026, 0, 15, 12, 0, 0, 0);
    const summer = wall(tz, 2026, 6, 15, 12, 0, 0, 0);
    assert.equal(getOffsetMinutes(tz, new Date(winter)), -540);
    assert.equal(getOffsetMinutes(tz, new Date(summer)), -540);
    const p = parts(tz, winter);
    assert.equal(p.hour, 12);
    assert.equal(p.day, 15);
    assert.equal(winter, Date.UTC(2026, 0, 15, 3, 0, 0, 0));
  });

  test("Shanghai has no DST", () => {
    const tz = "Asia/Shanghai";
    const a = wall(tz, 2026, 0, 15, 12);
    const b = wall(tz, 2026, 6, 15, 12);
    assert.equal(getOffsetMinutes(tz, new Date(a)), -480);
    assert.equal(getOffsetMinutes(tz, new Date(b)), -480);
  });

  test("Los Angeles winter PST vs summer PDT", () => {
    const tz = "America/Los_Angeles";
    const winter = wall(tz, 2026, 0, 15, 12, 0, 0, 0);
    const summer = wall(tz, 2026, 6, 15, 12, 0, 0, 0);
    assert.equal(getOffsetMinutes(tz, new Date(winter)), 480);
    assert.equal(getOffsetMinutes(tz, new Date(summer)), 420);
    assert.equal(winter, Date.UTC(2026, 0, 15, 20, 0, 0, 0));
    assert.equal(summer, Date.UTC(2026, 6, 15, 19, 0, 0, 0));
  });

  test("Berlin DST 2026", () => {
    const tz = "Europe/Berlin";
    const winter = wall(tz, 2026, 0, 15, 12);
    const summer = wall(tz, 2026, 6, 15, 12);
    assert.equal(getOffsetMinutes(tz, new Date(winter)), -60);
    assert.equal(getOffsetMinutes(tz, new Date(summer)), -120);
  });

  test("LA spring-forward gap 2026-03-08 02:30 maps to 03:30 PDT (compatible/later)", () => {
    const tz = "America/Los_Angeles";
    const ms = wall(tz, 2026, 2, 8, 2, 30, 0, 0);
    const p = parts(tz, ms);
    assert.equal(p.hour, 3);
    assert.equal(p.minute, 30);
    assert.equal(p.day, 8);
    assert.equal(p.offsetMin, 420);
  });

  test("LA fall-back fold 2026-11-01 01:30 picks earlier PDT occurrence", () => {
    const tz = "America/Los_Angeles";
    const ms = wall(tz, 2026, 10, 1, 1, 30, 0, 0);
    const p = parts(tz, ms);
    assert.equal(p.hour, 1);
    assert.equal(p.minute, 30);
    assert.equal(p.offsetMin, 420);
  });

  test("unique times around LA DST still round-trip", () => {
    const tz = "America/Los_Angeles";
    const before = wall(tz, 2026, 2, 8, 1, 30, 0, 0);
    const after = wall(tz, 2026, 2, 8, 3, 30, 0, 0);
    const pb = parts(tz, before);
    const pa = parts(tz, after);
    assert.equal(pb.hour, 1);
    assert.equal(pb.offsetMin, 480);
    assert.equal(pa.hour, 3);
    assert.equal(pa.offsetMin, 420);
  });

  test("Berlin spring-forward gap 2026-03-29 02:30 → 03:30", () => {
    const tz = "Europe/Berlin";
    const ms = wall(tz, 2026, 2, 29, 2, 30, 0, 0);
    const p = parts(tz, ms);
    assert.equal(p.hour, 3);
    assert.equal(p.minute, 30);
  });
});

describe("Date.parse / Date() string / Invalid Date / ms", () => {
  test("ISO with Z is UTC, not wall time", () => {
    const tz = "Asia/Tokyo";
    assert.equal(parseDateString(tz, "2026-01-15T12:00:00Z"), Date.parse("2026-01-15T12:00:00Z"));
    assert.equal(parseDateString(tz, "2026-01-15T12:00:00+09:00"), Date.parse("2026-01-15T12:00:00+09:00"));
  });

  test("date-only YYYY-MM-DD is UTC midnight", () => {
    assert.equal(parseDateString("Asia/Tokyo", "2026-01-15"), Date.UTC(2026, 0, 15));
  });

  test("naive ISO datetime is wall time in target tz", () => {
    const tz = "Asia/Tokyo";
    const ms = parseDateString(tz, "2026-01-15T12:00:00");
    assert.equal(ms, Date.UTC(2026, 0, 15, 3, 0, 0, 0));
    const p = parts(tz, ms);
    assert.equal(p.hour, 12);
  });

  test("naive datetime with fractional seconds", () => {
    const ms = parseDateString("Asia/Tokyo", "2026-01-15T12:00:00.250");
    assert.equal(ms % 1000, 250);
  });

  test("Invalid Date stays Invalid Date", () => {
    const bad = new Date(Number.NaN);
    assert.equal(isInvalidDate(bad), true);
    assert.equal(formatDateToString("Asia/Tokyo", bad), "Invalid Date");
    assert.equal(Number.isNaN(getOffsetMinutes("Asia/Tokyo", bad)), true);
    assert.equal(bad.toString(), "Invalid Date");
    assert.equal(Number.isNaN(bad.getHours()), true);
    assert.equal(Number.isNaN(bad.getMilliseconds()), true);
  });

  test("getMilliseconds of negative epoch is 0–999 (native)", () => {
    const d = new Date(-1500);
    assert.equal(d.getMilliseconds(), 500);
    assert.equal(new Date(0).getMilliseconds(), 0);
  });

  test("Date toString uses target tz, not host", () => {
    const tz = "Asia/Tokyo";
    const epoch = wall(tz, 2026, 0, 15, 12, 0, 0, 0);
    const text = formatDateToString(tz, new Date(epoch));
    assert.match(text, /Jan/);
    assert.match(text, /15/);
    assert.match(text, /2026/);
    assert.match(text, /12:00:00/);
    assert.match(text, /GMT\+0900/);
    assert.notEqual(text, "Invalid Date");
  });

  test("component overflow 24:00 becomes next day", () => {
    const tz = "Asia/Tokyo";
    const ms = wall(tz, 2026, 0, 15, 24, 0, 0, 0);
    const p = parts(tz, ms);
    assert.equal(p.day, 16);
    assert.equal(p.hour, 0);
  });
});

describe("IANA timezone validation + Date setters", () => {
  test("UTC / Etc/UTC / Asia/Tokyo / America/Los_Angeles are valid", () => {
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Etc/UTC"), true);
    assert.equal(isValidTimeZone("Asia/Tokyo"), true);
    assert.equal(isValidTimeZone("America/Los_Angeles"), true);
  });

  test("invalid timezone is rejected without relying on slash", () => {
    assert.equal(isValidTimeZone("Not/AZone"), false);
    assert.equal(isValidTimeZone("GMT"), true);
    assert.equal(isValidTimeZone(""), false);
    assert.equal(isValidTimeZone("Tokyo"), false);
  });

  test("setHours/Minutes/Month/FullYear(NaN) become Invalid Date, no RangeError", () => {
    const tz = "Asia/Tokyo";
    const d1 = new Date(Date.UTC(2026, 0, 15, 3));
    assert.equal(Number.isNaN(applyLocalSetter(tz, d1, { hour: Number.NaN })), true);
    assert.equal(isInvalidDate(d1), true);

    const d2 = new Date(Date.UTC(2026, 0, 15, 3));
    assert.equal(Number.isNaN(applyLocalSetter(tz, d2, { minute: Number.NaN })), true);
    assert.equal(isInvalidDate(d2), true);

    const d3 = new Date(Date.UTC(2026, 0, 15, 3));
    assert.equal(Number.isNaN(applyLocalSetter(tz, d3, { month: Number.NaN })), true);
    assert.equal(isInvalidDate(d3), true);

    const d4 = new Date(Date.UTC(2026, 0, 15, 3));
    assert.equal(Number.isNaN(applyLocalSetter(tz, d4, { year: Number.NaN })), true);
    assert.equal(isInvalidDate(d4), true);
  });

  test("Invalid Date.setFullYear recovers using virtual timezone of +0", () => {
    const tz = "Asia/Tokyo";
    const d = new Date(Number.NaN);
    const ret = applySetFullYear(tz, d, 2026);
    assert.equal(Number.isNaN(ret), false);
    assert.equal(isInvalidDate(d), false);
    assert.equal(d.getTime(), Date.UTC(2026, 0, 1, 0, 0, 0));
    const p = parts(tz, d.getTime());
    assert.equal(p.year, 2026);
    assert.equal(p.hour, 9);
  });
});
