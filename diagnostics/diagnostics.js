import { MSG } from "../lib/constants.js";
import {
  CJK_FONTS,
  collectBrowserEnvironment,
  detectListedFonts,
  statusMark,
  utcOffsetLabel,
} from "../lib/diagnostics.js";

const $ = (id) => document.getElementById(id);

const ui = {
  overall: $("overall"),
  summary: $("summary"),
  net: $("net-facts"),
  geo: $("geo-facts"),
  tz: $("tz-facts"),
  rtc: $("rtc-facts"),
  dns: $("dns-facts"),
  env: $("env-facts"),
  adv: $("adv-facts"),
  rerun: $("rerun"),
  options: $("options"),
};

let snapshot = { diagnostics: null, state: null, settings: null };

init();

async function init() {
  ui.rerun.addEventListener("click", rerun);
  ui.options.addEventListener("click", () => chrome.runtime.sendMessage({ type: MSG.OPEN_OPTIONS }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.diagnostics) snapshot.diagnostics = changes.diagnostics.newValue;
    if (changes.state) snapshot.state = changes.state.newValue;
    render();
  });
  snapshot = await chrome.runtime.sendMessage({ type: MSG.GET_SNAPSHOT });
  render();
}

async function rerun() {
  ui.rerun.disabled = true;
  ui.rerun.textContent = "诊断中…";
  try {
    const local = collectBrowserEnvironment();
    local.environment.fonts = detectListedFonts(CJK_FONTS);
    snapshot = await chrome.runtime.sendMessage({
      type: MSG.DIAGNOSTICS_RUN,
      locale: local.locale,
      environment: local.environment,
    });
    render();
  } finally {
    ui.rerun.disabled = false;
    ui.rerun.textContent = "重新诊断";
  }
}

