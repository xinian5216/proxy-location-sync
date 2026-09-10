/**
 * DNS resolver 外部观测。扩展读不到系统 DNS 设置，
 * 只能让权威 DNS 服务看到谁来解析一次性子域。
 *
 * 不发送网页 URL、历史、Cookie、账号。
 * 第三方接口失败 → unknown / fallback / cooldown，绝不影响核心同步。
 */

import { DNS_TIMEOUT_MS } from "./constants.js";
import { isValidIpLiteral } from "./ip-compare.js";
import { fetchWithTimeout } from "./net.js";
import { cooldownError, createProviderHealth } from "./provider-health.js";

function randomDigits(n) {
  let s = "";
  for (let i = 0; i < n; i += 1) s += String(Math.floor(Math.random() * 10));
  return s;
}

function randomHex(n) {
  let s = "";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < n; i += 1) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function asJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("invalid JSON");
    err.name = "InvalidJsonError";
    throw err;
  }
}

function parseError(message, name = "DnsParseError") {
  const err = new Error(message);
  err.name = name;
  return err;
}

function ipFromKnownIpleakJson(json) {
  if (!json || typeof json !== "object") return "";
  if (Array.isArray(json)) {
    const first = json[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      return first.ip || first.dns_ip || first.resolver || "";
    }
    return "";
  }
  for (const key of ["ip", "dns_ip", "resolver", "dnsIp"]) {
    if (typeof json[key] === "string") return json[key];
  }
  if (json.dns && typeof json.dns === "object" && typeof json.dns.ip === "string") {
    return json.dns.ip;
  }
  return "";
}

/** ipleak dnsdetection 正文：整段必须是 IP，或已知 JSON 字段。不从 HTML 里摸 hex。 */
export function parseIpleakDetectionBody(text) {
  const candidate = String(text ?? "").trim();
  if (!candidate) throw parseError("ipleak: empty body");
  if (isValidIpLiteral(candidate)) return candidate;
  if (candidate.startsWith("{") || candidate.startsWith("[")) {
    const json = asJson(candidate);
    const ip = ipFromKnownIpleakJson(json);
    if (isValidIpLiteral(ip)) return ip;
    throw parseError("ipleak: no resolver ip");
  }
  throw parseError("ipleak: unexpected response");
}

async function runBashWs({ fetchFn, signal, timeoutMs }) {
  if (signal && signal.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
  let id = "";
  try {
    const idRes = await fetchFn("https://bash.ws/id", { timeoutMs, signal });
    id = String(await idRes.text()).trim();
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    id = "";
  }
  if (!/^\d{4,12}$/.test(id)) id = randomDigits(7);

  await Promise.allSettled(
    [0, 1, 2, 3, 4, 5].map((n) =>
      fetchFn(`https://${n}.${id}.bash.ws/`, { timeoutMs: Math.min(2500, timeoutMs), signal }).catch(() => null),
    ),
  );

  const res = await fetchFn(`https://bash.ws/dnsleak/test/${id}?json`, { timeoutMs, signal });
  const json = asJson(await res.text());
  if (!Array.isArray(json)) throw new Error("bash.ws: unexpected shape");
  const resolvers = [];
  for (const row of json) {
    if (!row || row.type !== "dns") continue;
    const ip = String(row.ip || "").trim();
    if (!isValidIpLiteral(ip)) continue;
    resolvers.push({
      ip,
      country: row.country_name || "",
      countryCode: row.country_code || "",
      org: row.asn || "",
      asn: row.asn || "",
      isp: row.asn || "",
    });
  }
  if (!resolvers.length) throw new Error("no usable DNS resolvers");
  return { resolvers, provider: "bash.ws", rawCount: json.length };
}

async function runIpleak({ fetchFn, signal, timeoutMs }) {
  const session = randomHex(40);
  const token = randomHex(8);
  const res = await fetchFn(`https://${session}-${token}.ipleak.net/dnsdetection/`, { timeoutMs, signal });
  const resolverIp = parseIpleakDetectionBody(await res.text());
  let country = "";
  let countryCode = "";
  let org = "";
  try {
    const geoRes = await fetchFn(`https://ipleak.net/json/${encodeURIComponent(resolverIp)}`, { timeoutMs, signal });
    const geo = asJson(await geoRes.text());
    country = geo.country_name || "";
    countryCode = geo.country_code || "";
    org = geo.isp_name || geo.isp || geo.as_name || geo.asn_name || "";
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    /* resolver IP 本身仍可用 */
  }
  return {
    resolvers: [
      {
        ip: resolverIp,
        country,
        countryCode,
        org,
        asn: org,
        isp: org,
      },
    ],
    provider: "ipleak.net",
  };
}

const PROVIDERS = [
  { id: "bash.ws", run: runBashWs },
  { id: "ipleak.net", run: runIpleak },
];

export function createDnsProbe({
  fetchFn = fetchWithTimeout,
  now = () => Date.now(),
  health = createProviderHealth(),
  timeoutMs = DNS_TIMEOUT_MS,
} = {}) {
  async function lookup({ signal, bypassCooldown = false } = {}) {
    if (signal && signal.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    const ordered = health.order(PROVIDERS, now(), { allowCooling: bypassCooldown });
    if (!ordered.length) {
      throw cooldownError("dns providers cooling", health.nextRetryAt(now()));
    }
    const errors = [];
    for (const p of ordered) {
      try {
        const result = await p.run({ fetchFn, signal, timeoutMs });
        if (!result || !Array.isArray(result.resolvers) || result.resolvers.length === 0) {
          throw new Error("no usable DNS resolvers");
        }
        const usable = result.resolvers.filter((r) => r && isValidIpLiteral(r.ip));
        if (!usable.length) throw new Error("no usable DNS resolvers");
        health.recordOk(p.id, now());
        return {
          ...result,
          resolvers: usable,
          provider: p.id,
          error: "",
          timedOut: false,
          checkedAt: now(),
        };
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        health.recordFail(p.id, { status: err && err.status, now: now() });
        errors.push(err);
      }
    }
    const first = errors[0];
    return {
      resolvers: [],
      provider: "",
      error: String(first && first.message ? first.message : first || "dns failed"),
      timedOut: errors.some((e) => e && e.name === "TimeoutError"),
      checkedAt: now(),
    };
  }

  return { lookup, health, providers: PROVIDERS.map((p) => p.id) };
}

export const DNS_PROVIDER_IDS = PROVIDERS.map((p) => p.id);
