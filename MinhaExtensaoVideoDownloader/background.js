import { detectVideoExtension, mediaTypeForVideoExtension } from "./videoExtensions/detect.js";
import { createVideoExtensionRouter } from "./videoExtensions/index.js";
import { parseMetaMp4Track } from "./videoExtensions/metaMp4/detect.js";
import { tiktokItemIdFromUrl, tiktokMediaFromUniversalData } from "./videoExtensions/tiktok/index.js";

const tabMedia = new Map();
const tabRequestHeaders = new Map();
const tabPlayerState = new Map();
const tabMetaTracks = new Map();
const mediaUpdateTimers = new Map();
const mediaUpdateSignatures = new Map();
const NATIVE_HOST = "com.dsl.video_downloader";
const REQUIRED_NATIVE_HOST_API = 4;

const MEDIA_EXTENSIONS = /\.(m3u8|mpd|mp4|webm|mov|m4v|mkv|avi|flv|ts|m4s|mp3|m4a|aac|ogg|opus|wav)(?:[?#].*)?$/i;
const MEDIA_CONTENT_TYPE = /(?:video|audio)\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|octet-stream)/i;
const ACTIVE_JOB_STATES = new Set(["preparing", "downloading", "finalizing"]);
const SAFE_REPLAY_HEADERS = new Set(["accept", "accept-language", "cache-control", "cookie", "pragma", "user-agent"]);
const JOB_STORAGE_KEY = "videoDownloadJobs";
const LEGACY_JOB_STORAGE_KEY = "hlsDownloadJobs";
const MAX_JOB_HISTORY = 50;

let dependencyPromise = null;
let jobsPromise = null;
let jobsSaveTimer = null;

function ensureNativeDependencies() {
  if (dependencyPromise) return dependencyPromise;

  dependencyPromise = chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: "ensure-ffmpeg" })
    .then((response) => {
      if (!response?.ok) return { ok: false, error: response?.error || "Falha ao verificar o FFmpeg." };
      if (Number(response.hostApiVersion || 0) < REQUIRED_NATIVE_HOST_API) {
        return { ok: false, error: "O componente local esta desatualizado. Baixe e execute o instalador novamente." };
      }
      return response;
    })
    .catch((error) => ({ ok: false, error: error.message }))
    .finally(() => {
      dependencyPromise = null;
    });

  return dependencyPromise;
}

