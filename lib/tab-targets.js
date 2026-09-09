/**
 * SW 重启后 seenTabs 会丢。向已打开页面推送状态时，
 * 用 chrome.tabs.query({}) 补全 tabId（不读 title/url/favIcon）。
 * host_permissions 已覆盖 http(s)，不需要 "tabs" 权限。
 */

export function collectTabIds(seenIds, queriedTabs) {
  const ids = new Set();
  for (const raw of seenIds || []) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) ids.add(n);
  }
  for (const tab of queriedTabs || []) {
    const n = tab && tab.id;
    if (Number.isInteger(n) && n >= 0) ids.add(n);
  }
  return [...ids];
}
