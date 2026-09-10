/**
 * 由 IP 字符串派生「稳定」的随机位置与精度。
 *
 * 同一个公网 IP 在整个使用期间必须返回同一组经纬度，否则网页会认为
 * 用户在持续移动。只有 IP 变化后才允许重新取样。
 */

import { ACCURACY_MAX, ACCURACY_MIN, JITTER_MAX_KM, JITTER_MIN_KM } from "./constants.js";

/** FNV-1a 32-bit，把 IP 映射成确定性种子 */
export function hashIp(ip) {
  let h = 2166136261;
  const s = String(ip || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 在 (lat, lng) 周围生成 1–5 km 的稳定偏移。
 * 使用简单的等距近似：1° 纬度 ≈ 111.32 km。
 */
export function jitterLatLng(lat, lng, ip) {
  const rng = mulberry32(hashIp(ip) ^ 0x9e3779b9);
  const distKm = JITTER_MIN_KM + rng() * (JITTER_MAX_KM - JITTER_MIN_KM);
  const bearing = rng() * Math.PI * 2;
  const dLat = (distKm / 111.32) * Math.cos(bearing);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const denom = 111.32 * Math.max(0.05, Math.abs(cosLat));
  const dLng = (distKm / denom) * Math.sin(bearing);
  return {
    latitude: clamp(lat + dLat, -85, 85),
    longitude: wrapLng(lng + dLng),
    offsetKm: distKm,
  };
}

/** 精度同样由 IP 决定，落在 800–4200 米，避免每次检测都变。 */
export function accuracyForIp(ip) {
  const rng = mulberry32(hashIp(ip) ^ 0x85ebca6b);
  const meters = ACCURACY_MIN + rng() * (ACCURACY_MAX - ACCURACY_MIN);
  return Math.round(meters);
}

export function applyLocationMode(rawLat, rawLng, ip, mode) {
  const accuracy = accuracyForIp(ip);
  if (mode !== "jitter" || !Number.isFinite(rawLat) || !Number.isFinite(rawLng)) {
    return { latitude: rawLat, longitude: rawLng, accuracy, offsetKm: 0 };
  }
  const jittered = jitterLatLng(rawLat, rawLng, ip);
  return { ...jittered, accuracy };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function wrapLng(lng) {
  let x = lng;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

/** 两点大圆距离（公里）。缺坐标返回 NaN。 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Number.NaN;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
