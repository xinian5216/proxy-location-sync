/**
 * 环境一致性诊断（纯函数）。
 * 判断模块之间是否互相矛盾，而不是「像不像某国用户」。
 * zh-CN / 中文字体 / Windows 都不是泄漏。
 */

import {
  DIAG_STATUS,
  GEO_CITY_ACCURACY_M,
  GEO_CITY_OK_KM,
  GEO_CITY_WARN_KM,
  GEO_CONSISTENCY_OK_KM,
  GEO_CONSISTENCY_WARN_KM,
} from "./constants.js";
import { haversineKm } from "./geo.js";
import { getOffsetMinutes } from "./timezone.js";
import { ipsEqual, isValidIpLiteral } from "./ip-compare.js";

export const CJK_FONTS = Object.freeze([
  "Microsoft YaHei",
  "SimSun",
  "SimHei",
  "PingFang SC",
  "Noto Sans CJK SC",
]);

const CN_ISP = /china\s*telecom|chinanet|chinaunicom|china\s*unicom|china\s*mobile|\bcmcc\b|cncgroup|as4134|as4837|as9808|as56040|as24400/i;

const PUBLIC_DNS = [
  { re: /cloudflare/i, ips: ["1.1.1.1", "1.0.0.1"] },
  { re: /google/i, ips: ["8.8.8.8", "8.8.4.4", "8.8.8.4"] },
  { re: /quad9/i, ips: ["9.9.9.9", "149.112.112.112"] },
  { re: /nextdns/i, ips: [] },
  { re: /opendns|cisco/i, ips: ["208.67.222.222", "208.67.220.220"] },
  { re: /adguard/i, ips: [] },
  { re: /mullvad/i, ips: [] },
  { re: /\bdns0\b/i, ips: [] },
  { re: /control\s*d/i, ips: [] },
];

export function isPublicAnycastDns(resolver = {}) {
  const org = `${resolver.org || ""} ${resolver.asn || ""} ${resolver.isp || ""}`;
  const ip = String(resolver.ip || "");
  for (const p of PUBLIC_DNS) {
    if (p.re.test(org)) return true;
    if (ip && p.ips.some((x) => ipsEqual(x, ip))) return true;
  }
  return false;
}

export function isChinaMainlandIsp(resolver = {}) {
  const org = `${resolver.org || ""} ${resolver.asn || ""} ${resolver.isp || ""}`;
  return CN_ISP.test(org);
}

export function statusMark(status) {
  if (status === DIAG_STATUS.ok) return "✓";
  if (status === DIAG_STATUS.warning) return "⚠";
  if (status === DIAG_STATUS.error) return "✕";
  if (status === DIAG_STATUS.pending) return "…";
  return "?";
}

export function utcOffsetLabel(offsetMin) {
  if (!Number.isFinite(offsetMin)) return "—";
  const sign = offsetMin <= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m ? `UTC${sign}${h}:${String(m).padStart(2, "0")}` : `UTC${sign}${h}`;
}

/** 最新检测到的公网出口（Geo 可能尚未 commit）。 */
export function detectedExitIp(state = {}) {
  return (state && (state.pendingIp || state.ip)) || "";
}

/** 已完成 Geo commit 的出口。 */
export function committedGeoIp(state = {}) {
  return (state && state.ip) || "";
}

export function isSwitchingExit(state = {}) {
  const detected = detectedExitIp(state);
  const committed = committedGeoIp(state);
  return !!(detected && committed && detected !== committed);
}

export function stableDnsResolvers(resolvers = []) {
  return [...(Array.isArray(resolvers) ? resolvers : [])]
    .map((r) => ({
      ip: r && r.ip ? String(r.ip) : "",
      countryCode: String((r && (r.countryCode || r.country)) || "").toUpperCase(),
      org: String((r && (r.org || r.asn || r.isp)) || ""),
    }))
    .sort((a, b) => {
      const ka = `${a.ip}|${a.countryCode}|${a.org}`;
      const kb = `${b.ip}|${b.countryCode}|${b.org}`;
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return 0;
    });
}

