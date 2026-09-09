import { INTERVAL_CHOICES, MSG, STORAGE_KEYS } from "../lib/constants.js";
import { viewWebRtc } from "../lib/webrtc.js";

const $ = (id) => document.getElementById(id);
let snapshot = { settings: {}, state: null };

init();

async function init() {
  INTERVAL_CHOICES.forEach((sec) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.interval = String(sec);
    btn.textContent = `${sec} 秒`;
    btn.addEventListener("click", () => patch({ intervalSec: sec }));
    $("interval").appendChild(btn);
  });

  $("mode").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => patch({ locationMode: btn.dataset.mode }));
  });

  $("enabled").addEventListener("change", () => patch({ enabled: $("enabled").checked }));
  $("webrtcProbe").addEventListener("change", () => patch({ webrtcProbe: $("webrtcProbe").checked }));
  $("detect").addEventListener("click", () => chrome.runtime.sendMessage({ type: MSG.DETECT_NOW }).then(apply));
  $("resync").addEventListener("click", () => chrome.runtime.sendMessage({ type: MSG.RESYNC }).then(apply));
  $("clear").addEventListener("click", async () => {
    await chrome.storage.local.set({ [STORAGE_KEYS.geoCache]: {} });
    apply(await chrome.runtime.sendMessage({ type: MSG.RESYNC }));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.state) snapshot.state = changes.state.newValue;
    if (changes.settings) snapshot.settings = { ...snapshot.settings, ...changes.settings.newValue };
    render();
  });

  apply(await chrome.runtime.sendMessage({ type: MSG.GET_SNAPSHOT }));
}

function apply(next) {
  snapshot = next;
  render();
}

async function patch(partial) {
  apply(await chrome.runtime.sendMessage({ type: MSG.SETTINGS_PATCH, patch: partial }));
}

function render() {
  const { settings, state } = snapshot;
  $("enabled").checked = !!(settings && settings.enabled);
  $("webrtcProbe").checked = !!(settings && settings.webrtcProbe);

  $("interval").querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("on", Number(btn.dataset.interval) === Number(settings.intervalSec));
  });
  $("mode").querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.mode === settings.locationMode);
  });

  const facts = [
    ["公网 IP", state && state.ip],
    ["待同步 IP", state && state.pendingIp && state.pendingIp !== state.ip ? state.pendingIp : ""],
    ["地理状态", state && state.geoStatus],
    ["国家", state && [state.country, state.countryCode].filter(Boolean).join(" / ")],
    ["城市", state && [state.city, state.region].filter(Boolean).join(" / ")],
    ["坐标", state && Number.isFinite(state.latitude) ? `${state.latitude.toFixed(5)}, ${state.longitude.toFixed(5)}` : ""],
    ["原始坐标", state && Number.isFinite(state.rawLatitude) ? `${state.rawLatitude.toFixed(5)}, ${state.rawLongitude.toFixed(5)}` : ""],
    ["精度", state && state.accuracy ? `${Math.round(state.accuracy)} m` : ""],
    ["时区", state && state.timezone],
    ["地理数据源", state && state.provider],
    ["IP 数据源", state && state.echoProvider],
    ["上次错误", state && state.lastError],
  ];

  const box = $("facts");
  box.replaceChildren();
  for (const [k, v] of facts) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v || "—";
    box.append(dt, dd);
  }

  const w = viewWebRtc(state);
  const bits = [
    !state || !state.ip ? "" : w.status === "ok" ? "正常" : w.status === "leak" ? "可能泄漏" : "未知",
    w.reason,
    w.checkedForIp ? `绑定出口 ${w.checkedForIp}` : "",
    w.publicIps && w.publicIps.length ? `STUN 公网：${w.publicIps.join(", ")}` : "",
    w.localIps && w.localIps.length ? `本地候选：${w.localIps.join(", ")}` : "",
  ].filter(Boolean);
  $("webrtc-detail").textContent = bits.join(" · ") || "尚未探测。";
}
