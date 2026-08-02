const M3U8_RULE_BASE_ID = 200000;
const ruleIdsByTab = new Map();
const activeJobPorts = new Map();

function parseAttributes(value) {
  const attrs = {};
  const parts = value.match(/(?:[^,"]+|"[^"]*")+/g) || [];
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    attrs[part.slice(0, index).trim()] = part.slice(index + 1).trim().replace(/^"|"$/g, "");
  }
  return attrs;
}

function resolutionPixels(resolution) {
  const match = String(resolution || "").match(/^(\d+)x(\d+)$/);
  return match ? Number(match[1]) * Number(match[2]) : 0;
}

export function parseM3u8Summary(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.includes("#EXTM3U")) throw new Error("A origem nao retornou uma playlist HLS valida.");

  const variants = [];
  let durationSeconds = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("#EXTINF:")) {
      durationSeconds += Number(line.slice(line.indexOf(":") + 1).split(",", 1)[0] || 0);
      continue;
    }

    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = parseAttributes(line.slice(line.indexOf(":") + 1));
    let next = "";
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      if (!lines[nextIndex].startsWith("#")) {
        next = lines[nextIndex];
        break;
      }
    }
    if (!next) continue;

    variants.push({
      url: new URL(next, baseUrl).href,
      resolution: attrs.RESOLUTION || "",
      bandwidth: Number(attrs["AVERAGE-BANDWIDTH"] || attrs.BANDWIDTH || 0)
    });
  }

  variants.sort((a, b) => resolutionPixels(b.resolution) - resolutionPixels(a.resolution) || b.bandwidth - a.bandwidth);
  return { variants, durationSeconds };
}

export function inferM3u8Resolution(url) {
  const match = String(url).match(/(?:^|\/)(\d{3,4})p(?:\/|$)/i);
  if (!match) return "";
  const height = Number(match[1]);
  const widths = { 2160: 3840, 1440: 2560, 1080: 1920, 720: 1280, 480: 854, 360: 640, 240: 426 };
  return widths[height] ? `${widths[height]}x${height}` : `${height}p`;
}