export function usableDnsResolvers(resolvers = []) {
  return (Array.isArray(resolvers) ? resolvers : []).filter((r) => r && isValidIpLiteral(r.ip));
}

export function isDnsTechnicalFailure(dns) {
  if (!dns) return true;
  if (dns.technicalFailure) return true;
  if (dns.timedOut || dns.error) return true;
  if (usableDnsResolvers(dns.resolvers).length === 0) return true;
  return false;
}

export function evaluateNetwork(exit = {}) {
  const detectedIp = exit.detectedIp || exit.ip || "";
  const committedIp = Object.prototype.hasOwnProperty.call(exit, "committedGeoIp")
    ? exit.committedGeoIp || ""
    : exit.ip || "";
  const switching = !!(exit.switching || (detectedIp && committedIp && detectedIp !== committedIp));
  const geoPending = switching || !committedIp;

  if (!detectedIp) {
    return {
      ip: "",
      detectedIp: "",
      committedGeoIp: committedIp,
      switching: false,
      country: "",
      city: "",
      timezone: "",
      status: DIAG_STATUS.pending,
      note: "尚未检测到公网出口",
    };
  }

  if (geoPending) {
    return {
      ip: detectedIp,
      detectedIp,
      committedGeoIp: committedIp,
      switching,
      country: "",
      countryCode: "",
      city: "",
      timezone: "",
      isp: "",
      status: DIAG_STATUS.pending,
      note: switching
        ? `新出口 ${detectedIp} 已检测到，地理尚未就绪（已同步定位对应 ${committedIp}）`
        : "地理尚未就绪",
    };
  }

  return {
    ip: detectedIp,
    detectedIp,
    committedGeoIp: committedIp || detectedIp,
    switching: false,
    country: exit.country || "",
    countryCode: exit.countryCode || "",
    city: exit.city || "",
    timezone: exit.timezone || "",
    isp: exit.isp || "",
    status: exit.echoStale ? DIAG_STATUS.warning : DIAG_STATUS.ok,
    note: exit.echoStale ? "出口检测失联，以下为上次已知出口" : "",
  };
}

