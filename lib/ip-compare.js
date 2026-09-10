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

/**
 * 严格 IP 字面量。浏览器可用，不依赖 Node net.isIP。
 * 拒绝 "Bad" / HTML / 越界 IPv4 / 无结构的十六进制串。
 */
export function isValidIpLiteral(ip) {
  if (typeof ip !== "string") return false;
  let s = ip.trim();
  if (!s) return false;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s) return false;
  if (s.includes(".")) {
    if (!s.includes(":")) return isValidIPv4Literal(s);
    return isValidIPv6Literal(s);
  }
  if (s.includes(":")) return isValidIPv6Literal(s);
  return false;
}

export function isPublicResolverIp(ip) {
  return isValidIpLiteral(ip) && isPublicIp(ip);
}

function isValidIPv4Literal(s) {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return false;
    const n = Number(p);
    if (n > 255) return false;
  }
  return true;
}

function isValidIPv6Literal(s) {
  if (!s.includes(":")) return false;
  if (s.includes(":::")) return false;
  const lastColon = s.lastIndexOf(":");
  const last = lastColon >= 0 ? s.slice(lastColon + 1) : "";
  if (last.includes(".")) {
    if (!isValidIPv4Literal(last)) return false;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const sides = s.split("::");
  if (sides.length > 2) return false;
  const parse = (part) => {
    if (part === "") return [];
    const groups = part.split(":");
    if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return groups;
  };
  if (sides.length === 1) {
    const groups = parse(sides[0]);
    return !!groups && groups.length === 8;
  }
  const head = parse(sides[0]);
  const tail = parse(sides[1]);
  if (!head || !tail) return false;
  return head.length + tail.length < 8;
}

function expandIPv6(ip) {
  const parts = ip.split("::");
  const head = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":").filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  const mid = missing > 0 ? Array(missing).fill("0") : [];
  return [...head, ...mid, ...tail].map((x) => x.padStart(4, "0")).join(":");
}
