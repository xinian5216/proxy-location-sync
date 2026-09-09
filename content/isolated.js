/**
 * Isolated world 桥：storage → MAIN CustomEvent。
 * MAIN 拿不到 chrome.*。不发 chrome.tabs 消息。
 *
 * 故意不带 trusted。MAIN 把 CustomEvent 一律视为不可信，
 * 网页伪造 __pls_v1 不能把扩展切到 native geolocation。
 */

const PAGE_EVENT = "__pls_v1";

function publish(payload) {
  try {
    window.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: payload }));
  } catch {
    /* about:blank 销毁时可能抛 */
  }
}

function readAndPublish() {
  chrome.storage.local.get(["settings", "state"], (data) => {
    publish({
      type: "STATE",
      source: "isolated",
      settings: data.settings || { enabled: true },
      state: data.state || null,
    });
  });
}

readAndPublish();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.state || changes.settings) readAndPublish();
});
