/**
 * 带超时 + 外部 AbortSignal 的 fetch。不带 Cookie / Referer。
 * 超时抛 TimeoutError（可换下一个 Provider）。
 * 仅父级 AbortSignal 才抛 AbortError（整次检测作废）。
 */

export async function fetchWithTimeout(url, { timeoutMs, signal, headers } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onParentAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    signal.addEventListener("abort", onParentAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: headers || {},
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res;
  } catch (err) {
    if (timedOut) {
      const e = new Error(`timeout ${timeoutMs}ms`);
      e.name = "TimeoutError";
      throw e;
    }
    if (signal && signal.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }
}
