/**
 * Geolocation 模式。Date/Intl 另走「是否有虚拟时区」，不跟 pending 一起掉回 host。
 *
 * Echo 失联只看 state.echoStale 旗标。storage 里的 lastSuccessfulEchoAt
 * 在同 IP 心跳时不再更新，不能拿来当实时健康度。
 */

import { ipsEqual } from "./ip-compare.js";

export function switchingExit(state) {
  if (!state) return false;
  if (state.pendingIp && !state.ip) return true;
  if (state.pendingIp && state.ip && !ipsEqual(state.pendingIp, state.ip)) return true;
  return false;
}

export function resolveGeoMode(settings, state) {
  if (!settings || settings.enabled === false) return "disabled";
  if (!state) return "pending";
  if (state.echoStale) {
    return state.geoStatus === "error" ? "error" : "pending";
  }
  if (switchingExit(state)) {
    return state.geoStatus === "error" ? "error" : "pending";
  }
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

export function tzSpoofActive(settings, state) {
  if (!state || !state.timezone) return false;
  if (!settings || settings.enabled === false) return false;
  return true;
}

/** MAIN world 用：页面可控字段绝不能变成 native GPS。 */
export function resolveMainWorldGeoMode(state) {
  if (!state) return "pending";
  if (state.echoStale) {
    return state.geoStatus === "error" ? "error" : "pending";
  }
  if (switchingExit(state)) {
    return state.geoStatus === "error" ? "error" : "pending";
  }
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

export function mergePublicState(prev, incoming) {
  if (incoming == null || typeof incoming !== "object") return prev;
  const next = { ...incoming };
  const prevTz = prev && prev.timezone;
  if (!next.timezone && prevTz) next.timezone = prevTz;
  return next;
}

export function mergePublicSettings(prev, incoming) {
  const base = prev && typeof prev === "object" ? { ...prev } : { enabled: true };
  if (!incoming || typeof incoming !== "object") return { ...base, enabled: true };
  const next = { ...base, ...incoming, enabled: true };
  return next;
}
