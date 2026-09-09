import { INTERVAL_CHOICES, MSG } from "../lib/constants.js";
import { formatOffsetLabel, getOffsetMinutes } from "../lib/timezone.js";
import { viewWebRtc } from "../lib/webrtc.js";

const $ = (id) => document.getElementById(id);

const ui = {
  enabled: $("enabled"),
  syncLabel: $("sync-label"),
  error: $("error"),
  ip: $("ip"),
  ipMeta: $("ip-meta"),
  ipKicker: $("ip-kicker"),
  country: $("country"),
  city: $("city"),
  coords: $("coords"),
  accuracy: $("accuracy"),
  timezone: $("timezone"),
  offset: $("offset"),
  changed: $("changed"),
  interval: $("interval"),
  mode: $("mode"),
  webrtcDot: $("webrtc-dot"),
  webrtcStatus: $("webrtc-status"),
  webrtcReason: $("webrtc-reason"),
  detect: $("detect"),
  resync: $("resync"),
  options: $("options"),
};

let snapshot = { settings: { enabled: true, intervalSec: 3, locationMode: "raw" }, state: null };
let clock = null;

init();

async function init() {
  INTERVAL_CHOICES.forEach((sec) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.interval = String(sec);
    btn.textContent = `${sec} 秒`;
    btn.addEventListener("click", () => patch({ intervalSec: sec }));
    ui.interval.appendChild(btn);
  });

  ui.mode.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => patch({ locationMode: btn.dataset.mode }));
  });

  ui.enabled.addEventListener("change", () => patch({ enabled: ui.enabled.checked }));
  ui.detect.addEventListener("click", () => run(MSG.DETECT_NOW, ui.detect));
  ui.resync.addEventListener("click", () => run(MSG.RESYNC, ui.resync));
  ui.options.addEventListener("click", () => chrome.runtime.sendMessage({ type: MSG.OPEN_OPTIONS }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.state) snapshot.state = changes.state.newValue;
    if (changes.settings) snapshot.settings = { ...snapshot.settings, ...changes.settings.newValue };
    render();
  });

  snapshot = await chrome.runtime.sendMessage({ type: MSG.GET_SNAPSHOT });
  render();
  clock = setInterval(renderRelative, 1000);
}

async function patch(partial) {
  snapshot = await chrome.runtime.sendMessage({ type: MSG.SETTINGS_PATCH, patch: partial });
  render();
}

async function run(type, button) {
  button.disabled = true;
  try {
    snapshot = await chrome.runtime.sendMessage({ type });
    render();
  } finally {
    button.disabled = false;
  }
}

function render() {
  const { settings, state } = snapshot;
  ui.enabled.checked = !!(settings && settings.enabled);
  document.body.classList.toggle("disabled", !ui.enabled.checked);
  ui.syncLabel.textContent = ui.enabled.checked
    ? "自动同步已开启"
    : "已暂停自动同步（不会恢复系统定位）";

  ui.interval.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("on", Number(btn.dataset.interval) === Number(settings.intervalSec));
  });
  ui.mode.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.mode === settings.locationMode);
  });

  const pendingIp = state && state.pendingIp;
  const committedIp = state && state.ip;
  const switching = !!(pendingIp && committedIp && pendingIp !== committedIp);
  const stale = !!(state && state.echoStale);
  const geoPending = state && (state.geoStatus === "pending" || state.geoStatus === "error" || stale);
  const displayIp = pendingIp || committedIp;

  if (ui.ipKicker) {
    ui.ipKicker.textContent = switching ? "当前检测出口" : stale ? "上次已知出口" : "当前公网 IP";
  }

  if (!displayIp) {
    ui.ip.textContent = "检测中…";
    ui.ipMeta.textContent = "";
    ui.country.textContent = "—";
    ui.city.textContent = "—";
    ui.coords.textContent = "—";
    ui.accuracy.textContent = "";
    ui.timezone.textContent = "—";
    ui.offset.textContent = "";
  } else {
    ui.ip.textContent = displayIp;
    ui.ipMeta.textContent = metaLine(state, pendingIp, committedIp, geoPending, switching, stale);
    if (state && Number.isFinite(state.latitude)) {
      ui.country.textContent = join(state.country, state.countryCode);
      ui.city.textContent = join(state.city, state.region);
      ui.coords.textContent = formatCoords(state.latitude, state.longitude);
      if (switching) ui.accuracy.textContent = `已同步定位对应 IP：${committedIp}`;
      else if (stale) ui.accuracy.textContent = "出口检测失联，不再当作当前位置";
      else ui.accuracy.textContent = formatAccuracy(state);
      ui.timezone.textContent = state.timezone || "—";
      try {
        ui.offset.textContent = formatOffsetLabel(getOffsetMinutes(state.timezone));
      } catch {
        ui.offset.textContent = "";
      }
    } else {
      ui.country.textContent = "—";
      ui.city.textContent = "—";
      ui.coords.textContent = "—";
      ui.accuracy.textContent = "";
      ui.timezone.textContent = "—";
      ui.offset.textContent = "";
    }
  }

  if (stale) {
    ui.error.hidden = false;
    ui.error.textContent = "出口检测失联：无法确认当前公网 IP 是否已变。";
  } else if (state && state.lastError) {
    ui.error.hidden = false;
    ui.error.textContent = state.lastError;
  } else {
    ui.error.hidden = true;
  }

  renderRelative();
  renderWebRtc(viewWebRtc(state));
}

function metaLine(state, pendingIp, committedIp, geoPending, switching, stale) {
  const bits = [];
  if (state && state.isp && !switching) bits.push(state.isp);
  if (state && state.echoProvider) bits.push(`出口检测 ${state.echoProvider}`);
  if (stale) bits.push("失联");
  if (switching) {
    bits.push(`已同步定位对应 IP：${committedIp}`);
    bits.push(state && state.geoStatus === "error" ? "地理未就绪" : "地理正在同步");
  } else if (geoPending && pendingIp) {
    bits.push(state && state.geoStatus === "error" ? `地理未就绪 ${pendingIp}` : `地理查询中 ${pendingIp}`);
  } else if (!state || !state.ip) {
    bits.push("正在查询地理位置…");
  }
  return bits.join(" · ");
}

function renderRelative() {
  const at = snapshot.state && snapshot.state.ipChangedAt;
  ui.changed.textContent = at ? relative(at) : "—";
}

function renderWebRtc(w) {
  const status = (w && w.status) || "unknown";
  ui.webrtcDot.className = `dot ${status === "ok" ? "ok" : status === "leak" ? "leak" : "unknown"}`;
  ui.webrtcStatus.textContent =
    status === "ok" ? "正常" : status === "leak" ? "可能泄漏" : "未知";
  ui.webrtcReason.textContent = (w && w.reason) || "";
}

function formatCoords(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "—";
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

function formatAccuracy(state) {
  const bits = [];
  if (Number.isFinite(state.accuracy)) bits.push(`精度约 ${Math.round(state.accuracy)} 米`);
  if (state.offsetKm) bits.push(`城市内偏移 ${state.offsetKm.toFixed(1)} km`);
  return bits.join(" · ");
}

function join(a, b) {
  if (a && b && a !== b) return `${a}  ${b}`;
  return a || b || "—";
}

function relative(ts) {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) return "刚刚";
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时前`;
}