export function evaluateGeolocation({
  ip = {},
  virtual = {},
  page = null,
  locationMode = "raw",
  switching = false,
  detectedIp = "",
  committedGeoIp = "",
} = {}) {
  if (switching) {
    return {
      latitude: virtual.latitude,
      longitude: virtual.longitude,
      country: virtual.country || "",
      city: virtual.city || "",
      status: DIAG_STATUS.pending,
      consistency: "pending",
      distanceKm: Number.NaN,
      locationMode,
      detectedIp,
      committedGeoIp,
      note: `已同步定位对应 ${committedGeoIp}；正在等待 ${detectedIp} 的地理`,
    };
  }
  if (!Number.isFinite(ip.latitude) || !Number.isFinite(ip.longitude)) {
    return {
      latitude: virtual.latitude,
      longitude: virtual.longitude,
      country: virtual.country || ip.country || "",
      city: virtual.city || ip.city || "",
      status: DIAG_STATUS.pending,
      consistency: "pending",
      distanceKm: Number.NaN,
      note: "地理尚未就绪",
    };
  }
  const vLat = Number.isFinite(virtual.latitude) ? virtual.latitude : ip.latitude;
  const vLng = Number.isFinite(virtual.longitude) ? virtual.longitude : ip.longitude;
  const dist = haversineKm(ip.latitude, ip.longitude, vLat, vLng);
  const pageDist =
    page && Number.isFinite(page.latitude) && Number.isFinite(page.longitude)
      ? haversineKm(vLat, vLng, page.latitude, page.longitude)
      : Number.NaN;

  const ipCc = String(ip.countryCode || "").toUpperCase();
  const vCc = String(virtual.countryCode || ipCc).toUpperCase();
  const countryMismatch = ipCc && vCc && ipCc !== vCc;

  const cityLevel =
    Number(virtual.accuracy) >= GEO_CITY_ACCURACY_M || Number(ip.accuracy) >= GEO_CITY_ACCURACY_M;
  const okKm = cityLevel ? GEO_CITY_OK_KM : locationMode === "jitter" ? Math.max(GEO_CONSISTENCY_OK_KM, 8) : GEO_CONSISTENCY_OK_KM;
  const warnKm = cityLevel ? GEO_CITY_WARN_KM : GEO_CONSISTENCY_WARN_KM;

  let status = DIAG_STATUS.ok;
  let consistency = "match";
  let note = "";
  if (countryMismatch) {
    status = DIAG_STATUS.error;
    consistency = "country mismatch";
    note = `出口在 ${ip.country || ipCc}，虚拟定位在 ${virtual.country || vCc}`;
  } else if (Number.isFinite(dist) && dist > warnKm) {
    status = DIAG_STATUS.error;
    consistency = "cross-region";
    note = `虚拟坐标距 IP 地理约 ${dist.toFixed(0)} km`;
  } else if (Number.isFinite(dist) && dist > okKm) {
    status = DIAG_STATUS.warning;
    consistency = "offset";
    note = `虚拟坐标距 IP 地理约 ${dist.toFixed(1)} km`;
  }

  if (Number.isFinite(pageDist) && pageDist > warnKm && status !== DIAG_STATUS.error) {
    status = DIAG_STATUS.error;
    consistency = "page mismatch";
    note = "网页 Geolocation 与扩展状态不一致，可能存在脚本覆盖或注入失败。";
  }

  return {
    latitude: vLat,
    longitude: vLng,
    country: virtual.country || ip.country || "",
    city: virtual.city || ip.city || "",
    status,
    consistency,
    distanceKm: dist,
    locationMode,
    note,
  };
}

export function evaluateTimezone({
  expected,
  intlTimezone,
  actualOffsetMin,
  now = Date.now(),
  switching = false,
} = {}) {
  const waiting = switching ? "上次虚拟时区（等待新地理）。" : "";
  if (!expected) {
    return {
      expected: "",
      intlTimezone: intlTimezone || "",
      utcOffset: actualOffsetMin,
      expectedOffset: Number.NaN,
      status: DIAG_STATUS.pending,
      note: switching ? waiting : "尚无虚拟时区",
    };
  }
  const expectedOffset = getOffsetMinutes(expected, new Date(now));
  const hasIntl = !!(intlTimezone && String(intlTimezone));
  const ianaMatch = hasIntl && intlTimezone === expected;
  const offsetMatch =
    Number.isFinite(actualOffsetMin) &&
    Number.isFinite(expectedOffset) &&
    actualOffsetMin === expectedOffset;

  const withWait = (note) => {
    if (!waiting) return note || "";
    if (!note) return waiting;
    if (note.includes("等待新地理")) return note;
    return `${note} ${waiting}`;
  };

  if (!hasIntl) {
    return {
      expected,
      intlTimezone: "",
      utcOffset: actualOffsetMin,
      expectedOffset,
      status: DIAG_STATUS.ok,
      note: withWait("尚未探测网页 Intl；扩展页本身不受 MAIN world patch"),
    };
  }
  if (ianaMatch && (offsetMatch || !Number.isFinite(actualOffsetMin))) {
    return {
      expected,
      intlTimezone,
      utcOffset: actualOffsetMin,
      expectedOffset,
      status: DIAG_STATUS.ok,
      note: withWait(""),
    };
  }
  if (ianaMatch && !offsetMatch) {
    return {
      expected,
      intlTimezone,
      utcOffset: actualOffsetMin,
      expectedOffset,
      status: DIAG_STATUS.error,
      note: withWait("IANA 时区名称一致，但当前 UTC offset 不一致（可能 DST 未同步）。"),
    };
  }
  if (!ianaMatch && offsetMatch) {
    return {
      expected,
      intlTimezone,
      utcOffset: actualOffsetMin,
      expectedOffset,
      status: DIAG_STATUS.warning,
      note: withWait("时区名称不同，但当前 UTC offset 一致。"),
    };
  }
  return {
    expected,
    intlTimezone,
    utcOffset: actualOffsetMin,
    expectedOffset,
    status: DIAG_STATUS.error,
    note: withWait("页面环境与扩展状态不一致，可能存在脚本覆盖或注入失败。"),
  };
}

