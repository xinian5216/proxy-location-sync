/**
 * 共享 AbortController 槽：新任务 abort 旧任务；旧任务 finally 不得清掉新任务。
 */

export function createAbortSlot() {
  let current = null;

  function replace() {
    if (current) {
      try {
        current.abort();
      } catch {
        /* ignore */
      }
    }
    const mine = new AbortController();
    current = mine;
    return mine;
  }

  function clear(mine) {
    if (current === mine) current = null;
  }

  function abortCurrent() {
    if (current) {
      try {
        current.abort();
      } catch {
        /* ignore */
      }
    }
  }

  function getCurrent() {
    return current;
  }

  return { replace, clear, abortCurrent, getCurrent };
}

export async function runExclusive(slot, fn) {
  const mine = slot.replace();
  try {
    return await fn(mine.signal);
  } finally {
    slot.clear(mine);
  }
}
