/**
 * Offscreen 与 SW fallback 互斥。offscreen 恢复后必须停掉 fallback。
 */

export function createPollerSupervisor() {
  let fallback = false;
  let offscreen = false;

  function onOffscreenReady() {
    const stopFallback = fallback;
    fallback = false;
    offscreen = true;
    return { stopFallback, startFallback: false };
  }

  function onOffscreenFailed() {
    const startFallback = !fallback;
    fallback = true;
    offscreen = false;
    return { stopFallback: false, startFallback };
  }

  function stopAll() {
    const stopFallback = fallback;
    fallback = false;
    offscreen = false;
    return { stopFallback };
  }

  return {
    onOffscreenReady,
    onOffscreenFailed,
    stopAll,
    isFallback: () => fallback,
    isOffscreen: () => offscreen,
    activePoller: () => (offscreen ? "offscreen" : fallback ? "fallback" : "none"),
  };
}