export function createM3u8Handler(dependencies) {
  const {
    nativeHost,
    activeJobStates,
    ensureNativeDependencies,
    normalizeUrl,
    createFilenameBase,
    getJobs,
    persistJobs,
    updateJob,
    broadcastJob,
    getReplayHeaders
  } = dependencies;

  async function installHeaderRules(tabId, mediaUrl, pageUrl) {
    if (!tabId || !mediaUrl || !pageUrl) return;

    let mediaHost = "";
    let pageOrigin = "";
    try {
      mediaHost = new URL(mediaUrl).hostname;
      pageOrigin = new URL(pageUrl).origin;
    } catch {
      return;
    }

    const previous = ruleIdsByTab.get(tabId) || [];
    if (previous.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: previous });
    }

    const baseId = M3U8_RULE_BASE_ID + (tabId % 10000) * 2;
    const ruleIds = [baseId, baseId + 1];
    ruleIdsByTab.set(tabId, ruleIds);

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ruleIds,
      addRules: [
        {
          id: baseId,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: pageUrl },
              { header: "Origin", operation: "set", value: pageOrigin }
            ]
          },
          condition: {
            requestDomains: [mediaHost],
            resourceTypes: ["xmlhttprequest"]
          }
        }
      ]
    });
  }

  async function fetchPlaylistText(url, tabId, pageUrl) {
    await installHeaderRules(tabId, url, pageUrl).catch(() => {});
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const requestHeaders = await Promise.resolve(getReplayHeaders(tabId, url)).catch(() => ({}));
        const response = await fetch(url, {
          credentials: "include",
          cache: "no-store",
          headers: requestHeaders
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 450));
      }
    }
    throw new Error(`${lastError?.message || "Falha ao carregar playlist"} em ${url}`);
  }

  async function resolveBestMedia(sourceUrl, tabId, pageUrl) {
    let currentUrl = sourceUrl;
    let resolution = "";
    let bitrateKbps = 0;

    for (let depth = 0; depth < 4; depth += 1) {
      const text = await fetchPlaylistText(currentUrl, tabId, pageUrl);
      const summary = parseM3u8Summary(text, currentUrl);
      if (!summary.variants.length) {
        return {
          url: currentUrl,
          playlistText: text,
          resolution: resolution || inferM3u8Resolution(currentUrl),
          bitrateKbps,
          durationSeconds: summary.durationSeconds
        };
      }

      const best = summary.variants[0];
      currentUrl = best.url;
      resolution = best.resolution || resolution;
      bitrateKbps = best.bandwidth ? Math.round(best.bandwidth / 1000) : bitrateKbps;
    }

    throw new Error("A playlist possui variantes aninhadas demais.");
  }

  async function connectDownloadJob(job, media) {
    const requestHeaders = await Promise.resolve(getReplayHeaders(job.sourceTabId, media.url)).catch(() => ({}));
    const userAgentHeader = Object.entries(requestHeaders).find(([name]) => name.toLowerCase() === "user-agent");
    const port = chrome.runtime.connectNative(nativeHost);
    activeJobPorts.set(job.id, port);
    let finished = false;
    let updateChain = Promise.resolve();

    port.onMessage.addListener((message) => {
      if (message.type === "complete" || message.type === "error") finished = true;
      updateChain = updateChain.then(async () => {
        if (message.type === "started") {
          await updateJob(job.id, {
            status: "downloading",
            phase: "Baixando e processando",
            filename: message.filename || job.filename,
            outputPath: message.output || ""
          }, true);
          return;
        }

        if (message.type === "progress") {
          const percent = Number.isFinite(message.percent) ? message.percent : null;
          const finalizing = message.phase === "Finalizando MP4" || (percent != null && percent >= 99);
          await updateJob(job.id, {
            status: finalizing ? "finalizing" : "downloading",
            phase: message.phase || (finalizing ? "Finalizando MP4" : "Baixando e processando"),
            percent,
            elapsedSeconds: message.elapsedSeconds || 0,
            remainingSeconds: message.remainingSeconds ?? null,
            totalSize: message.totalSize || 0,
            speed: message.speed || ""
          });
          return;
        }

        if (message.type === "complete") {
          await updateJob(job.id, {
            status: "completed",
            phase: "Download concluido",
            percent: 100,
            elapsedSeconds: message.elapsedSeconds || 0,
            remainingSeconds: 0,
            totalSize: message.totalSize || 0,
            filename: message.filename || job.filename,
            outputPath: message.output || job.outputPath,
            completedAt: Date.now(),
            error: ""
          }, true);
          return;
        }

        if (message.type === "error") {
          await updateJob(job.id, {
            status: "error",
            phase: "Erro no download",
            error: message.error || "O FFmpeg nao concluiu o download."
          }, true);
        }
      }).catch(() => {});
    });

    port.onDisconnect.addListener(() => {
      activeJobPorts.delete(job.id);
      if (finished) return;
      const error = chrome.runtime.lastError?.message || "A conexao com o FFmpeg foi encerrada.";
      updateChain = updateChain.then(() => updateJob(job.id, {
        status: "error",
        phase: "Download interrompido",
        error
      }, true)).catch(() => {});
    });

    let pageOrigin = "";
    try {
      pageOrigin = job.pageUrl ? new URL(job.pageUrl).origin : "";
    } catch {}

    port.postMessage({
      action: "download-hls-stream",
      jobId: job.id,
      url: media.url,
      pageUrl: job.pageUrl,
      pageOrigin,
      filenameBase: job.filenameBase,
      durationSeconds: media.durationSeconds || 0,
      playlistText: media.playlistText || "",
      parallelConnections: 4,
      userAgent: userAgentHeader?.[1] || "",
      requestHeaders
    });
  }

  async function start(message, tabId) {
    const dependenciesStatus = await ensureNativeDependencies();
    if (!dependenciesStatus.ok) {
      return { ok: false, error: dependenciesStatus.error || "FFmpeg indisponivel." };
    }

    const jobs = await getJobs();
    const sourceUrl = normalizeUrl(message.url);
    const existing = [...jobs.values()].find((job) => job.sourceUrl === sourceUrl && activeJobStates.has(job.status));
    if (existing) return { ok: true, job: { ...existing }, existing: true };

    const now = new Date();
    const filenameBase = createFilenameBase(now);
    const job = {
      id: crypto.randomUUID(),
      videoExtension: "m3u8",
      sourceUrl,
      mediaUrl: sourceUrl,
      pageUrl: message.pageUrl || "",
      sourceTabId: Number(message.tabId ?? tabId ?? 0),
      filenameBase,
      filename: `${filenameBase}.mp4`,
      outputPath: "",
      status: "preparing",
      phase: "Preparando video",
      percent: null,
      resolution: "",
      bitrateKbps: 0,
      durationSeconds: 0,
      elapsedSeconds: 0,
      remainingSeconds: null,
      totalSize: 0,
      speed: "",
      error: "",
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
      completedAt: null
    };

    jobs.set(job.id, job);
    await persistJobs(jobs);
    broadcastJob(job);

    try {
      const media = await resolveBestMedia(sourceUrl, job.sourceTabId, job.pageUrl);
      Object.assign(job, {
        mediaUrl: media.url,
        resolution: media.resolution,
        bitrateKbps: media.bitrateKbps,
        durationSeconds: media.durationSeconds,
        phase: "Iniciando FFmpeg",
        updatedAt: Date.now()
      });
      await persistJobs(jobs);
      broadcastJob(job);
      await connectDownloadJob(job, media);
      return { ok: true, job: { ...job } };
    } catch (error) {
      await updateJob(job.id, {
        status: "error",
        phase: "Erro ao preparar",
        error: error.message
      }, true);
      return { ok: false, job: { ...jobs.get(job.id) }, error: error.message };
    }
  }

  async function retry(jobId) {
    const jobs = await getJobs();
    const previous = jobs.get(jobId);
    if (!previous) return { ok: false, error: "Download nao encontrado." };
    return start({
      url: previous.sourceUrl,
      pageUrl: previous.pageUrl,
      tabId: previous.sourceTabId
    }, previous.sourceTabId);
  }

  async function cleanupTab(tabId) {
    const ruleIds = ruleIdsByTab.get(tabId);
    if (!ruleIds?.length) return;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
    ruleIdsByTab.delete(tabId);
  }

  return Object.freeze({ id: "m3u8", start, retry, cleanupTab });
}
