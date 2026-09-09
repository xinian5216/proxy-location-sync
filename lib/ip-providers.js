/**
 * 公网 IP 回显。请求走浏览器网络栈，因此跟随当前代理。
 * 首选 api64.ipify.org（IPv4/IPv6），避免 IPv6-only 先白等两个 v4-only 超时。
 */

import { IP_ECHO_TIMEOUT_MS } from "./constants.js";
import { isPublicIp } from "./ip-compare.js";
import { fetchWithTimeout } from "./net.js";
import { cooldownError, createProviderHealth } from "./provider-health.js";

const PROVIDERS = [
  {
    id: "ipify64",
    url: "https://api64.ipify.org?format=json",
    parse: (text) => JSON.parse(text).ip,
  },
  {
    id: "cloudflare",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    parse: (text) => {
      const line = text.split("\n").find((l) => l.startsWith("ip="));
      return line ? line.slice(3).trim() : "";
    },
  },
  { id: "identme", url: "https://ident.me/", parse: (text) => text.trim() },
  { id: "ipify", url: "https://api.ipify.org?format=json", parse: (text) => JSON.parse(text).ip },
  { id: "seeip", url: "https://api.seeip.org/", parse: (text) => text.trim() },
];

export const ipHealth = createProviderHealth();
export const IP_PROVIDERS = PROVIDERS;

export { isPublicIp };

export async function detectPublicIp({ signal, bypassCooldown = false } = {}) {
  let lastError = "all ip providers failed";
  const ordered = ipHealth.order(PROVIDERS, Date.now(), { allowCooling: bypassCooldown });
  if (!ordered.length) {
    throw cooldownError("all ip providers cooling", ipHealth.nextRetryAt());
  }
  for (const p of ordered) {
    try {
      const res = await fetchWithTimeout(p.url, { timeoutMs: IP_ECHO_TIMEOUT_MS, signal });
      const text = await res.text();
      const ip = String(p.parse(text) || "").trim();
      if (isPublicIp(ip)) {
        ipHealth.recordOk(p.id);
        return { ip, provider: p.id };
      }
      lastError = `${p.id}: not a public IP (${ip || "empty"})`;
      ipHealth.recordFail(p.id);
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      ipHealth.recordFail(p.id, { status: err && err.status });
      lastError = `${p.id}: ${err && err.message ? err.message : err}`;
    }
  }
  throw new Error(lastError);
}
