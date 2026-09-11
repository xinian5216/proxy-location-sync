/**
 * 扩展自身环境的 Worker 探测。由 offscreen / diagnostics page 调用。
 * 使用打包的 chrome-extension URL，不用 Blob。
 * 失败只返回 { ok: false }，绝不抛到 IP Echo / Geo 路径。
 */

export const WORKER_PROBE_TIMEOUT_MS = 1500;
export const WORKER_PROBE_SCRIPT = "diagnostics/worker-probe.js";

export function probeExtensionWorker({
  Worker: WorkerImpl,
  workerUrl,
  timeout = WORKER_PROBE_TIMEOUT_MS,
  signal,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let worker = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) {
        try {
          clearTimeout(timer);
        } catch {
          /* ignore */
        }
      }
      if (signal && typeof signal.removeEventListener === "function") {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          /* ignore */
        }
      }
      if (worker) {
        try {
          worker.terminate();
        } catch {
          /* ignore */
        }
      }
      resolve(normalizeWorkerResult(result));
    };

    function onAbort() {
      finish({ ok: false, reason: "aborted" });
    }

    try {
      if (signal && signal.aborted) {
        finish({ ok: false, reason: "aborted" });
        return;
      }
      if (typeof WorkerImpl !== "function" || !workerUrl) {
        finish({ ok: false, reason: "Worker unavailable" });
        return;
      }
      worker = new WorkerImpl(workerUrl);
      const ms = Number.isFinite(timeout) && timeout >= 0 ? timeout : WORKER_PROBE_TIMEOUT_MS;
      timer = setTimeout(() => finish({ ok: false, reason: "worker timeout" }), ms);
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      worker.onmessage = function (ev) {
        finish(ev && ev.data ? ev.data : { ok: false, reason: "empty worker result" });
      };
      worker.onerror = function () {
        finish({ ok: false, reason: "worker error" });
      };
      if (typeof worker.postMessage === "function") worker.postMessage("probe");
    } catch (err) {
      finish({ ok: false, reason: String(err && err.message ? err.message : err) });
    }
  });
}

function normalizeWorkerResult(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "Worker unavailable" };
  }
  if (result.ok === true) {
    return {
      ok: true,
      timezone: result.timezone || "",
      offsetMin: Number.isFinite(result.offsetMin) ? result.offsetMin : Number.NaN,
      language: result.language || "",
    };
  }
  return {
    ok: false,
    reason: result.reason || "未能探测 Worker",
  };
}