export function evaluateWebRtc(webrtc = {}, exitIp = "") {
  const statusRaw = webrtc.status || DIAG_STATUS.unknown;
  const ips = webrtc.publicIps || webrtc.ips || [];
  if (statusRaw === "leak") {
    return {
      status: DIAG_STATUS.error,
      ips,
      checkedForIp: webrtc.checkedForIp || "",
      note: webrtc.reason || "STUN 公网 IP 与 HTTP 出口不一致",
    };
  }
  if (statusRaw === "ok") {
    return {
      status: DIAG_STATUS.ok,
      ips,
      checkedForIp: webrtc.checkedForIp || exitIp,
      note: webrtc.reason || "",
    };
  }
  return {
    status: DIAG_STATUS.unknown,
    ips,
    checkedForIp: webrtc.checkedForIp || "",
    note: webrtc.reason || "没有足够 ICE 候选，不能认定无泄漏",
  };
}

export function evaluateDns(dns = {}, exit = {}) {
  const resolvers = usableDnsResolvers(dns.resolvers);
  const switching = !!(
    exit.switching ||
    (exit.detectedIp && exit.committedGeoIp && exit.detectedIp !== exit.committedGeoIp)
  );
  const exitCc = switching ? "" : String(exit.countryCode || "").toUpperCase();
  const detectedIp = exit.detectedIp || exit.ip || "";
  const base = {
    resolverCountry: "",
    resolverOrg: "",
    resolvers,
    provider: dns.provider || "",
    checkedAt: dns.checkedAt || 0,
    checkedForIp: dns.checkedForIp || detectedIp,
    technicalFailure: false,
  };
  if (dns.timedOut || dns.error) {
    return {
      ...base,
      status: DIAG_STATUS.unknown,
      consistency: "unknown",
      technicalFailure: true,
      note: dns.error || "DNS 探测失败或超时",
    };
  }
  if (!resolvers.length) {
    return {
      ...base,
      status: DIAG_STATUS.unknown,
      consistency: "unknown",
      technicalFailure: true,
      note: "未能观测到 resolver",
    };
  }

  const cnIsp = resolvers.filter(isChinaMainlandIsp);
  const countries = [
    ...new Set(
      resolvers
        .map((r) => String(r.countryCode || "").toUpperCase())
        .filter(Boolean),
    ),
  ];

  const ranked = stableDnsResolvers(resolvers);
  const primary = ranked[0] || {};
  base.resolverCountry = primary.countryCode || "";
  base.resolverOrg = primary.org || "";

  if (cnIsp.length && exitCc && exitCc !== "CN") {
    const org = cnIsp[0].org || cnIsp[0].asn || "China ISP";
    return {
      ...base,
      resolverOrg: org,
      resolverCountry: cnIsp[0].country || cnIsp[0].countryCode || "CN",
      status: DIAG_STATUS.warning,
      consistency: "mismatch",
      note: "DNS 环境可能与代理出口不一致。",
    };
  }
  if (resolvers.every(isPublicAnycastDns)) {
    return {
      ...base,
      status: DIAG_STATUS.unknown,
      consistency: "public-dns",
      note: "使用全球公共 DNS，无法仅凭地区判断是否泄漏。",
    };
  }
  if (exitCc && countries.length && countries.every((c) => c === exitCc)) {
    return {
      ...base,
      status: DIAG_STATUS.ok,
      consistency: "match",
      note: "",
    };
  }
  return {
    ...base,
    status: DIAG_STATUS.unknown,
    consistency: "unknown",
    note: "无法确定 DNS 是否与出口矛盾。",
  };
}

