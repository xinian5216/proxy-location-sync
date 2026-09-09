import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyWebRtc, viewWebRtc, webrtcForCommit } from "../lib/webrtc.js";

describe("WebRTC classify: unknown vs ok vs leak", () => {
  test("no usable ICE → unknown, not ok", () => {
    const r = classifyWebRtc({
      localIps: [],
      publicIps: [],
      mdns: false,
      currentExitIp: "1.1.1.1",
    });
    assert.equal(r.status, "unknown");
    assert.match(r.reason, /inconclusive/i);
  });

  test("probe error → unknown", () => {
    const r = classifyWebRtc({
      localIps: [],
      publicIps: [],
      mdns: false,
      currentExitIp: "1.1.1.1",
      hadError: true,
    });
    assert.equal(r.status, "unknown");
  });

  test("srflx matches HTTP exit + mDNS host → ok", () => {
    const r = classifyWebRtc({
      localIps: ["ab12.local"],
      publicIps: ["203.0.113.10"],
      mdns: true,
      currentExitIp: "203.0.113.10",
    });
    assert.equal(r.status, "ok");
  });

  test("srflx public IP differs from HTTP exit → leak", () => {
    const r = classifyWebRtc({
      localIps: [],
      publicIps: ["8.8.8.8"],
      mdns: false,
      currentExitIp: "203.0.113.10",
    });
    assert.equal(r.status, "leak");
    assert.match(r.reason, /STUN/);
  });

  test("LAN host candidate visible → leak", () => {
    const r = classifyWebRtc({
      localIps: ["192.168.1.12"],
      publicIps: ["203.0.113.10"],
      mdns: false,
      currentExitIp: "203.0.113.10",
    });
    assert.equal(r.status, "leak");
    assert.match(r.reason, /LAN/i);
  });

  test("only mDNS, no srflx → unknown (not ok)", () => {
    const r = classifyWebRtc({
      localIps: ["deadbeef.local"],
      publicIps: [],
      mdns: true,
      currentExitIp: "203.0.113.10",
    });
    assert.equal(r.status, "unknown");
    assert.match(r.reason, /srflx/i);
  });

  test("IPv6 canonical match is ok", () => {
    const r = classifyWebRtc({
      localIps: [],
      publicIps: ["2001:db8:0:0:0:0:0:1"],
      mdns: false,
      currentExitIp: "2001:db8::1",
    });
    assert.equal(r.status, "ok");
  });
});

describe("WebRTC bound to current exit IP", () => {
  test("viewWebRtc hides ok from a previous IP", () => {
    const viewed = viewWebRtc({
      ip: "8.8.8.8",
      webrtc: { status: "ok", reason: "srflx matches", checkedForIp: "1.1.1.1" },
    });
    assert.equal(viewed.status, "unknown");
    assert.match(viewed.reason, /exit changed/i);
    assert.equal(viewed.checkedForIp, "8.8.8.8");
  });

  test("viewWebRtc keeps ok when checkedForIp matches, including IPv6 forms", () => {
    const viewed = viewWebRtc({
      ip: "2001:db8::1",
      webrtc: { status: "ok", reason: "match", checkedForIp: "2001:0db8:0000:0000:0000:0000:0000:0001" },
    });
    assert.equal(viewed.status, "ok");
  });

  test("geo cache hit of a new IP still resets WebRTC and asks for a probe", () => {
    const prev = { status: "ok", reason: "A ok", checkedForIp: "1.2.3.4", publicIps: ["1.2.3.4"] };
    const r = webrtcForCommit(prev, "8.8.8.8");
    assert.equal(r.shouldProbe, true);
    assert.equal(r.webrtc.status, "unknown");
    assert.equal(r.webrtc.checkedForIp, "8.8.8.8");
    assert.match(r.webrtc.reason, /exit changed/i);
  });

  test("same IP cache hit does not re-probe", () => {
    const prev = { status: "ok", reason: "match", checkedForIp: "1.2.3.4" };
    const r = webrtcForCommit(prev, "1.2.3.4");
    assert.equal(r.shouldProbe, false);
    assert.equal(r.webrtc.status, "ok");
  });
});
