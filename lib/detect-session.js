/**
 * 检测 generation：后到的公网出口永远覆盖先到的。
 * 旧 lookup 用 AbortController 取消，完成时若 generation 过期则丢弃。
 */

export function createDetectSession() {
  let latestGen = 0;
  let inflightAbort = null;

  function begin() {
    latestGen += 1;
    if (inflightAbort) inflightAbort.abort();
    inflightAbort = new AbortController();
    return { generation: latestGen, signal: inflightAbort.signal };
  }

  function isCurrent(generation) {
    return generation === latestGen;
  }

  function abortAll() {
    latestGen += 1;
    if (inflightAbort) {
      inflightAbort.abort();
      inflightAbort = null;
    }
  }

  function getLatest() {
    return latestGen;
  }

  return { begin, isCurrent, abortAll, getLatest };
}