export function evaluateLocale(locale = {}) {
  const language = locale.language || "";
  const languages = locale.languages || (language ? [language] : []);
  const intlLocale = locale.intlLocale || "";
  return {
    language,
    languages,
    intlLocale,
    status: DIAG_STATUS.ok,
    label: localeLabel(language),
    note: language ? "用户语言偏好；不视为泄漏。" : "未能读取语言",
  };
}

export function localeLabel(language) {
  const s = String(language || "");
  if (/^zh[-_]?cn/i.test(s) || s.toLowerCase() === "zh") return "中国大陆中文";
  if (/^zh[-_]?tw/i.test(s)) return "台湾中文";
  if (/^zh[-_]?hk/i.test(s)) return "香港中文";
  if (/^ja/i.test(s)) return "日语";
  if (/^en/i.test(s)) return "英语";
  return s || "未知";
}

export function evaluateFonts(detected = []) {
  const names = Array.isArray(detected) ? detected : [];
  const cjk = CJK_FONTS.filter((n) => names.includes(n));
  return {
    detected: names,
    cjk,
    status: DIAG_STATUS.ok,
    note: cjk.length
      ? "这可能反映设备语言/操作系统环境，但不代表代理泄漏。"
      : "未检测到列表中的中文字体。",
  };
}

export function detectListedFonts(names = CJK_FONTS, api = globalThis) {
  const found = [];
  const fonts = api.document && api.document.fonts;
  if (fonts && typeof fonts.check === "function") {
    for (const n of names) {
      try {
        if (fonts.check(`16px "${n}"`)) found.push(n);
      } catch {
        /* ignore */
      }
    }
  }
  return found;
}

export function evaluateWorker({ mainTimezone, worker } = {}) {
  if (!worker || worker.ok === false) {
    return {
      status: DIAG_STATUS.unknown,
      mainTimezone: mainTimezone || "",
      workerTimezone: "",
      note: worker && worker.reason ? worker.reason : "未能探测 Worker",
    };
  }
  const wt = worker.timezone || "";
  if (mainTimezone && wt && wt !== mainTimezone) {
    return {
      status: DIAG_STATUS.warning,
      mainTimezone,
      workerTimezone: wt,
      note: "网页 Worker 不受 MAIN world patch 控制，这是浏览器扩展方案的已知限制。",
    };
  }
  return {
    status: DIAG_STATUS.ok,
    mainTimezone: mainTimezone || "",
    workerTimezone: wt,
    note: "",
  };
}

export function evaluateEnvironment(env = {}) {
  return {
    platform: env.platform || "",
    userAgent: env.userAgent || "",
    uaData: env.uaData || null,
    fonts: env.fonts || [],
    notes: "只读。不修改 UA / 平台 / 字体。",
  };
}

export function collectBrowserEnvironment() {
  const nav = globalThis.navigator || {};
  let uaData = null;
  try {
    const uad = nav.userAgentData;
    if (uad) {
      uaData = {
        platform: uad.platform || "",
        mobile: !!uad.mobile,
        brands: Array.isArray(uad.brands)
          ? uad.brands.map((b) => `${b.brand} ${b.version || ""}`.trim())
          : [],
      };
    }
  } catch {
    /* ignore */
  }
  let intlLocale = "";
  try {
    intlLocale = Intl.DateTimeFormat().resolvedOptions().locale || "";
  } catch {
    /* ignore */
  }
  return {
    locale: {
      language: nav.language || "",
      languages: Array.from(nav.languages || []),
      intlLocale,
    },
    environment: {
      platform: nav.platform || "",
      userAgent: nav.userAgent || "",
      uaData,
      fonts: [],
    },
  };
}

