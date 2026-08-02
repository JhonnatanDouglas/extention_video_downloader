(() => {
  if (window.__dslVideoDeepSearchInstalled) return;
  if (!/(?:^|\.)(?:facebook|instagram)\.com$/i.test(location.hostname)) return;
  window.__dslVideoDeepSearchInstalled = true;

  const CHANNEL = "dsl-video-downloader-worker-media-v1";
  const NativeWorker = window.Worker;
  const emitted = new Set();
  const mediaExtension = /\.(?:m3u8|mpd|mp4|webm|m4a|aac)(?:$|[?#])/i;
  const mediaEndpoint = /\/(?:video|audio)_redirect\/|\/aweme\/v1\/play\//i;

  function emit(url, contentType = "", source = "page") {
    if (typeof url !== "string") return;
    let resolved;
    try {
      resolved = new URL(url, location.href).href;
    } catch {
      return;
    }
    if (!/^https?:/i.test(resolved)) return;
    if (!mediaExtension.test(resolved) && !mediaEndpoint.test(resolved) && !/^(?:video|audio)\//i.test(contentType)) return;

    let dedupeUrl = resolved;
    try {
      const parsed = new URL(resolved);
      if (/(?:^|\.)fbcdn\.net$/i.test(parsed.hostname) && /\.mp4$/i.test(parsed.pathname)) {
        parsed.searchParams.delete("bytestart");
        parsed.searchParams.delete("byteend");
        dedupeUrl = parsed.href;
      }
    } catch {
    }

    const key = `${dedupeUrl}\n${contentType}`;
    if (emitted.has(key)) return;
    if (emitted.size >= 2000) emitted.clear();
    emitted.add(key);
    window.postMessage({ channel: CHANNEL, type: "media", url: resolved, contentType, source }, "*");
  }

  function scan(value, source, depth = 0, seen = new WeakSet()) {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      emit(value, "", source);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < Math.min(value.length, 500); index += 1) {
        scan(value[index], source, depth + 1, seen);
      }
      return;
    }
    let count = 0;
    for (const key of Object.keys(value)) {
      scan(value[key], source, depth + 1, seen);
      count += 1;
      if (count >= 500) break;
    }
  }

  const nativeJsonParse = JSON.parse;
  JSON.parse = function dslJsonParse(...args) {
    const result = nativeJsonParse.apply(this, args);
    Promise.resolve().then(() => scan(result, "page-json")).catch(() => {});
    return result;
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = async function dslFetch(...args) {
      const response = await nativeFetch.apply(this, args);
      const contentType = response.headers?.get("content-type") || "";
      emit(response.url || String(args[0]?.url || args[0] || ""), contentType, "page-fetch");
      if (/json|text|javascript|mpegurl|dash\+xml/i.test(contentType)) {
        response.clone().text().then((text) => {
          if (text.length > 5 * 1024 * 1024) return;
          try {
            scan(nativeJsonParse(text), "page-fetch-data");
          } catch {
          }
        }).catch(() => {});
      }
      return response;
    };
  }

  const xhrPrototype = window.XMLHttpRequest?.prototype;
  if (xhrPrototype) {
    const nativeOpen = xhrPrototype.open;
    const requestUrls = new WeakMap();
    xhrPrototype.open = function dslXhrOpen(method, url, ...rest) {
      requestUrls.set(this, String(url || ""));
      this.addEventListener("loadend", () => {
        let contentType = "";
        try {
          contentType = this.getResponseHeader("content-type") || "";
        } catch {
        }
        emit(this.responseURL || requestUrls.get(this) || "", contentType, "page-xhr");
        try {
          if (this.responseType === "json") scan(this.response, "page-xhr-data");
          else if ((!this.responseType || this.responseType === "text") && /json|text|javascript/i.test(contentType)) {
            const text = this.responseText || "";
            if (text.length <= 5 * 1024 * 1024) scan(nativeJsonParse(text), "page-xhr-data");
          }
        } catch {
        }
      }, { once: true });
      return nativeOpen.call(this, method, url, ...rest);
    };
  }

  function observeWorker(worker) {
    const nativePostMessage = worker.postMessage;
    worker.postMessage = function dslWorkerPostMessage(message, ...rest) {
      Promise.resolve().then(() => scan(message, "worker-input")).catch(() => {});
      return nativePostMessage.call(this, message, ...rest);
    };
    worker.addEventListener("message", (event) => {
      Promise.resolve().then(() => scan(event.data, "worker-output")).catch(() => {});
    }, true);
    return worker;
  }

  if (typeof NativeWorker === "function") {
    function DslWorker(scriptUrl, options) {
      return observeWorker(new NativeWorker(scriptUrl, options));
    }
    Object.setPrototypeOf(DslWorker, NativeWorker);
    DslWorker.prototype = NativeWorker.prototype;
    Object.defineProperty(DslWorker, "name", { value: "Worker" });
    window.Worker = DslWorker;
  }
})();
