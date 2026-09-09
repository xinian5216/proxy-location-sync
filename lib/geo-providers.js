/**
 * 按 targetIp 显式查询地理位置。禁止用「当前连接 IP」推断，避免切节点竞态。
 * 响应里的 IP 必须与 targetIp 一致，否则丢弃该源。
 */

import { GEO_LOOKUP_TIMEOUT_MS } from "./constants.js";
import { ipsEqual } from "./ip-compare.js";
import { fetchWithTimeout } from "./net.js";
import { cooldownError, createProviderHealth } from "./provider-health.js";
import { isValidTimeZone } from "./timezone.js";

function pathIp(ip) {
  return String(ip).replace(/^\[|\]$/g, "");
}

const PROVIDERS = [
  {
    id: "ipwhois",
    urlFor: (ip) => `https://ipwho.is/${pathIp(ip)}`,
    parse: (j) => {
      if (j.success === false) throw new Error(j.message || "ipwho.is failed");
      return {
        ip: j.ip,
        country: j.country,
        countryCode: j.country_code,
        region: j.region,
        city: j.city,
        latitude: Number(j.latitude),
        longitude: Number(j.longitude),
        timezone: j.timezone && (j.timezone.id || j.timezone),
        isp: (j.connection && j.connection.isp) || "",
      };
    },
  },
  {
    id: "ipapi",
    urlFor: (ip) => `https://ipapi.co/${pathIp(ip)}/json/`,
    parse: (j) => {
      if (j.error) throw new Error(j.reason || "ipapi.co failed");
      return {
        ip: j.ip,
        country: j.country_name,
        countryCode: j.country_code || j.country,
        region: j.region,
        city: j.city,
        latitude: Number(j.latitude),
        longitude: Number(j.longitude),
        timezone: j.timezone,
        isp: j.org || "",
      };
    },
  },
  {
    id: "geojs",
    urlFor: (ip) => `https://get.geojs.io/v1/ip/geo/${pathIp(ip)}.json`,
    parse: (j) => ({
      ip: j.ip,
      country: j.country,
      countryCode: j.country_code,
      region: j.region,
      city: j.city,
      latitude: Number(j.latitude),
      longitude: Number(j.longitude),
      timezone: j.timezone,
      isp: j.organization || "",
    }),
  },
  {
    id: "ipquery",
    urlFor: (ip) => `https://api.ipquery.io/${pathIp(ip)}`,
    parse: (j) => {
      const loc = j.location || {};
      return {
        ip: j.ip,
        country: loc.country,
        countryCode: loc.country_code,
        region: loc.state || loc.region,
        city: loc.city,
        latitude: Number(loc.latitude),
        longitude: Number(loc.longitude),
        timezone: loc.timezone,
        isp: (j.isp && j.isp.isp) || "",
      };
    },
  },
  {
    id: "ipinfo",
    urlFor: (ip) => `https://ipinfo.io/${pathIp(ip)}/json`,
    parse: (j) => {
      const [lat, lng] = String(j.loc || ",").split(",");
      return {
        ip: j.ip,
        country: countryNameFromCode(j.country) || j.country,
        countryCode: j.country,
        region: j.region,
        city: j.city,
        latitude: Number(lat),
        longitude: Number(lng),
        timezone: j.timezone,
        isp: j.org || "",
      };
    },
  },
];

export const geoHealth = createProviderHealth();

export async function lookupGeo(targetIp, { signal, bypassCooldown = false } = {}) {
  if (!targetIp) throw new Error("lookupGeo requires targetIp");
  let lastError = "all geo providers failed";
  const ordered = geoHealth.order(PROVIDERS, Date.now(), { allowCooling: bypassCooldown });
  if (!ordered.length) {
    throw cooldownError("all geo providers cooling", geoHealth.nextRetryAt());
  }
  for (const p of ordered) {
    try {
      const res = await fetchWithTimeout(p.urlFor(targetIp), {
        timeoutMs: GEO_LOOKUP_TIMEOUT_MS,
        signal,
        headers: { Accept: "application/json" },
      });
      const json = await res.json();
      const raw = p.parse(json);
      const geo = normalize(raw, p.id);
      if (!geo) {
        lastError = `${p.id}: incomplete payload`;
        geoHealth.recordFail(p.id);
        continue;
      }
      if (!ipsEqual(geo.ip, targetIp)) {
        lastError = `${p.id}: ip mismatch ${geo.ip} != ${targetIp}`;
        geoHealth.recordFail(p.id);
        continue;
      }
      geoHealth.recordOk(p.id);
      return geo;
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      geoHealth.recordFail(p.id, { status: err && err.status });
      lastError = `${p.id}: ${err && err.message ? err.message : err}`;
    }
  }
  throw new Error(lastError);
}

function normalize(raw, provider) {
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  const timezone = String(raw.timezone || "").trim();
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (!isValidTimeZone(timezone)) return null;
  return {
    ip: raw.ip || "",
    country: String(raw.country || "").trim() || "Unknown",
    countryCode: String(raw.countryCode || "").trim().toUpperCase(),
    region: String(raw.region || "").trim(),
    city: String(raw.city || "").trim() || "Unknown",
    latitude,
    longitude,
    timezone,
    isp: String(raw.isp || "").trim(),
    provider,
  };
}

function countryNameFromCode(code) {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code);
  } catch {
    return "";
  }
}
