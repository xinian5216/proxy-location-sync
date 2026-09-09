import { ECHO_STALE_MS } from "./constants.js";

export { ECHO_STALE_MS };

export function isEchoStaleFromAt(lastSuccessfulEchoAt, now = Date.now(), windowMs = ECHO_STALE_MS) {
  const at = Number(lastSuccessfulEchoAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at > windowMs;
}

export function isEchoStale(state, now = Date.now(), windowMs = ECHO_STALE_MS) {
  if (!state || !state.ip) return false;
  if (state.echoStale) return true;
  return isEchoStaleFromAt(state.lastSuccessfulEchoAt, now, windowMs);
}

/** Echo 失败：超过窗口则标 stale。Geo 成败与 Echo 无关。 */
export function applyEchoFailure(prev, { error, now = Date.now(), windowMs = ECHO_STALE_MS } = {}) {
  const base = prev && typeof prev === "object" ? { ...prev } : {};
  const stale = isEchoStaleFromAt(base.lastSuccessfulEchoAt, now, windowMs);
  return {
    ...base,
    lastError: stale ? (error || base.lastError || "echo stale") : base.lastError || error || "",
    echoStale: stale || Boolean(base.echoStale),
    geoStatus: stale
      ? base.geoStatus === "error"
        ? "error"
        : "pending"
      : base.geoStatus,
  };
}