export function evaluateOverall(parts) {
  const issues = [];
  const warnings = [];
  const infos = [];
  const push = (item, bucket) => {
    if (item && item.note) bucket.push(item.note);
    else if (item && item.label) bucket.push(item.label);
  };

  if (parts.geolocation && parts.geolocation.status === DIAG_STATUS.error) push(parts.geolocation, issues);
  if (parts.timezone && parts.timezone.status === DIAG_STATUS.error) push(parts.timezone, issues);
  if (parts.webrtc && parts.webrtc.status === DIAG_STATUS.error) push(parts.webrtc, issues);
  if (parts.network && parts.network.status === DIAG_STATUS.error) push(parts.network, issues);
  if (
    parts.patch &&
    parts.patch.status === DIAG_STATUS.error &&
    !(parts.timezone && parts.timezone.status === DIAG_STATUS.error)
  ) {
    push(parts.patch, issues);
  }

  if (parts.geolocation && parts.geolocation.status === DIAG_STATUS.warning) push(parts.geolocation, warnings);
  if (parts.timezone && parts.timezone.status === DIAG_STATUS.warning) push(parts.timezone, warnings);
  if (parts.dns && parts.dns.status === DIAG_STATUS.warning) push(parts.dns, warnings);
  if (parts.worker && parts.worker.status === DIAG_STATUS.warning) push(parts.worker, warnings);
  if (parts.network && parts.network.status === DIAG_STATUS.warning) push(parts.network, warnings);
  if (parts.webrtc && parts.webrtc.status === DIAG_STATUS.warning) push(parts.webrtc, warnings);

  if (parts.locale && parts.locale.language) {
    infos.push(`语言环境：${parts.locale.label || parts.locale.language}`);
  }
  if (parts.fonts && parts.fonts.cjk && parts.fonts.cjk.length) {
    infos.push("中文字体环境：Detected");
  }

  let status = DIAG_STATUS.ok;
  let label = "Good";
  if (issues.length) {
    status = DIAG_STATUS.error;
    label = "Needs attention";
  } else if (warnings.length) {
    status = DIAG_STATUS.warning;
    label = "Needs attention";
  } else if (parts.network && parts.network.switching) {
    status = DIAG_STATUS.pending;
    label = "Switching";
  } else if (parts.network && parts.network.status === DIAG_STATUS.pending && !parts.network.ip) {
    status = DIAG_STATUS.pending;
    label = "Checking";
  }

  return { status, label, issues, warnings, infos };
}

