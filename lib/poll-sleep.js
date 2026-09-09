/**
 * Offscreen 轮询间隔。全部 IP provider 冷却时可以睡到 nextRetryAt，
 * 但有上限，避免数分钟毫无反应。
 */

export const COOLDOWN_SLEEP_CAP_MS = 30_000;

export function nextPollDelayMs(intervalSec, nextRetryAt, now = Date.now(), capMs = COOLDOWN_SLEEP_CAP_MS) {
  const interval = Math.max(2, Number(intervalSec) || 3) * 1000;
  if (!Number.isFinite(nextRetryAt) || nextRetryAt <= now) return interval;
  const until = nextRetryAt - now;
  return Math.min(capMs, Math.max(until, interval));
}

export async function sendAck(send, payload) {
  try {
    await send(payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export async function runResilientLoop({ isStopped, tick, sleep, delayMs }) {
  let turns = 0;
  while (!isStopped()) {
    try {
      await tick();
    } catch {
      /* sendMessage / echo 失败不得杀死循环 */
    }
    turns += 1;
    if (isStopped()) break;
    const wait = typeof delayMs === "function" ? delayMs() : delayMs;
    await sleep(wait);
  }
  return turns;
}
