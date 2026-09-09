/**
 * 检测提交规则（纯函数，便于测竞态）：
 * - 只有 looked.ip === targetIp 才能提交
 * - generation 过期必须丢弃
 * - 缓存超过 TTL 视为失效
 * - 缓存 key 用 canonicalizeIp，避免 IPv6 文本形式分裂
 */

import { canonicalizeIp, ipsEqual } from "./ip-compare.js";

export const GEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isCacheFresh(record, now = Date.now(), ttl = GEO_CACHE_TTL_MS) {
  if (!record || !Number.isFinite(record.fetchedAt)) return false;
  return now - record.fetchedAt < ttl;
}

export function shouldDiscard(myGeneration, latestGeneration) {
  return myGeneration !== latestGeneration;
}

export function canCommitGeo(lookedIp, targetIp) {
  return ipsEqual(lookedIp, targetIp);
}

export function nextGeneration(current) {
  return current + 1;
}

export function geoCacheKey(ip) {
  return canonicalizeIp(ip) || String(ip || "");
}

export function geoCacheGet(cache, ip) {
  if (!cache) return undefined;
  const key = geoCacheKey(ip);
  return cache[key] || cache[ip];
}

export function shouldSkipGeoRetry(state, ip, now = Date.now()) {
  if (!state || !Number.isFinite(state.nextGeoRetryAt)) return false;
  if (now >= state.nextGeoRetryAt) return false;
  if (state.pendingIp && ipsEqual(state.pendingIp, ip)) return true;
  return false;
}

export function nextGeoRetryAt(now = Date.now(), failCount = 1) {
  const wait = Math.min(60_000, 3000 * 2 ** Math.min(Math.max(failCount, 1) - 1, 4));
  return now + wait;
}