export function buildDiagnostics(input = {}) {
  const exit = input.exit || {};
  const virtual = input.virtual || {};
  const pageRaw = input.page || null;
  let page = pageRaw;
  if (pageRaw && Object.prototype.hasOwnProperty.call(pageRaw, "worker")) {
    page = { ...pageRaw };
    delete page.worker;
  }
  const detectedIp = exit.detectedIp || exit.ip || "";
  const committedGeoIp = Object.prototype.hasOwnProperty.call(exit, "committedGeoIp")
    ? exit.committedGeoIp || ""
    : exit.ip || "";
  const switching = !!(
    exit.switching ||
    (detectedIp && committedGeoIp && detectedIp !== committedGeoIp)
  );
  const exitForEval = { ...exit, detectedIp, committedGeoIp, switching };
  const network = evaluateNetwork(exitForEval);
  const geolocation = evaluateGeolocation({
    ip: switching ? {} : exit,
    virtual,
    page: switching ? null : page,
    locationMode: input.locationMode || "raw",
    switching,
    detectedIp,
    committedGeoIp,
  });
  const timezone = evaluateTimezone({
    expected: virtual.timezone || (!switching && exit.timezone),
    intlTimezone: page && page.timezone,
    actualOffsetMin: page && page.offsetMin,
    now: input.now,
    switching,
  });
  const webrtc = evaluateWebRtc(input.webrtc || {}, committedGeoIp || detectedIp);
  const dns = evaluateDns(input.dns || {}, exitForEval);
  const locale = evaluateLocale(
    input.locale ||
      (page && { language: page.language, languages: page.languages, intlLocale: page.locale }) ||
      {},
  );
  const fonts = evaluateFonts((input.environment && input.environment.fonts) || []);
  const worker = evaluateWorker({
    mainTimezone: (page && page.timezone) || virtual.timezone,
    worker: input.worker,
  });
  const environment = evaluateEnvironment(input.environment || {});
  const patch = evaluatePatch(virtual, page);
  const overall = evaluateOverall({ network, geolocation, timezone, webrtc, dns, locale, fonts, worker, patch });
  return {
    network,
    geolocation,
    timezone,
    webrtc,
    dns,
    locale,
    environment,
    fonts,
    worker,
    patch,
    overall,
    checkedAt: input.now || Date.now(),
  };
}

export function evaluatePatch(virtual = {}, page = null) {
  const caveat = "Patch 自检是 best-effort，不是安全证明。恶意页面伪造 PAGE_ENV 可能欺骗该项。";
  if (!page) {
    return {
      status: DIAG_STATUS.unknown,
      bestEffort: true,
      note: `没有可探测的 http(s) 网页。扩展页本身不受 MAIN world patch。${caveat}`,
    };
  }
  if (page.patchAlive === false) {
    return {
      status: DIAG_STATUS.error,
      bestEffort: true,
      note: `页面环境与扩展状态不一致，可能存在脚本覆盖或注入失败。${caveat}`,
      geoMode: page.geoMode || "",
      htmlGeo: !!page.htmlGeo,
    };
  }
  const tz = evaluateTimezone({
    expected: virtual.timezone,
    intlTimezone: page.timezone,
    actualOffsetMin: page.offsetMin,
  });
  if (tz.status === DIAG_STATUS.error) {
    return {
      status: DIAG_STATUS.error,
      bestEffort: true,
      note: `页面环境与扩展状态不一致，可能存在脚本覆盖或注入失败。${caveat}`,
      geoMode: page.geoMode || "",
      htmlGeo: !!page.htmlGeo,
    };
  }
  return {
    status: tz.status === DIAG_STATUS.warning ? DIAG_STATUS.warning : DIAG_STATUS.ok,
    bestEffort: true,
    note:
      tz.status === DIAG_STATUS.ok
        ? `MAIN world patch 与扩展状态一致。${caveat}`
        : `${tz.note} ${caveat}`,
    geoMode: page.geoMode || "",
    htmlGeo: !!page.htmlGeo,
  };
}

export function diagnosticsFingerprint(diag) {
  if (!diag) return "";
  const pick = (o) => {
    if (!o) return null;
    const { checkedAt, ...rest } = o;
    void checkedAt;
    return rest;
  };
  const dns = diag.dns || {};
  return JSON.stringify({
    overall: pick(diag.overall),
    network: pick(diag.network),
    geolocation: pick(diag.geolocation),
    timezone: pick(diag.timezone),
    webrtc: pick(diag.webrtc),
    dns: {
      status: dns.status,
      consistency: dns.consistency,
      resolverOrg: dns.resolverOrg,
      resolverCountry: dns.resolverCountry,
      checkedForIp: dns.checkedForIp,
      provider: dns.provider,
      technicalFailure: !!dns.technicalFailure,
      resolvers: stableDnsResolvers(dns.resolvers),
    },
    locale: pick(diag.locale),
    worker: pick(diag.worker),
    patch: pick(diag.patch),
  });
}

export async function runIsolated(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}
