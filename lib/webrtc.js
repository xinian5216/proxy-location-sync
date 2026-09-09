/**
 * WebRTC 泄漏探测（只检测，不改 policy）。
 * 没有足够 ICE 候选时返回 unknown，而不是把「没测出来」当成 ok。
 */

import { WEBRTC_WAIT_MS } from "./constants.js";
import { canonicalizeIp, isPublicIp, ipsEqual } from "./ip-compare.js";

const STUN = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }],
};

export function classifyWebRtc({ localIps, publicIps, mdns, currentExitIp, hadError }) {
  if (hadError) {
    return { status: "unknown", reason: "probe failed" };
  }
  const publicList = publicIps || [];
  const localList = localIps || [];
  const usable = publicList.length > 0 || localList.length > 0 || mdns;
  if (!usable) {
    return { status: "unknown", reason: "inconclusive / no usable ICE candidates" };
  }
  const mismatch = publicList.some((ip) => currentExitIp && !ipsEqual(ip, currentExitIp));
  const lanVisible = localList.some((ip) => !String(ip).includes(".local") && !isMdns(ip));
  if (mismatch) {
    return { status: "leak", reason: "STUN public IP differs from HTTP exit IP" };
  }
  if (lanVisible) {
    return { status: "leak", reason: "local LAN IP visible via host candidate" };
  }
  if (publicList.length === 0) {
    return { status: "unknown", reason: "no srflx public candidates" };
  }
  return { status: "ok", reason: mdns ? "srflx matches exit; host is mDNS" : "srflx matches HTTP exit IP" };
}

export function viewWebRtc(state) {
  const w = state && state.webrtc;
  const ip = state && state.ip;
  if (!w || !ip) {
    return { status: "unknown", reason: (w && w.reason) || "", checkedForIp: ip || "" };
  }
  if (!w.checkedForIp || !ipsEqual(w.checkedForIp, ip)) {
    return { status: "unknown", reason: "exit changed; probe pending", checkedForIp: ip };
  }
  return w;
}

/** 出口变了或结果未绑定当前 IP 时，必须重新探测；cache-hit 同样走这条。 */
export function webrtcForCommit(prevRtc, ip) {
  const canon = canonicalizeIp(ip);
  if (prevRtc && prevRtc.checkedForIp && ipsEqual(prevRtc.checkedForIp, ip)) {
    return { webrtc: prevRtc, shouldProbe: false };
  }
  return {
    webrtc: {
      status: "unknown",
      reason: "exit changed; probe pending",
      checkedForIp: canon,
    },
    shouldProbe: true,
  };
}

function isMdns(ip) {
  return String(ip).endsWith(".local");
}

export async function probeWebRtc(currentExitIp, { signal } = {}) {
  if (typeof RTCPeerConnection !== "function") {
    return {
      status: "unknown",
      reason: "RTCPeerConnection unavailable",
      localIps: [],
      publicIps: [],
      mdns: false,
    };
  }

  if (signal && signal.aborted) {
    return {
      status: "unknown",
      reason: "aborted",
      localIps: [],
      publicIps: [],
      mdns: false,
    };
  }

  const pc = new RTCPeerConnection(STUN);
  const localIps = new Set();
  const publicIps = new Set();
  let mdns = false;
  let closed = false;

  const closePc = () => {
    if (closed) return;
    closed = true;
    try {
      pc.close();
    } catch {
      /* ignore */
    }
  };

  const onAbort = () => closePc();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  const done = new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, WEBRTC_WAIT_MS);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) {
        finish();
        return;
      }
      parseCandidate(ev.candidate.candidate, {
        localIps,
        publicIps,
        mdnsRef: (v) => {
          mdns = mdns || v;
        },
      });
    };
    if (signal) {
      signal.addEventListener("abort", finish, { once: true });
    }
  });

  try {
    pc.createDataChannel("pls-probe");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await done;
  } catch (err) {
    closePc();
    if (signal) signal.removeEventListener("abort", onAbort);
    return {
      status: "unknown",
      reason: err && err.message ? err.message : String(err),
      localIps: [],
      publicIps: [],
      mdns: false,
      checkedAt: Date.now(),
    };
  }
  closePc();
  if (signal) signal.removeEventListener("abort", onAbort);

  const publicList = [...publicIps];
  const localList = [...localIps];
  const classified = classifyWebRtc({
    localIps: localList,
    publicIps: publicList,
    mdns,
    currentExitIp: currentExitIp ? canonicalizeIp(currentExitIp) : "",
    hadError: Boolean(signal && signal.aborted),
  });

  return {
    ...classified,
    localIps: localList,
    publicIps: publicList,
    mdns,
    checkedForIp: currentExitIp ? canonicalizeIp(currentExitIp) : "",
    checkedAt: Date.now(),
  };
}

function parseCandidate(candidate, buckets) {
  if (!candidate) return;
  const parts = candidate.split(" ");
  if (parts.length < 8) return;
  const ip = parts[4];
  const typIndex = parts.indexOf("typ");
  const typ = typIndex >= 0 ? parts[typIndex + 1] : "";
  if (!ip) return;
  if (ip.endsWith(".local")) {
    buckets.mdnsRef(true);
    buckets.localIps.add(ip);
    return;
  }
  if (typ === "host") {
    buckets.localIps.add(ip);
    if (isPublicIp(ip)) buckets.publicIps.add(ip);
    return;
  }
  if (typ === "srflx" || typ === "prflx") {
    buckets.publicIps.add(ip);
  }
}
