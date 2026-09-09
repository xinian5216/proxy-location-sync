/**
 * 全局常量。不读取任何代理软件配置。
 */

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  intervalSec: 3,
  /** 默认 raw：出口 IP、地理库、Geolocation、Timezone 尽量一致 */
  locationMode: "raw",
  webrtcProbe: true,
});

export const INTERVAL_CHOICES = [2, 3, 5, 10];

export const STORAGE_KEYS = Object.freeze({
  settings: "settings",
  state: "state",
  geoCache: "geoCache",
});

export const PAGE_EVENT = "__pls_v1";

export const MSG = Object.freeze({
  GET_SNAPSHOT: "GET_SNAPSHOT",
  SETTINGS_PATCH: "SETTINGS_PATCH",
  DETECT_NOW: "DETECT_NOW",
  RESYNC: "RESYNC",
  IP_ECHO: "IP_ECHO",
  WEBRTC_RESULT: "WEBRTC_RESULT",
  OFFSCREEN_START: "OFFSCREEN_START",
  OFFSCREEN_STOP: "OFFSCREEN_STOP",
  OFFSCREEN_DETECT: "OFFSCREEN_DETECT",
  OFFSCREEN_WEBRTC: "OFFSCREEN_WEBRTC",
  OPEN_OPTIONS: "OPEN_OPTIONS",
});

export const ALARM_KEEPALIVE = "pls-keepalive";

export const GEO_CACHE_LIMIT = 50;

/** IP 回显：高频，单个源不要卡 4.5s */
export const IP_ECHO_TIMEOUT_MS = 2000;

/** 地理查询：仅在 IP 变化或缓存过期时发生 */
export const GEO_LOOKUP_TIMEOUT_MS = 4000;

export const FETCH_TIMEOUT_MS = GEO_LOOKUP_TIMEOUT_MS;

export const WEBRTC_WAIT_MS = 2500;

export const ACCURACY_MIN = 800;
export const ACCURACY_MAX = 4200;

export const JITTER_MIN_KM = 1;
export const JITTER_MAX_KM = 5;

/** 没有成功 Echo 超过该时间，popup 显示失联；Geolocation 不再把旧坐标称为当前位置 */
export const ECHO_STALE_MS = 20_000;

/** 全部 IP provider 冷却时，offscreen 最长睡这么久再醒 */
export const COOLDOWN_SLEEP_CAP_MS = 30_000;