function normalizeUrl(url) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function mediaKind(url, contentType = "") {
  const lowerType = contentType.toLowerCase();
  const videoExtension = detectVideoExtension({ url, contentType });
  const managedMediaType = mediaTypeForVideoExtension(videoExtension);
  if (managedMediaType) return managedMediaType;
  if (url.toLowerCase().includes(".mpd") || lowerType.includes("dash+xml")) return "dash";
  if (lowerType.startsWith("audio/") || /\.(mp3|m4a|aac|ogg|opus|wav)(?:[?#].*)?$/i.test(url)) return "audio";
  return "video";
}

function filenameFromUrl(url, fallback = "media") {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || fallback;
    return decodeURIComponent(last).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 160) || fallback;
  } catch {
    return fallback;
  }
}

function fallbackVideoName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `video--${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}--${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function tiktokMediaKey(value) {
  const itemId = tiktokItemIdFromUrl(value);
  if (itemId) return `tiktok:${itemId}`;
  try {
    const url = new URL(value);
    const queryItemId = url.searchParams.get("item_id") || "";
    return queryItemId ? `tiktok:${queryItemId}` : "";
  } catch {
    return "";
  }
}

function isTikTokMediaUrl(value) {
  try {
    const url = new URL(value);
    const mediaHost = /(?:^|\.)(?:tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|byteoversea\.com|ibytedtos\.com)$/i.test(url.hostname);
    return mediaHost && (/\/aweme\/v1\/play\//i.test(url.pathname) || /\/video\//i.test(url.pathname) || /video_mp4/i.test(url.search));
  } catch {
    return false;
  }
}

function activeTikTokMediaKey(tabId, pageUrl = "") {
  return tiktokMediaKey(pageUrl) || tiktokMediaKey(tabPlayerState.get(tabId)?.pageUrl || "");
}

function tiktokSourcePriority(source) {
  return {
    "tiktok-page-data": 4,
    "player-redirect": 3,
    player: 2,
    network: 1
  }[source] || 0;
}

function readTikTokPageSnapshot() {
  const itemId = location.pathname.match(/\/video\/(\d+)/)?.[1] || "";
  const wrapper = itemId
    ? document.querySelector(`[id^="xgwrapper-"][id$="-${itemId}"]`)
    : null;
  const videoElement = wrapper?.querySelector("video") || null;
  const fiberKey = wrapper ? Object.keys(wrapper).find((key) => key.startsWith("__reactFiber$")) : "";
  let fiber = fiberKey ? wrapper[fiberKey] : null;
  let playerItem = null;

  for (let depth = 0; fiber && depth < 20 && !playerItem; depth += 1, fiber = fiber.return) {
    const candidates = [
      fiber.pendingProps,
      fiber.memoizedProps,
      fiber.alternate?.pendingProps,
      fiber.alternate?.memoizedProps
    ];
    for (const props of candidates) {
      const videoInfo = props?.player?.config?.videoInfo || {};
      if (String(props?.id || videoInfo.id || "") !== itemId || !Array.isArray(props?.bitrateInfo)) continue;
      playerItem = {
        id: itemId,
        video: {
          duration: Number(videoInfo.duration || videoElement?.duration || 0),
          width: Number(videoInfo.width || videoElement?.videoWidth || 0),
          height: Number(videoInfo.height || videoElement?.videoHeight || 0),
          playAddr: videoInfo.playAddr || "",
          bitrateInfo: props.bitrateInfo.map((entry) => ({
            Bitrate: entry?.Bitrate || entry?.bitrate || 0,
            CodecType: entry?.CodecType || entry?.codecType || "",
            PlayAddr: {
              DataSize: entry?.PlayAddr?.DataSize || entry?.PlayAddr?.dataSize || 0,
              Width: entry?.PlayAddr?.Width || entry?.PlayAddr?.width || 0,
              Height: entry?.PlayAddr?.Height || entry?.PlayAddr?.height || 0,
              UrlList: entry?.PlayAddr?.UrlList || entry?.PlayAddr?.urlList || []
            }
          }))
        }
      };
      break;
    }
  }

  return {
    pageUrl: location.href,
    universalData: document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent || "",
    playerItem,
    userAgent: navigator.userAgent
  };
}

async function currentTikTokPage(tabId, fallbackPageUrl = "") {
  let tabUrl = "";
  try {
    tabUrl = (await chrome.tabs.get(tabId))?.url || "";
  } catch {
  }
  const statePageUrl = tabPlayerState.get(tabId)?.pageUrl || "";
  const pageUrl = [tabUrl, fallbackPageUrl, statePageUrl].find((value) => tiktokMediaKey(value)) || "";
  return { pageUrl, mediaKey: tiktokMediaKey(pageUrl) };
}

async function ensureTikTokTargetMedia(tabId, fallbackPageUrl = "", forceRefresh = false) {
  if (!(tabId >= 0)) return null;
  const page = await currentTikTokPage(tabId, fallbackPageUrl);
  if (!page.mediaKey) return null;

  const findTarget = () => (tabMedia.get(tabId) || []).find((entry) =>
    entry.mediaKey === page.mediaKey && entry.source === "tiktok-page-data"
  ) || null;
  const existing = findTarget();
  if (existing && !forceRefresh) return existing;

  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: readTikTokPageSnapshot,
    world: "MAIN"
  });
  const snapshot = results?.[0]?.result;
  let media = tiktokMediaFromUniversalData(snapshot?.universalData || "", snapshot?.pageUrl || page.pageUrl);
  if (!media && snapshot?.playerItem) {
    media = tiktokMediaFromUniversalData({
      __DEFAULT_SCOPE__: {
        "webapp.video-detail": {
          itemInfo: { itemStruct: snapshot.playerItem }
        }
      }
    }, snapshot.pageUrl || page.pageUrl);
  }
  if (!media || media.mediaKey !== page.mediaKey) return null;

  await addMedia(tabId, {
    ...media,
    title: "video.mp4",
    pageUrl: snapshot.pageUrl || page.pageUrl,
    type: "video",
    videoExtension: "direct",
    source: "tiktok-page-data",
    contentType: "video/mp4",
    userAgent: snapshot.userAgent || ""
  });
  return findTarget();
}

function mediaUpdateSignature(tabId) {
  return (tabMedia.get(tabId) || [])
    .map((item) => [item.url, item.audioUrl || "", item.mediaKey || "", item.source || "", item.videoExtension || ""].join("|"))
    .sort()
    .join("\n");
}

function notifyMediaListUpdated(tabId) {
  const signature = mediaUpdateSignature(tabId);
  if (mediaUpdateSignatures.get(tabId) === signature) return;
  mediaUpdateSignatures.set(tabId, signature);
  if (mediaUpdateTimers.has(tabId)) return;

  const timer = setTimeout(() => {
    mediaUpdateTimers.delete(tabId);
    chrome.runtime.sendMessage({ type: "media-list-updated", tabId }).catch(() => {});
  }, 250);
  mediaUpdateTimers.set(tabId, timer);
}

function publicJobs(jobs) {
  return [...jobs.values()]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, MAX_JOB_HISTORY);
}

async function persistJobs(jobs) {
  await chrome.storage.local.set({ [JOB_STORAGE_KEY]: publicJobs(jobs) });
}

function scheduleJobsSave(jobs) {
  if (jobsSaveTimer) return;
  jobsSaveTimer = setTimeout(() => {
    jobsSaveTimer = null;
    persistJobs(jobs).catch(() => {});
  }, 700);
}

async function getJobs() {
  if (jobsPromise) return jobsPromise;

  jobsPromise = (async () => {
    const stored = await chrome.storage.local.get([JOB_STORAGE_KEY, LEGACY_JOB_STORAGE_KEY]);
    const jobs = new Map();
    const savedJobs = stored[JOB_STORAGE_KEY] || stored[LEGACY_JOB_STORAGE_KEY] || [];
    let changed = Boolean(stored[LEGACY_JOB_STORAGE_KEY]);

    for (const saved of savedJobs) {
      const job = { ...saved };
      if (ACTIVE_JOB_STATES.has(job.status)) {
        job.status = "error";
        job.phase = "Download interrompido";
        job.error = "O Chrome foi encerrado ou a extensao foi recarregada durante o download.";
        job.updatedAt = Date.now();
        changed = true;
      }
      jobs.set(job.id, job);
    }

    if (changed) {
      await persistJobs(jobs);
      await chrome.storage.local.remove(LEGACY_JOB_STORAGE_KEY);
    }
    return jobs;
  })();

  return jobsPromise;
}

function broadcastJob(job) {
  chrome.runtime.sendMessage({ type: "download-job-update", job: { ...job } }).catch(() => {});
}

async function updateJob(jobId, patch, immediate = false) {
  const jobs = await getJobs();
  const job = jobs.get(jobId);
  if (!job) return null;

  Object.assign(job, patch, { updatedAt: Date.now() });
  if (immediate) await persistJobs(jobs);
  else scheduleJobsSave(jobs);
  broadcastJob(job);
  return job;
}

async function updateBadge(tabId) {
  const count = (tabMedia.get(tabId) || []).length;
  await chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1f7a5c" });
}

function bestMetaTrack(tracks) {
  return [...tracks.values()].sort((a, b) =>
    (b.bitrate || 0) - (a.bitrate || 0) ||
    (b.size || 0) - (a.size || 0) ||
    (b.foundAt || 0) - (a.foundAt || 0)
  )[0] || null;
}

async function refreshMetaMedia(tabId) {
  const groups = tabMetaTracks.get(tabId);
  const list = (tabMedia.get(tabId) || []).filter((entry) => entry.source !== "meta-paired");
  if (!groups?.size) {
    tabMedia.set(tabId, list);
    await updateBadge(tabId);
    notifyMediaListUpdated(tabId);
    return;
  }

  const state = tabPlayerState.get(tabId) || {};
  const stateTrack = parseMetaMp4Track(state.sourceUrl || "");
  const candidates = [...groups.values()]
    .map((group) => ({
      group,
      video: bestMetaTrack(group.videos),
      audio: bestMetaTrack(group.audios)
    }))
    .filter((candidate) => candidate.video && candidate.audio);

  candidates.sort((a, b) => {
    const score = (candidate) => {
      const exactAsset = stateTrack?.assetId === candidate.group.assetId ? 1_000_000_000 : 0;
      const duration = candidate.video.durationSeconds || candidate.audio.durationSeconds || 0;
      const sameDurationBucket = state.durationSeconds > 0 && duration > 0 &&
        Math.floor(state.durationSeconds) === Math.floor(duration);
      const durationBucketScore = sameDurationBucket ? 500_000_000 : 0;
      const durationDifference = state.durationSeconds > 0 && duration > 0
        ? Math.abs(state.durationSeconds - duration)
        : 1000;
      const durationScore = Math.max(0, 100_000_000 - durationDifference * 1_000_000);
      return exactAsset + durationBucketScore + durationScore + (candidate.video.bitrate || 0) + (candidate.group.lastSeen || 0) / 1_000_000;
    };
    return score(b) - score(a);
  });

  const playerIdentified = Boolean(stateTrack || Number(state.durationSeconds || 0) > 0);
  const selected = playerIdentified ? candidates[0] : null;
  if (selected) {
    const durationSeconds = state.durationSeconds || selected.video.durationSeconds || selected.audio.durationSeconds || 0;
    list.unshift({
      id: crypto.randomUUID(),
      url: selected.video.url,
      audioUrl: selected.audio.url,
      pageUrl: state.pageUrl || selected.video.pageUrl || "",
      title: "video-com-audio.mp4",
      type: "video",
      videoExtension: "meta-mp4",
      source: "meta-paired",
      contentType: "video/mp4",
      size: (selected.video.size || 0) + (selected.audio.size || 0),
      durationSeconds,
      resolution: state.resolution || selected.video.resolution || "",
      bitrateKbps: selected.video.bitrate ? Math.round(selected.video.bitrate / 1000) : 0,
      assetId: selected.group.assetId,
      foundAt: selected.group.lastSeen
    });
  }

  tabMedia.set(tabId, list.slice(0, 1000));
  await updateBadge(tabId);
  notifyMediaListUpdated(tabId);
}

async function registerMetaTrack(tabId, item, parsedTrack = parseMetaMp4Track(item?.url || "")) {
  if (tabId < 0 || !parsedTrack) return false;
  const groups = tabMetaTracks.get(tabId) || new Map();
  const group = groups.get(parsedTrack.assetId) || {
    assetId: parsedTrack.assetId,
    videos: new Map(),
    audios: new Map(),
    lastSeen: 0
  };
  const tracks = parsedTrack.kind === "audio" ? group.audios : group.videos;
  const previous = tracks.get(parsedTrack.url);
  const foundAt = Date.now();
  tracks.set(parsedTrack.url, {
    ...previous,
    ...parsedTrack,
    pageUrl: item.pageUrl || previous?.pageUrl || "",
    contentType: item.contentType || previous?.contentType || "",
    size: Math.max(Number(item.size || 0), Number(previous?.size || 0)),
    foundAt
  });
  group.lastSeen = foundAt;
  groups.set(group.assetId, group);

  if (groups.size > 150) {
    const oldest = [...groups.values()].sort((a, b) => a.lastSeen - b.lastSeen).slice(0, groups.size - 150);
    for (const entry of oldest) groups.delete(entry.assetId);
  }

  tabMetaTracks.set(tabId, groups);
  await refreshMetaMedia(tabId);
  return true;
}

async function addMedia(tabId, item) {
  if (tabId < 0 || !item?.url) return;

  const metaTrack = parseMetaMp4Track(item.url);
  if (metaTrack) {
    await registerMetaTrack(tabId, item, metaTrack);
    return;
  }

  const list = tabMedia.get(tabId) || [];
  const normalizedUrl = normalizeUrl(item.url);
  const mediaKey = item.mediaKey || tiktokMediaKey(normalizedUrl);
  const videoExtension = detectVideoExtension({ ...item, url: normalizedUrl });
  const pageMediaKey = activeTikTokMediaKey(tabId, item.pageUrl || "");

  if (pageMediaKey && mediaKey && mediaKey !== pageMediaKey) return;

  if (pageMediaKey && ["tiktok-page-data", "player-redirect", "player"].includes(item.source) && mediaKey === pageMediaKey) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = list[index];
      const entryPageMediaKey = activeTikTokMediaKey(tabId, entry.pageUrl || "");
      const isTikTokEntry = entry.videoExtension === "direct" || isTikTokMediaUrl(entry.url);
      if (isTikTokEntry && entryPageMediaKey === pageMediaKey && entry.mediaKey !== pageMediaKey) {
        list.splice(index, 1);
      }
    }
  }

  const targetEntry = pageMediaKey ? list.find((entry) => entry.mediaKey === pageMediaKey) : null;
  if (pageMediaKey && !mediaKey && item.source === "network" && isTikTokMediaUrl(normalizedUrl) && targetEntry?.url !== normalizedUrl) {
    return;
  }
  if (pageMediaKey && !mediaKey && targetEntry && targetEntry.url !== normalizedUrl && videoExtension === "direct") {
    return;
  }

  const existing = list.find((entry) => entry.url === normalizedUrl || (mediaKey && entry.mediaKey === mediaKey));
  const preserveAuthoritativeTarget = existing?.mediaKey === pageMediaKey
    && mediaKey === pageMediaKey
    && tiktokSourcePriority(existing.source) > tiktokSourcePriority(item.source);
  const next = {
    id: crypto.randomUUID(),
    url: preserveAuthoritativeTarget ? existing.url : normalizedUrl,
    mediaKey: preserveAuthoritativeTarget ? existing.mediaKey : mediaKey,
    pageUrl: item.pageUrl || existing?.pageUrl || "",
    title: item.title || existing?.title || filenameFromUrl(normalizedUrl),
    type: mediaTypeForVideoExtension(videoExtension) || item.type || mediaKind(normalizedUrl, item.contentType),
    videoExtension: videoExtension || "",
    source: preserveAuthoritativeTarget ? existing.source : item.source || "network",
    contentType: item.contentType || existing?.contentType || "",
    size: Math.max(Number(item.size || 0), Number(existing?.size || 0)),
    audioUrl: item.audioUrl || existing?.audioUrl || "",
    durationSeconds: Number(item.durationSeconds || existing?.durationSeconds || 0),
    resolution: preserveAuthoritativeTarget ? existing.resolution || item.resolution || "" : item.resolution || existing?.resolution || "",
    bitrateKbps: Number(preserveAuthoritativeTarget ? existing.bitrateKbps || item.bitrateKbps || 0 : item.bitrateKbps || existing?.bitrateKbps || 0),
    userAgent: item.userAgent || existing?.userAgent || "",
    foundAt: Date.now()
  };

  if (existing) {
    Object.assign(existing, { ...next, id: existing.id, foundAt: existing.foundAt });
  } else {
    list.unshift(next);
  }

  tabMedia.set(tabId, list.slice(0, 1000));
  await updateBadge(tabId);
  notifyMediaListUpdated(tabId);
}

function rememberRequestHeaders(details) {
  if (details.tabId < 0 || !details.url || !details.requestHeaders?.length) return;
  if (!MEDIA_EXTENSIONS.test(details.url) && !isTikTokMediaUrl(details.url) && !parseMetaMp4Track(details.url)) return;

  const list = tabRequestHeaders.get(details.tabId) || [];
  const normalizedUrl = normalizeUrl(details.url);
  const next = {
    url: normalizedUrl,
    origin: (() => {
      try {
        return new URL(normalizedUrl).origin;
      } catch {
        return "";
      }
    })(),
    pageUrl: details.documentUrl || details.initiator || "",
    headers: details.requestHeaders.map((header) => ({ name: header.name, value: header.value || "" })),
    time: Date.now()
  };

  const existingIndex = list.findIndex((entry) => entry.url === normalizedUrl);
  if (existingIndex >= 0) list.splice(existingIndex, 1);
  list.unshift(next);
  tabRequestHeaders.set(details.tabId, list.slice(0, 300));
}

function getHeaderContext(tabId, url) {
  const list = tabRequestHeaders.get(tabId) || [];
  const normalizedUrl = normalizeUrl(url);
  let origin = "";
  try {
    origin = new URL(normalizedUrl).origin;
  } catch {}

  const exact = list.find((entry) => entry.url === normalizedUrl);
  const sameOrigin = list.find((entry) => entry.origin === origin);
  const selected = exact || sameOrigin;

  return {
    headers: selected?.headers || [],
    matchedUrl: selected?.url || "",
    pageUrl: selected?.pageUrl || "",
    matchedBy: exact ? "exact" : sameOrigin ? "origin" : "none"
  };
}

async function cookieStoreIdForTab(tabId) {
  if (!(tabId >= 0)) return "";
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    return stores.find((store) => store.tabIds.includes(tabId))?.id || "";
  } catch {
    return "";
  }
}

async function tiktokCookieHeader(tabId, url) {
  if (!isTikTokMediaUrl(url)) return "";
  try {
    const storeId = await cookieStoreIdForTab(tabId);
    const withStore = (filter) => storeId ? { ...filter, storeId } : filter;
    const [matching, tiktok] = await Promise.all([
      chrome.cookies.getAll(withStore({ url })),
      chrome.cookies.getAll(withStore({ domain: "tiktok.com" }))
    ]);
    const unique = new Map();
    for (const cookie of [...matching, ...tiktok]) {
      unique.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
    }
    return [...unique.values()]
      .sort((a, b) => (b.path?.length || 0) - (a.path?.length || 0))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  } catch {
    return "";
  }
}

async function replayHeaders(tabId, url) {
  const context = getHeaderContext(tabId, url);
  const headers = {};
  for (const header of context.headers) {
    if (SAFE_REPLAY_HEADERS.has(header.name.toLowerCase())) headers[header.name] = header.value;
  }
  const cookie = await tiktokCookieHeader(tabId, url);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

const videoExtensionRouter = createVideoExtensionRouter({
  nativeHost: NATIVE_HOST,
  activeJobStates: ACTIVE_JOB_STATES,
  ensureNativeDependencies,
  normalizeUrl,
  createFilenameBase: fallbackVideoName,
  getJobs,
  persistJobs,
  updateJob,
  broadcastJob,
  getReplayHeaders: replayHeaders
});

async function startVideoDownload(message, tabId) {
  let resolvedMessage = message;
  const tiktokPage = await currentTikTokPage(tabId, message.pageUrl || "");
  if (tiktokPage.mediaKey) {
    const target = await ensureTikTokTargetMedia(tabId, tiktokPage.pageUrl, true).catch(() => null);
    if (!target || target.mediaKey !== tiktokPage.mediaKey) {
      return { ok: false, error: "Nao foi possivel confirmar o video aberto no TikTok. Atualize a pagina e tente novamente." };
    }
    resolvedMessage = {
      ...message,
      url: target.url,
      pageUrl: target.pageUrl || tiktokPage.pageUrl,
      mediaType: target.type || "video",
      contentType: target.contentType || "video/mp4",
      videoExtension: target.videoExtension || "direct",
      durationSeconds: target.durationSeconds || 0,
      resolution: target.resolution || "",
      bitrateKbps: target.bitrateKbps || 0,
      userAgent: target.userAgent || message.userAgent || ""
    };
  }

  const { id, handler } = videoExtensionRouter.resolve(resolvedMessage);
  if (!id) return { ok: false, error: "O formato deste video nao foi identificado." };
  if (!handler) return { ok: false, error: `O formato ${id} ainda nao possui um downloader.` };
  return handler.start({ ...resolvedMessage, videoExtension: id }, tabId);
}

async function retryVideoDownload(jobId) {
  const jobs = await getJobs();
  const previous = jobs.get(jobId);
  if (!previous) return { ok: false, error: "Download nao encontrado." };

  return startVideoDownload({ ...previous, url: previous.sourceUrl, tabId: previous.sourceTabId }, previous.sourceTabId);
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  rememberRequestHeaders,
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (!details.redirectUrl || !/\/aweme\/v1\/play\//i.test(details.url)) return;
    const mediaKey = tiktokMediaKey(details.url);
    if (!mediaKey) return;

    resolveRequestTabId(details).then(async (tabId) => {
      if (tabId < 0) return;
      const tab = await chrome.tabs.get(tabId);
      if (tiktokMediaKey(tab.url || details.documentUrl || "") !== mediaKey) return;
      const state = tabPlayerState.get(tabId) || {};
      await addMedia(tabId, {
        url: details.redirectUrl,
        mediaKey,
        title: "video.mp4",
        type: "video",
        videoExtension: "direct",
        source: "player-redirect",
        contentType: "video/mp4",
        pageUrl: tab.url || details.documentUrl || "",
        durationSeconds: state.durationSeconds || 0,
        resolution: state.resolution || "",
        userAgent: state.userAgent || ""
      });
    }).catch(() => {});
  },
  { urls: ["<all_urls>"] }
);

async function resolveRequestTabId(details) {
  if (details.tabId >= 0) return details.tabId;

  let contextOrigin = "";
  let contextHost = "";
  try {
    const contextUrl = new URL(details.documentUrl || details.initiator || "");
    contextOrigin = contextUrl.origin;
    contextHost = contextUrl.hostname;
  } catch {
  }
  const tabs = await chrome.tabs.query({});
  let candidates = tabs.filter((tab) => {
    try {
      const tabUrl = new URL(tab.url || "");
      return tabUrl.origin === contextOrigin || tabUrl.hostname === contextHost;
    } catch {
      return false;
    }
  });
  if (!candidates.length && parseMetaMp4Track(details.url || "")) {
    candidates = tabs.filter((tab) => {
      try {
        return /(?:^|\.)(?:facebook|instagram)\.com$/i.test(new URL(tab.url || "").hostname);
      } catch {
        return false;
      }
    });
  }
  candidates.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return candidates[0]?.id ?? -1;
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!details.url) return;

    const headers = details.responseHeaders || [];
    const contentType = headers.find((header) => header.name.toLowerCase() === "content-type")?.value || "";
    const contentLength = Number(headers.find((header) => header.name.toLowerCase() === "content-length")?.value || 0);
    const looksLikeMedia = MEDIA_EXTENSIONS.test(details.url) || MEDIA_CONTENT_TYPE.test(contentType);
    if (!looksLikeMedia) return;
    if (isTikTokMediaUrl(details.url) && contentLength > 0 && contentLength < 16 * 1024) return;

    resolveRequestTabId(details).then((tabId) => addMedia(tabId, {
        url: details.url,
        type: mediaKind(details.url, contentType),
        source: "network",
        contentType,
        size: Number.isFinite(contentLength) ? contentLength : 0,
        pageUrl: details.documentUrl || details.initiator || ""
      }))
      .catch(() => {});
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId ?? sender.tab?.id;

  if (message.type === "page-media") {
    Promise.all((message.items || []).map((item) => addMedia(tabId, { ...item, source: item.source || "page" })))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "player-state") {
    const candidate = {
      ...(message.state || {}),
      frameId: sender.frameId ?? 0,
      observedAt: Number(message.state?.observedAt || Date.now())
    };
    const previous = tabPlayerState.get(tabId);
    const fromPreferredFrame = candidate.frameId === 0 || previous?.frameId !== 0;
    const candidateVisibleArea = Number(candidate.visibleArea || 0);
    const previousVisibleArea = Number(previous?.visibleArea || 0);
    const candidateIsVisible = candidateVisibleArea > 0;
    const previousIsVisible = previousVisibleArea > 0;
    const strongerCandidate = candidateIsVisible !== previousIsVisible
      ? candidateIsVisible
      : candidateIsVisible
        ? candidateVisibleArea >= previousVisibleArea
        : Number(Boolean(candidate.isPlaying)) >= Number(Boolean(previous?.isPlaying));
    const stalePrevious = !previous || Date.now() - (previous.observedAt || 0) > 5000;
    if (fromPreferredFrame && (strongerCandidate || stalePrevious || candidate.pageUrl !== previous?.pageUrl)) {
      tabPlayerState.set(tabId, candidate);
      for (const item of tabMedia.get(tabId) || []) {
        if (item.videoExtension !== "direct") continue;
        item.durationSeconds = candidate.durationSeconds || item.durationSeconds || 0;
        item.resolution = candidate.resolution || item.resolution || "";
        item.pageUrl = candidate.pageUrl || item.pageUrl || "";
      }
    }
    refreshMetaMedia(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "get-media") {
    ensureTikTokTargetMedia(tabId).catch(() => null).then(() => {
      sendResponse({ ok: true, items: tabMedia.get(tabId) || [] });
    });
    return true;
  }

  if (message.type === "ensure-native-dependencies") {
    ensureNativeDependencies().then(sendResponse);
    return true;
  }

  if (message.type === "get-download-jobs") {
    getJobs().then((jobs) => sendResponse({ ok: true, jobs: publicJobs(jobs) }));
    return true;
  }

  if (message.type === "start-video-download") {
    startVideoDownload(message, tabId).then(sendResponse);
    return true;
  }

  if (message.type === "retry-video-download") {
    retryVideoDownload(message.jobId).then(sendResponse);
    return true;
  }

  if (message.type === "dismiss-download-job") {
    getJobs().then(async (jobs) => {
      const job = jobs.get(message.jobId);
      if (job && !ACTIVE_JOB_STATES.has(job.status)) jobs.delete(message.jobId);
      await persistJobs(jobs);
      sendResponse({ ok: true, jobs: publicJobs(jobs) });
    });
    return true;
  }

  if (message.type === "clear-download-history") {
    getJobs().then(async (jobs) => {
      for (const [jobId, job] of jobs) {
        if (!ACTIVE_JOB_STATES.has(job.status)) jobs.delete(jobId);
      }
      await persistJobs(jobs);
      sendResponse({ ok: true, jobs: publicJobs(jobs) });
    });
    return true;
  }

  if (message.type === "open-downloaded-file") {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: "open-file", path: message.path })
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "reveal-downloaded-file") {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: "reveal-file", path: message.path })
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "clear-media") {
    tabMedia.delete(tabId);
    tabMetaTracks.delete(tabId);
    mediaUpdateSignatures.delete(tabId);
    updateBadge(tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "download-url") {
    ensureNativeDependencies().then((dependencies) => {
      if (!dependencies.ok) throw new Error(dependencies.error || "FFmpeg indisponivel.");
      const filename = filenameFromUrl(message.url, "media");
      return chrome.downloads.download({ url: message.url, filename, saveAs: true });
    })
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "rescan-tab") {
    chrome.tabs.sendMessage(tabId, { type: "scan-now" })
      .catch(() => chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  ensureNativeDependencies();
  getJobs();
});

chrome.runtime.onStartup.addListener(() => {
  ensureNativeDependencies();
  getJobs();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  tabRequestHeaders.delete(tabId);
  tabPlayerState.delete(tabId);
  tabMetaTracks.delete(tabId);
  mediaUpdateSignatures.delete(tabId);
  clearTimeout(mediaUpdateTimers.get(tabId));
  mediaUpdateTimers.delete(tabId);
  videoExtensionRouter.cleanupTab(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabMedia.delete(tabId);
    tabRequestHeaders.delete(tabId);
    tabPlayerState.delete(tabId);
    tabMetaTracks.delete(tabId);
    mediaUpdateSignatures.delete(tabId);
    clearTimeout(mediaUpdateTimers.get(tabId));
    mediaUpdateTimers.delete(tabId);
    updateBadge(tabId);
  }
});
