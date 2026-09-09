/**
 * Provider 健康度：连续失败进入冷却，成功者优先。
 * 全部冷却时自动轮询不得再打任何源；manual resync 可 bypass。
 */

export function createProviderHealth() {
  const map = new Map();

  function slot(id) {
    if (!map.has(id)) map.set(id, { fails: 0, cooldownUntil: 0, lastOk: 0 });
    return map.get(id);
  }

  function isCooling(id, now = Date.now()) {
    return now < slot(id).cooldownUntil;
  }

  function recordOk(id, now = Date.now()) {
    map.set(id, { fails: 0, cooldownUntil: 0, lastOk: now });
  }

  function recordFail(id, { status, now = Date.now() } = {}) {
    const s = slot(id);
    s.fails += 1;
    let backoff = Math.min(60_000, 1_500 * 2 ** Math.min(s.fails - 1, 5));
    if (status === 429) backoff = Math.max(backoff, 30_000);
    if (status === 403 || status === 401) backoff = Math.max(backoff, 60_000);
    s.cooldownUntil = now + backoff;
  }

  function order(providers, now = Date.now(), { allowCooling = false } = {}) {
    const ready = [];
    const cooling = [];
    for (const p of providers) {
      (isCooling(p.id, now) ? cooling : ready).push(p);
    }
    ready.sort((a, b) => slot(b.id).lastOk - slot(a.id).lastOk);
    cooling.sort((a, b) => slot(a.id).cooldownUntil - slot(b.id).cooldownUntil);
    if (ready.length) return ready;
    if (allowCooling) return cooling.slice(0, 1);
    return [];
  }

  function nextRetryAt(now = Date.now()) {
    let min = Infinity;
    for (const v of map.values()) {
      if (v.cooldownUntil > now) min = Math.min(min, v.cooldownUntil);
    }
    return min === Infinity ? 0 : min;
  }

  function snapshot() {
    const out = {};
    for (const [id, v] of map) out[id] = { ...v };
    return out;
  }

  function reset() {
    map.clear();
  }

  return { isCooling, recordOk, recordFail, order, nextRetryAt, snapshot, reset };
}

export function cooldownError(message, nextRetryAt) {
  const err = new Error(message);
  err.name = "CooldownError";
  err.nextRetryAt = nextRetryAt || Date.now() + 3000;
  return err;
}
