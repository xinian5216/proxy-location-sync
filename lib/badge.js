/**
 * 工具栏国家代码角标。纯展示，不触发 Geo / storage。
 * SW 重建后必须从已 hydrate 的 state 恢复，不能等下一次 persist。
 */

export function badgeCountryCode(state, enabled) {
  if (!enabled || !state) return "";
  const countryCode = String(state.countryCode || "")
    .trim()
    .toUpperCase()
    .slice(0, 2);
  if (countryCode.length !== 2) return "";
  return countryCode;
}

export function badgeTitle(state, enabled) {
  if (!enabled || !state) return "Proxy Location Sync";
  return ["Proxy Location Sync", state.ip, [state.city, state.country].filter(Boolean).join(", "), state.timezone]
    .filter(Boolean)
    .join(" · ");
}

export async function updateBadge(action, state, enabled) {
  if (!action) return;
  try {
    const text = badgeCountryCode(state, enabled);
    if (!text) {
      await action.setBadgeText({ text: "" });
      await action.setTitle({ title: "Proxy Location Sync" });
      return;
    }
    await action.setBadgeBackgroundColor({ color: "#0f766e" });
    try {
      await action.setBadgeTextColor({ color: "#ecfdf5" });
    } catch {
      /* Edge */
    }
    await action.setBadgeText({ text });
    await action.setTitle({ title: badgeTitle(state, enabled) });
  } catch {
    /* ignore */
  }
}
