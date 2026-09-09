/**
 * IP 比较与公网判断。Geo lookup 必须用规范化后的地址核对 targetIp。
 */

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function canonicalizeIp(ip) {
  let s = String(ip || "").trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (s.startsWith("::ffff:") && s.includes(".")) return s.slice(7);
  if (IPV4.test(s)) return s;
  if (s.includes(":")) return expandIPv6(s);
  return s;
}

export function ipsEqual(a, b) {
  if (!a || !b) return false;
  return canonicalizeIp(a) === canonicalizeIp(b);
}

export function isPublicIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  const s = canonicalizeIp(ip);
  if (IPV4.test(s)) {
    const [a, b] = s.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
    if (a >= 224) return false;
    return true;
  }
  if (s.includes(":")) {
    if (s === "0000:0000:0000:0000:0000:0000:0000:0001") return false;
    if (s.startsWith("fe80:")) return false;
    if (s.startsWith("fc") || s.startsWith("fd")) return false;
    return true;
  }
  return false;
}

function expandIPv6(ip) {
  const parts = ip.split("::");
  const head = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":").filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  const mid = missing > 0 ? Array(missing).fill("0") : [];
  return [...head, ...mid, ...tail].map((x) => x.padStart(4, "0")).join(":");
}