function render() {
  const d = snapshot.diagnostics;
  const state = snapshot.state || {};
  if (!d) {
    ui.overall.textContent = "尚未诊断";
    ui.overall.className = "overall pending";
    ui.summary.textContent = "点击「重新诊断」读取当前出口、网页环境与 DNS。";
    return;
  }

  const overall = d.overall || {};
  ui.overall.textContent = overall.label || "—";
  ui.overall.className = `overall ${overall.status || "unknown"}`;
  const bits = [];
  (overall.issues || []).forEach((x) => bits.push(`问题：${x}`));
  (overall.warnings || []).forEach((x) => bits.push(`注意：${x}`));
  (overall.infos || []).forEach((x) => bits.push(x));
  ui.summary.textContent = bits.join("  ·  ") || "没有发现模块之间的明显矛盾。";

  const net = d.network || {};
  if (net.switching) {
    fill(ui.net, [
      row(net, "Current detected exit", net.detectedIp || net.ip),
      row(net, "Synced Geo belongs to", net.committedGeoIp),
      row(net, "Status", net.committedGeoIp ? `Waiting for Geo ${net.detectedIp}` : "Waiting for Geo"),
      row(net, "Note", net.note, true),
    ]);
  } else {
    fill(ui.net, [
      row(net, "Public IP", net.ip),
      row(net, "ASN / ISP", net.isp || (state.isp || "—")),
      row(net, "Country", join(net.country, net.countryCode)),
      row(net, "City", net.city),
      row(net, "Note", net.note, true),
    ]);
  }

  const dist = d.geolocation && Number.isFinite(d.geolocation.distanceKm)
    ? `${d.geolocation.distanceKm.toFixed(1)} km`
    : "—";
  if (net.switching) {
    fill(ui.geo, [
      row(d.geolocation, "Synced Geo belongs to", net.committedGeoIp),
      row(d.geolocation, "Virtual Location", formatCoords(d.geolocation && d.geolocation.latitude, d.geolocation && d.geolocation.longitude)),
      row(d.geolocation, "Status", `Waiting for Geo ${net.detectedIp}`),
      row(d.geolocation, "Note", d.geolocation && d.geolocation.note, true),
    ]);
  } else {
    fill(ui.geo, [
      row(d.geolocation, "IP Location", join(net.country, net.city)),
      row(d.geolocation, "Virtual Location", formatCoords(d.geolocation && d.geolocation.latitude, d.geolocation && d.geolocation.longitude)),
      row(d.geolocation, "Distance", dist),
      row(d.geolocation, "Location mode", (d.geolocation && d.geolocation.locationMode) || (snapshot.settings && snapshot.settings.locationMode) || "raw"),
      row(d.geolocation, "Consistency", d.geolocation && d.geolocation.consistency),
      row(d.geolocation, "Note", d.geolocation && d.geolocation.note, true),
    ]);
  }

  fill(ui.tz, [
    row(d.timezone, net.switching ? "Last virtual timezone" : "Expected timezone", d.timezone && d.timezone.expected),
    row(d.timezone, "Intl timezone", d.timezone && d.timezone.intlTimezone),
    row(d.timezone, "Expected UTC offset", utcOffsetLabel(d.timezone && d.timezone.expectedOffset)),
    row(d.timezone, "Actual UTC offset", utcOffsetLabel(d.timezone && d.timezone.utcOffset)),
    row(d.timezone, "Note", d.timezone && d.timezone.note, true),
  ]);

  const ips = d.webrtc && Array.isArray(d.webrtc.ips) ? d.webrtc.ips.join(", ") : "";
  fill(ui.rtc, [
    row(d.webrtc, "Status", rtcLabel(d.webrtc)),
    row(d.webrtc, "Detected IPs", ips || "—"),
    row(d.webrtc, "Expected public IP", (d.webrtc && d.webrtc.checkedForIp) || (d.network && d.network.committedGeoIp) || state.ip || "—"),
    row(d.webrtc, "Note", d.webrtc && d.webrtc.note, true),
  ]);

  const resolvers = (d.dns && d.dns.resolvers) || [];
  const resolverIps = resolvers.map((r) => r.ip).filter(Boolean).join(", ");
  fill(ui.dns, [
    row(d.dns, "Checked for", d.dns && d.dns.checkedForIp),
    row(d.dns, "Resolver IP", resolverIps || "—"),
    row(d.dns, "Resolver provider", (d.dns && (d.dns.resolverOrg || d.dns.provider)) || "—"),
    row(d.dns, "Resolver country", d.dns && d.dns.resolverCountry),
    row(d.dns, "Consistency", d.dns && d.dns.consistency),
    row(d.dns, "Checked at", formatTime(d.dns && d.dns.checkedAt)),
    row(d.dns, "Note", d.dns && d.dns.note, true),
  ]);

  const env = d.environment || {};
  const uaData = env.uaData;
  fill(ui.env, [
    infoRow("navigator.language", d.locale && d.locale.language),
    infoRow("navigator.languages", ((d.locale && d.locale.languages) || []).join(", ")),
    infoRow("Intl locale", d.locale && d.locale.intlLocale),
    infoRow("Language label", d.locale && d.locale.label),
    infoRow("Platform", env.platform),
    infoRow("UA", env.userAgent),
    infoRow("UA-CH", uaData ? `${uaData.platform || ""} ${uaData.mobile ? "mobile" : ""} ${(uaData.brands || []).join(", ")}`.trim() : "—"),
    infoRow("Note", (d.locale && d.locale.note) || env.notes, true),
  ]);

  const fonts = d.fonts || {};
  fill(ui.adv, [
    infoRow("Detected fonts", (fonts.detected || []).join(", ") || "未检测（打开本页点重新诊断）"),
    infoRow("中文字体环境", fonts.cjk && fonts.cjk.length ? "Detected" : "Not listed"),
    row(d.worker, "Main timezone", d.worker && d.worker.mainTimezone),
    row(d.worker, "Worker timezone", d.worker && d.worker.workerTimezone),
    row(d.worker, "Worker note", d.worker && d.worker.note, true),
    row(d.patch, "MAIN world", d.patch && d.patch.note, true),
    infoRow("Patch self-check", "best-effort（不是安全证明）"),
    infoRow("HTMLGeolocationElement", d.patch && d.patch.htmlGeo ? "present" : "not in this page"),
    infoRow("geoMode (page)", d.patch && d.patch.geoMode),
    infoRow("Canvas", canvasAvailable() ? "available" : "n/a"),
    infoRow("WebGL", readWebGl()),
  ]);
}

function fill(dl, items) {
  dl.replaceChildren();
  for (const item of items) {
    const dt = document.createElement("dt");
    dt.textContent = item.label;
    const dd = document.createElement("dd");
    if (item.wrap) dd.className = "wrap";
    if (item.mark) {
      const mark = document.createElement("span");
      mark.className = `mark ${item.status || "unknown"}`;
      mark.textContent = item.mark;
      dd.appendChild(mark);
    }
    dd.appendChild(document.createTextNode(item.value || "—"));
    dl.append(dt, dd);
  }
}

function row(part, label, value, wrap = false) {
  const status = (part && part.status) || "unknown";
  return { label, value: value || "—", status, mark: statusMark(status), wrap };
}

function infoRow(label, value, wrap = false) {
  return { label, value: value || "—", status: "info", mark: "ℹ", wrap };
}

function join(a, b) {
  if (a && b && a !== b) return `${a}  ${b}`;
  return a || b || "—";
}

function formatCoords(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "—";
  return `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
}

function formatTime(ts) {
  if (!Number.isFinite(ts) || !ts) return "—";
  try {
    return new Date(ts).toISOString();
  } catch {
    return "—";
  }
}

function rtcLabel(w) {
  if (!w) return "—";
  if (w.status === "ok") return "OK";
  if (w.status === "error") return "Possible leak";
  return "Unknown";
}

function canvasAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext && c.getContext("2d"));
  } catch {
    return false;
  }
}

function readWebGl() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl) return "unavailable";
    const ext = gl.getExtension && gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return [vendor, renderer].filter(Boolean).join(" · ") || "available";
  } catch {
    return "unavailable";
  }
}
