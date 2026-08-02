(() => {
  if (window.__meuBaixadorVideosAtivo) return;
  window.__meuBaixadorVideosAtivo = true;

  const MEDIA_EXTENSIONS = /\.(m3u8|mpd|mp4|webm|mov|m4v|mkv|avi|flv|ts|m4s|mp3|m4a|aac|ogg|opus|wav)(?:[?#].*)?$/i;
  const DEEP_SEARCH_CHANNEL = "dsl-video-downloader-worker-media-v1";
  const META_CDN = /(?:^|\.)(?:fbcdn\.net|cdninstagram\.com)$/i;

  function absoluteUrl(value) {
    if (!value || value.startsWith("blob:") || value.startsWith("data:")) return "";
    try {
      return new URL(value, location.href).href;
    } catch {
      return "";
    }
  }

  function typeFromUrl(url) {
    if (/\.mpd(?:[?#].*)?$/i.test(url)) return "dash";
    if (/\.(mp3|m4a|aac|ogg|opus|wav)(?:[?#].*)?$/i.test(url)) return "audio";
    return "video";
  }

  function tiktokMediaKey(value = location.href) {
    try {
      const itemId = new URL(value, location.href).pathname.match(/\/video\/(\d+)/)?.[1] || "";
      return itemId ? `tiktok:${itemId}` : "";
    } catch {
      return "";
    }
  }

  function titleFromUrl(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "media");
    } catch {
      return "media";
    }
  }

  function playerVisibility(video) {
    const rect = video.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function activePlayer() {
    const candidates = [...document.querySelectorAll("video")]
      .map((video) => ({
        video,
        visibleArea: playerVisibility(video),
        playing: !video.paused && !video.ended,
        durationSeconds: Number.isFinite(video.duration) ? video.duration : 0
      }));
    const visible = candidates
      .filter((candidate) => candidate.visibleArea > 0)
      .sort((a, b) => b.visibleArea - a.visibleArea || Number(b.playing) - Number(a.playing));
    if (visible.length) return visible[0];

    return candidates
      .filter((candidate) => candidate.playing)
      .sort((a, b) => b.durationSeconds - a.durationSeconds)[0] || null;
  }

  function collect(player = activePlayer()) {
    const found = new Map();

    function add(url, source, extra = {}) {
      const resolved = absoluteUrl(url);
      const declaredMedia = extra.videoExtension || /^(?:video|audio)\//i.test(extra.contentType || "");
      if (!resolved || (!MEDIA_EXTENSIONS.test(resolved) && !declaredMedia)) return;
      found.set(resolved, {
        url: resolved,
        title: titleFromUrl(resolved),
        pageUrl: location.href,
        type: typeFromUrl(resolved),
        source,
        ...extra
      });
    }

    document.querySelectorAll("video,audio,source,track").forEach((node) => {
      add(node.currentSrc || node.src, node.tagName.toLowerCase());
      add(node.getAttribute("src"), node.tagName.toLowerCase());
    });

    document.querySelectorAll("a[href]").forEach((node) => {
      add(node.href, "link");
    });

    for (const entry of performance.getEntriesByType("resource")) {
      add(entry.name, "performance");
    }

    if (player) {
      const { video } = player;
      const playerUrl = absoluteUrl(video.currentSrc || video.src || video.getAttribute("src"));
      if (playerUrl) {
        let playerHost = "";
        try {
          playerHost = new URL(playerUrl).hostname;
        } catch {
        }
        if (!META_CDN.test(playerHost) && !/\.m3u8(?:[?#]|$)|\.mpd(?:[?#]|$)/i.test(playerUrl)) {
          add(playerUrl, "player", {
            videoExtension: "direct",
            contentType: "video/mp4",
            mediaKey: tiktokMediaKey(),
            durationSeconds: player.durationSeconds,
            resolution: video.videoWidth && video.videoHeight ? `${video.videoWidth}x${video.videoHeight}` : "",
            userAgent: navigator.userAgent
          });
        }
      }
    }

    return [...found.values()];
  }

  function playerState(player = activePlayer()) {
    if (!player) return null;
    const { video } = player;
    return {
      pageUrl: location.href,
      sourceUrl: absoluteUrl(video.currentSrc || video.src || video.getAttribute("src")),
      durationSeconds: player.durationSeconds,
      resolution: video.videoWidth && video.videoHeight ? `${video.videoWidth}x${video.videoHeight}` : "",
      currentTime: Number(video.currentTime || 0),
      isPlaying: player.playing,
      visibleArea: player.visibleArea,
      mediaKey: tiktokMediaKey(),
      userAgent: navigator.userAgent,
      observedAt: Date.now()
    };
  }

  let timer = null;
  let observer = null;
  let extensionContextActive = true;

  function deactivateExtensionContext() {
    extensionContextActive = false;
    clearTimeout(timer);
    observer?.disconnect();
    document.removeEventListener("loadedmetadata", sendScan, true);
    document.removeEventListener("play", sendScan, true);
    window.removeEventListener("message", receiveDeepSearchMedia);
  }

  function safeSendMessage(message) {
    if (!extensionContextActive) return Promise.resolve(null);
    try {
      if (!chrome.runtime?.id) {
        deactivateExtensionContext();
        return Promise.resolve(null);
      }
      return chrome.runtime.sendMessage(message).catch((error) => {
        if (/extension context invalidated/i.test(error?.message || "")) deactivateExtensionContext();
        return null;
      });
    } catch {
      deactivateExtensionContext();
      return Promise.resolve(null);
    }
  }

  function sendScan() {
    if (!extensionContextActive) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const player = activePlayer();
      const items = collect(player);
      if (items.length) safeSendMessage({ type: "page-media", items });
      const state = playerState(player);
      if (state) safeSendMessage({ type: "player-state", state });
    }, 300);
  }

  function receiveDeepSearchMedia(event) {
    const data = event.data;
    if (event.source !== window || !data || data.channel !== DEEP_SEARCH_CHANNEL || data.type !== "media") return;
    const url = absoluteUrl(data.url);
    if (!url) return;
    safeSendMessage({
      type: "page-media",
      items: [{
        url,
        title: titleFromUrl(url),
        pageUrl: location.href,
        type: /audio/i.test(data.contentType || "") ? "audio" : "video",
        contentType: data.contentType || "",
        source: data.source || "worker"
      }]
    });
  }

  sendScan();
  document.addEventListener("loadedmetadata", sendScan, true);
  document.addEventListener("play", sendScan, true);
  window.addEventListener("message", receiveDeepSearchMedia);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "scan-now") return false;
    const player = activePlayer();
    const items = collect(player);
    safeSendMessage({ type: "page-media", items }).finally(() => {
      try {
        sendResponse({ ok: true, count: items.length });
      } catch {
      }
    });
    const state = playerState(player);
    if (state) safeSendMessage({ type: "player-state", state });
    return true;
  });

  observer = new MutationObserver(sendScan);
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "href"]
    });
  }
})();
