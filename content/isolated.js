/**
 * Isolated world 桥：storage → MAIN CustomEvent。
 * MAIN 拿不到 chrome.* / browser.*。不发 tabs 消息。
 *
 * 故意不带 trusted。MAIN 把 CustomEvent 一律视为不可信，
 * 网页伪造 __pls_v1 不能把扩展切到 native geolocation。
 *
 * PAGE_ENV_PROBE：向 MAIN 发 PROBE，收回 PAGE_ENV（http(s) 页，不是扩展页）。
 * 经典脚本，不能 import；统一走 ext（Firefox browser.* / Chromium chrome.*）。
 */

const PAGE_EVENT = "__pls_v1";
const ext = typeof browser !== "undefined" && browser && browser.runtime ? browser : chrome;

function publish(payload) {
  try {
    window.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: payload }));
  } catch {
    /* about:blank 销毁时可能抛 */
  }
}

function storageGet(keys, cb) {
  try {
    const ret = ext.storage.local.get(keys);
    if (ret && typeof ret.then === "function") {
      ret.then((data) => cb(data || {})).catch(() => cb({}));
      return;
    }
  } catch {
    /* fall through to callback form */
  }
  try {
    ext.storage.local.get(keys, (data) => cb(data || {}));
  } catch {
    cb({});
  }
}

function readAndPublish() {
  storageGet(["settings", "state"], (data) => {
    publish({
      type: "STATE",
      source: "isolated",
      settings: data.settings || { enabled: true },
      state: data.state || null,
    });
  });
}

readAndPublish();

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.state || changes.settings) readAndPublish();
});

let probeWait = null;

window.addEventListener(PAGE_EVENT, (ev) => {
  const detail = ev && ev.detail;
  if (!detail || detail.type !== "PAGE_ENV") return;
  if (typeof probeWait === "function") {
    const done = probeWait;
    probeWait = null;
    done(detail);
  }
});

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "PAGE_ENV_PROBE") return;
  if (probeWait) {
    sendResponse({ ok: false, error: "busy" });
    return;
  }
  let finished = false;
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    probeWait = null;
    try {
      sendResponse({ ok: false, error: "timeout" });
    } catch {
      /* channel closed */
    }
  }, 2500);
  probeWait = (env) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try {
      sendResponse({ ok: true, env });
    } catch {
      /* channel closed */
    }
  };
  publish({ type: "PROBE", source: "isolated" });
  return true;
});
