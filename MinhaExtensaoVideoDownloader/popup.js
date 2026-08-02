import { detectVideoExtension } from "./videoExtensions/detect.js";
import { getVideoExtensionPresentation } from "./videoExtensions/presentation.js";

const list = document.getElementById("list");
const downloadsList = document.getElementById("downloadsList");
const mediaView = document.getElementById("mediaView");
const downloadsView = document.getElementById("downloadsView");
const mediaToolbar = document.getElementById("mediaToolbar");
const mediaTab = document.getElementById("mediaTab");
const downloadsTab = document.getElementById("downloadsTab");
const mediaCountEl = document.getElementById("mediaCount");
const downloadsCountEl = document.getElementById("downloadsCount");
const statusEl = document.getElementById("status");
const rescanBtn = document.getElementById("rescan");
const clearBtn = document.getElementById("clear");
const clearBtnLabel = clearBtn.querySelector("span:last-child");
const toggleAllBtn = document.getElementById("toggleAll");
const toggleAllLabel = toggleAllBtn.querySelector(".filter-label");
const engineStatusEl = document.getElementById("engineStatus");
const engineStatusLabel = engineStatusEl.querySelector(".engine-label");
const runInstallerBtn = document.getElementById("runInstaller");

const ACTIVE_JOB_STATES = new Set(["preparing", "downloading", "finalizing"]);
const INSTALLER_FILENAME = "DSL-Video-Downloader-Setup.exe";
const INSTALLER_URL = chrome.runtime.getURL(`installer/${INSTALLER_FILENAME}`);

let currentTabId = null;
let currentTabUrl = "";
let currentView = "media";
let mediaStatusText = "Procurando midias...";
let showAll = false;
let lastItems = [];
let downloadJobs = [];
let ffmpegReady = false;
let installerDownloadId = null;
let installerPreparing = null;
let mediaRefreshTimer = null;
const startingUrls = new Set();
const mediaRows = new Map();

function formatSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(remaining)}` : `${pad(minutes)}:${pad(remaining)}`;
}

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function filename(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return "";
  }
}

function videoExtensionFor(item) {
  return detectVideoExtension(item) || "";
}

function managedDownloadItem(item) {
  if (videoExtensionFor(item)) return item;
  if (item.type === "video" || item.type === "audio") {
    return { ...item, videoExtension: "direct" };
  }
  return null;
}

function isManagedVideo(item) {
  return Boolean(getVideoExtensionPresentation(item));
}

function isLikelySegment(item) {
  return /\.(ts|m4s|dts)(?:[?#].*)?$/i.test(item.url) || /\/(?:\d+p\/)?video\d+\.[a-z0-9]+(?:[?#].*)?$/i.test(item.url);
}

function isNoise(item) {
  const name = filename(item.url);
  if (isManagedVideo(item)) return false;
  if (isLikelySegment(item)) return true;
  if (/\.(png|jpe?g|gif|webp|svg|ico)(?:[?#].*)?$/i.test(item.url)) return true;
  if (/\.(oga|ogg|wav|mp3)(?:[?#].*)?$/i.test(item.url) && /crisp|chat|sound|event/i.test(item.url)) return true;
  if ((item.size || 0) <= 64 && /\/key\/|key/i.test(item.url)) return true;
  return !name.includes(".") && (item.size || 0) <= 128;
}

function scoreItem(item) {
  const presentation = getVideoExtensionPresentation(item);
  if (presentation) return presentation.score(item);
  if (item.type === "video" && !isLikelySegment(item)) return 50;
  if (item.type === "audio") return 30;
  return 0;
}

function displayItems(items) {
  const sorted = [...items].sort((a, b) => scoreItem(b) - scoreItem(a) || (b.foundAt || 0) - (a.foundAt || 0));
  return showAll ? sorted : sorted.filter((item) => !isNoise(item));
}

function upsertJob(job) {
  if (!job?.id) return;
  const index = downloadJobs.findIndex((entry) => entry.id === job.id);
  if (index >= 0) downloadJobs[index] = { ...downloadJobs[index], ...job };
  else downloadJobs.unshift({ ...job });
  downloadJobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function latestJobForUrl(url) {
  return downloadJobs.find((job) => job.sourceUrl === url) || null;
}

function isActiveJob(job) {
  return Boolean(job && ACTIVE_JOB_STATES.has(job.status));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  currentTabUrl = tab?.url || "";
  return tab;
}

async function load() {
  const tab = await activeTab();
  if (!tab?.id) return;

  const [mediaResponse, jobsResponse] = await Promise.all([
    chrome.runtime.sendMessage({ type: "get-media", tabId: tab.id }),
    chrome.runtime.sendMessage({ type: "get-download-jobs" })
  ]);
  lastItems = mediaResponse.items || [];
  downloadJobs = jobsResponse.jobs || [];
  renderAll();
}

function mediaItemsSignature(items) {
  return items
    .map((item) => [item.url, item.audioUrl || "", item.mediaKey || "", item.source || "", item.videoExtension || ""].join("|"))
    .sort()
    .join("\n");
}

function scheduleDetectedMediaRefresh(tabId) {
  if (tabId !== currentTabId || mediaRefreshTimer || startingUrls.size || downloadJobs.some(isActiveJob)) return;
  mediaRefreshTimer = window.setTimeout(async () => {
    mediaRefreshTimer = null;
    const response = await chrome.runtime.sendMessage({ type: "get-media", tabId: currentTabId });
    const nextItems = response.items || [];
    if (mediaItemsSignature(nextItems) === mediaItemsSignature(lastItems)) return;
    lastItems = nextItems;
    renderMedia(lastItems);
    switchView(currentView);
  }, 300);
}

function switchView(view) {
  currentView = view;
  const mediaActive = view === "media";
  mediaView.hidden = !mediaActive;
  downloadsView.hidden = mediaActive;
  mediaToolbar.hidden = !mediaActive;
  mediaTab.classList.toggle("active", mediaActive);
  downloadsTab.classList.toggle("active", !mediaActive);
  mediaTab.setAttribute("aria-selected", String(mediaActive));
  downloadsTab.setAttribute("aria-selected", String(!mediaActive));
  rescanBtn.hidden = !mediaActive;

  if (mediaActive) {
    statusEl.textContent = mediaStatusText;
    clearBtnLabel.textContent = "Limpar lista";
    clearBtn.title = "Limpar lista desta aba";
    clearBtn.disabled = false;
    return;
  }

  const activeCount = downloadJobs.filter(isActiveJob).length;
  const finishedCount = downloadJobs.length - activeCount;
  statusEl.textContent = activeCount
    ? `${activeCount} download${activeCount === 1 ? "" : "s"} em andamento`
    : downloadJobs.length
      ? `${downloadJobs.length} download${downloadJobs.length === 1 ? "" : "s"} no historico`
      : "Nenhum download iniciado";
  clearBtnLabel.textContent = "Limpar historico";
  clearBtn.title = "Remover downloads concluidos e com erro";
  clearBtn.disabled = finishedCount === 0;
}

function setDownloadAvailability(available) {
  ffmpegReady = available;
  for (const button of document.querySelectorAll(".download-action")) {
    const active = button.classList.contains("is-loading");
    button.disabled = active || !available;
    if (!active) button.title = available ? button.dataset.readyTitle : "Instale o FFmpeg para liberar o download";
  }
}

function showFfmpegInstalled(response) {
  engineStatusEl.dataset.state = "ready";
  engineStatusLabel.textContent = "FFmpeg instalado";
  engineStatusEl.title = response.ffmpegPath || "FFmpeg instalado";
  runInstallerBtn.hidden = true;
  runInstallerBtn.disabled = true;
  setDownloadAvailability(true);
}

async function ensureDependencies() {
  engineStatusEl.dataset.state = "checking";
  engineStatusLabel.textContent = "Verificando FFmpeg";
  runInstallerBtn.hidden = true;
  runInstallerBtn.disabled = true;
  setDownloadAvailability(false);
  try {
    const response = await chrome.runtime.sendMessage({ type: "ensure-native-dependencies" });
    if (!response?.ok) throw new Error(response?.error || "FFmpeg indisponivel.");
    showFfmpegInstalled(response);
  } catch (error) {
    engineStatusEl.dataset.state = "error";
    engineStatusLabel.textContent = "FFmpeg indisponivel";
    engineStatusEl.title = `Clique para instalar. ${error.message}`;
    runInstallerBtn.hidden = false;
    runInstallerBtn.disabled = true;
    runInstallerBtn.title = "Baixe o instalador primeiro";
    setDownloadAvailability(false);
    restorePreparedInstaller().catch(() => {});
  }
}

async function monitorFfmpegInstallation() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    try {
      const response = await chrome.runtime.sendMessage({ type: "ensure-native-dependencies" });
      if (response?.ok) {
        showFfmpegInstalled(response);
        return;
      }
    } catch {}
  }

  engineStatusEl.dataset.state = "error";
  engineStatusLabel.textContent = "FFmpeg indisponivel";
  engineStatusEl.title = "A instalacao nao foi detectada. Execute o instalador novamente";
  runInstallerBtn.hidden = false;
  runInstallerBtn.disabled = false;
  setDownloadAvailability(false);
}

async function restorePreparedInstaller() {
  const manifestVersion = chrome.runtime.getManifest().version;
  const { nativeInstaller } = await chrome.storage.local.get("nativeInstaller");
  if (nativeInstaller?.version !== manifestVersion || !nativeInstaller.downloadId) return null;

  const [existing] = await chrome.downloads.search({ id: nativeInstaller.downloadId });
  if (existing?.state !== "complete" || !existing.exists) return null;

  installerDownloadId = existing.id;
  runInstallerBtn.hidden = false;
  runInstallerBtn.disabled = false;
  runInstallerBtn.title = "Executar instalador do FFmpeg";
  return existing.id;
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(new Error("O instalador demorou demais para ficar pronto."));
    }, 30000);

    function finish(callback, value) {
      window.clearTimeout(timeoutId);
      chrome.downloads.onChanged.removeListener(onChanged);
      callback(value);
    }

    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") finish(resolve, downloadId);
      if (delta.state?.current === "interrupted") finish(reject, new Error(delta.error?.current || "Download do instalador interrompido."));
    }

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === "complete") finish(resolve, downloadId);
      if (item?.state === "interrupted") finish(reject, new Error(item.error || "Download do instalador interrompido."));
    });
  });
}

async function prepareInstaller() {
  if (installerPreparing) return installerPreparing;

  installerPreparing = (async () => {
    const manifestVersion = chrome.runtime.getManifest().version;
    const { nativeInstaller } = await chrome.storage.local.get("nativeInstaller");
    const candidateId = installerDownloadId || (nativeInstaller?.version === manifestVersion ? nativeInstaller.downloadId : null);

    if (candidateId) {
      const [existing] = await chrome.downloads.search({ id: candidateId });
      if (existing?.state === "complete" && existing.exists) {
        installerDownloadId = existing.id;
        return existing.id;
      }
      if (existing?.state === "in_progress") {
        installerDownloadId = existing.id;
        await waitForDownload(existing.id);
        return existing.id;
      }
    }

    const downloadId = await chrome.downloads.download({
      url: INSTALLER_URL,
      filename: `DSL Video Downloader/${INSTALLER_FILENAME}`,
      conflictAction: "overwrite",
      saveAs: false
    });
    installerDownloadId = downloadId;
    await chrome.storage.local.set({ nativeInstaller: { version: manifestVersion, downloadId } });
    await waitForDownload(downloadId);
    return downloadId;
  })().finally(() => {
    installerPreparing = null;
  });

  return installerPreparing;
}

function createProgress(job) {
  const container = document.createElement("div");
  container.className = `job-progress state-${job.status}`;

  const facts = document.createElement("div");
  facts.className = "job-facts";
  const quality = [
    job.resolution,
    job.bitrateKbps ? `${job.bitrateKbps} kbps` : "",
    `${formatDuration(job.elapsedSeconds)} decorrido`
  ].filter(Boolean);
  if (!job.resolution && job.status === "preparing") quality.unshift("Qualidade maxima");
  facts.textContent = quality.join(" \u00b7 ");

  const track = document.createElement("div");
  track.className = "job-progress-track";
  const fill = document.createElement("span");
  fill.className = "job-progress-fill";
  if (Number.isFinite(job.percent)) fill.style.width = `${Math.max(0, Math.min(100, job.percent))}%`;
  else if (isActiveJob(job)) track.classList.add("indeterminate");
  track.append(fill);

  const state = document.createElement("div");
  state.className = "job-state-row";
  const phase = document.createElement("span");
  phase.className = "job-phase";
  phase.textContent = job.phase || "Preparando video";
  const value = document.createElement("span");
  value.className = "job-progress-value";
  value.textContent = Number.isFinite(job.percent) ? `${Math.round(job.percent)}%` : "";
  state.append(phase, value);

  container.append(facts, track, state);

  if (job.status === "completed") {
    const result = document.createElement("div");
    result.className = "job-result success";
    const play = document.createElement("button");
    play.className = "video-play-button";
    play.type = "button";
    play.title = "Abrir video";
    play.setAttribute("aria-label", "Abrir video");
    play.disabled = !job.outputPath;
    const playIcon = document.createElement("span");
    playIcon.setAttribute("aria-hidden", "true");
    play.append(playIcon);
    play.addEventListener("click", async () => {
      const response = await chrome.runtime.sendMessage({ type: "open-downloaded-file", path: job.outputPath });
      if (!response?.ok) play.title = response?.error || "Arquivo nao encontrado";
    });
    const message = document.createElement("span");
    message.textContent = `${job.filename} salvo em Downloads`;
    result.append(play, message);
    container.append(result);
  } else if (job.status === "error") {
    const result = document.createElement("div");
    result.className = "job-result error";
    const icon = document.createElement("span");
    icon.className = "job-error-icon";
    icon.textContent = "!";
    const message = document.createElement("span");
    message.textContent = job.error || "Nao foi possivel concluir o download";
    message.title = job.error || "";
    result.append(icon, message);
    container.append(result);
  }

  return container;
}

async function startVideoDownload(item, previousJob = null) {
  if (!ffmpegReady || startingUrls.has(item.url)) return;
  startingUrls.add(item.url);
  syncMediaRow(item.url, previousJob);
  renderDownloads();
  switchView(currentView);

  try {
    const response = previousJob?.status === "error"
      ? await chrome.runtime.sendMessage({ type: "retry-video-download", jobId: previousJob.id })
      : await chrome.runtime.sendMessage({
        type: "start-video-download",
        videoExtension: videoExtensionFor(item),
        url: item.url,
        mediaType: item.type,
        contentType: item.contentType || "",
        pageUrl: item.pageUrl || currentTabUrl,
        audioUrl: item.audioUrl || "",
        durationSeconds: Number(item.durationSeconds || 0),
        resolution: item.resolution || "",
        bitrateKbps: Number(item.bitrateKbps || 0),
        userAgent: item.userAgent || navigator.userAgent,
        tabId: currentTabId
      });
    if (response?.job) {
      upsertJob(response.job);
      syncMediaRow(item.url, response.job);
    }
  } finally {
    startingUrls.delete(item.url);
    syncMediaRow(item.url);
    renderDownloads();
    switchView(currentView);
  }
}

function syncMediaRow(url, job = latestJobForUrl(url)) {
  const view = mediaRows.get(url);
  if (!view) return;

  const active = startingUrls.has(url) || isActiveJob(job);
  view.download.classList.toggle("is-loading", active);
  view.download.disabled = active || !ffmpegReady;
  view.download.title = active
    ? "Download em andamento"
    : ffmpegReady
      ? view.download.dataset.readyTitle
      : "Instale o FFmpeg para liberar o download";

  if (active) {
    if (!view.downloadIcon.classList.contains("action-spinner")) {
      view.downloadIcon.className = "action-spinner";
    }
    view.downloadLabel.textContent = "";
  } else {
    if (!view.downloadIcon.classList.contains("download-mini-icon")) {
      view.downloadIcon.className = "download-mini-icon";
    }
    view.downloadLabel.textContent = "";
    if (job?.status === "error" && ffmpegReady) view.download.title = "Tentar download novamente";
  }

  const currentProgress = view.row.querySelector(":scope > .job-progress");
  if (!job) {
    currentProgress?.remove();
    return;
  }

  const nextProgress = createProgress(job);
  if (currentProgress) currentProgress.replaceWith(nextProgress);
  else view.row.append(nextProgress);
}

function renderMedia(items) {
  const visibleItems = displayItems(items);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);
  const mediaLabel = visibleItems.length === 1 ? "1 midia encontrada" : `${visibleItems.length} midias encontradas`;
  mediaStatusText = visibleItems.length ? `${mediaLabel}${hiddenCount ? ` \u00b7 ${hiddenCount} oculto${hiddenCount === 1 ? "" : "s"}` : ""}` : "Nada encontrado nesta aba";
  toggleAllLabel.textContent = showAll ? "Ocultar extras" : `Mostrar tudo${hiddenCount ? ` (${hiddenCount})` : ""}`;
  mediaCountEl.textContent = String(visibleItems.length);
  list.textContent = "";
  mediaRows.clear();

  if (!visibleItems.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Reproduza o video na pagina e clique em Revarrer.";
    list.append(empty);
    return;
  }

  for (const item of visibleItems) {
    const row = document.createElement("article");
    row.className = "item";
    if (scoreItem(item) >= 90) row.classList.add("recommended");

    const info = document.createElement("div");
    info.className = "item-info";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = item.title || "midia";
    const meta = document.createElement("div");
    meta.className = "meta";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = item.type || "media";
    meta.append(tag, document.createTextNode([item.source, formatSize(item.size), hostname(item.url)].filter(Boolean).join(" \u00b7 ")));
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = item.url;
    info.append(title, meta);

    if (scoreItem(item) >= 90) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = getVideoExtensionPresentation(item)?.hint(item) || "";
      info.append(hint);
    }
    info.append(url);

    const actions = document.createElement("div");
    actions.className = "actions";
    const copy = document.createElement("button");
    copy.className = "copy-action";
    copy.title = "Copiar URL";
    copy.setAttribute("aria-label", "Copiar URL");
    const copyIcon = document.createElement("span");
    copyIcon.className = "copy-icon";
    copyIcon.setAttribute("aria-hidden", "true");
    copy.append(copyIcon);
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(item.url);
      copy.style.color = "var(--blue-soft)";
      window.setTimeout(() => copy.style.removeProperty("color"), 900);
    });

    const job = latestJobForUrl(item.url);
    const presentation = getVideoExtensionPresentation(item);
    const starting = startingUrls.has(item.url);
    const active = starting || isActiveJob(job);
    const download = document.createElement("button");
    download.className = `download-action icon-only${active ? " is-loading" : ""}`;
    download.dataset.readyTitle = presentation?.downloadTitle || "Baixar";
    download.title = active ? "Download em andamento" : ffmpegReady ? download.dataset.readyTitle : "Instale o FFmpeg para liberar o download";
    download.disabled = active || !ffmpegReady;
    const downloadIcon = document.createElement("span");
    downloadIcon.className = active ? "action-spinner" : "download-mini-icon";
    downloadIcon.setAttribute("aria-hidden", "true");
    const downloadLabel = document.createElement("span");
    downloadLabel.textContent = "";
    download.append(downloadIcon, downloadLabel);
    download.addEventListener("click", async () => {
      const currentJob = latestJobForUrl(item.url);
      if (!ffmpegReady || startingUrls.has(item.url) || isActiveJob(currentJob)) return;
      const managedItem = managedDownloadItem(item);
      if (managedItem) await startVideoDownload(managedItem, currentJob);
      else await chrome.runtime.sendMessage({ type: "download-url", url: item.url });
    });

    actions.append(copy, download);
    row.append(info, actions);
    if (job) row.append(createProgress(job));
    list.append(row);
    mediaRows.set(item.url, { row, item, presentation, download, downloadIcon, downloadLabel });
  }
}

function renderDownloads() {
  downloadsList.textContent = "";
  downloadsCountEl.textContent = String(downloadJobs.length);
  downloadsTab.classList.toggle("has-active", downloadJobs.some(isActiveJob));

  if (!downloadJobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty downloads-empty";
    empty.textContent = "Nenhum download iniciado.";
    downloadsList.append(empty);
    return;
  }

  for (const job of downloadJobs) {
    const row = document.createElement("article");
    row.className = "download-job";
    const header = document.createElement("div");
    header.className = "download-job-header";
    const heading = document.createElement("div");
    heading.className = "download-job-heading";
    const name = document.createElement("div");
    name.className = "download-job-name";
    name.textContent = job.filename || `${job.filenameBase}.mp4`;
    const origin = document.createElement("div");
    origin.className = "download-job-origin";
    origin.textContent = hostname(job.sourceUrl);
    heading.append(name, origin);
    header.append(heading);

    if (!isActiveJob(job)) {
      const dismiss = document.createElement("button");
      dismiss.className = "dismiss-job";
      dismiss.type = "button";
      dismiss.title = "Remover da lista";
      dismiss.setAttribute("aria-label", "Remover da lista");
      dismiss.textContent = "x";
      dismiss.addEventListener("click", async () => {
        const response = await chrome.runtime.sendMessage({ type: "dismiss-download-job", jobId: job.id });
        downloadJobs = response.jobs || downloadJobs.filter((entry) => entry.id !== job.id);
        renderAll();
      });
      header.append(dismiss);
    }

    row.append(header, createProgress(job));

    if (job.status === "error") {
      const retry = document.createElement("button");
      retry.className = "retry-job";
      retry.type = "button";
      retry.textContent = "Tentar novamente";
      retry.disabled = !ffmpegReady;
      retry.addEventListener("click", async () => {
        const response = await chrome.runtime.sendMessage({ type: "retry-video-download", jobId: job.id });
        if (response?.job) {
          upsertJob(response.job);
          syncMediaRow(response.job.sourceUrl, response.job);
        }
        renderDownloads();
        switchView(currentView);
      });
      row.append(retry);
    }

    downloadsList.append(row);
  }
}

function renderAll() {
  renderMedia(lastItems);
  renderDownloads();
  switchView(currentView);
}

engineStatusEl.addEventListener("click", async () => {
  if (engineStatusEl.dataset.state !== "error") return;
  engineStatusEl.dataset.state = "checking";
  engineStatusLabel.textContent = "Baixando instalador";
  engineStatusEl.title = "Aguarde o download terminar";
  runInstallerBtn.hidden = false;
  runInstallerBtn.disabled = true;
  runInstallerBtn.title = "Download em andamento";

  try {
    installerDownloadId = await prepareInstaller();
    engineStatusEl.dataset.state = "error";
    engineStatusLabel.textContent = "FFmpeg indisponivel";
    engineStatusEl.title = "Instalador baixado. Clique no icone do Windows para executar";
    runInstallerBtn.disabled = false;
    runInstallerBtn.title = "Executar instalador do FFmpeg";
  } catch (error) {
    engineStatusEl.dataset.state = "error";
    engineStatusLabel.textContent = "Falha no download";
    engineStatusEl.title = error.message;
    runInstallerBtn.disabled = true;
  }
});

runInstallerBtn.addEventListener("click", async () => {
  if (!installerDownloadId || runInstallerBtn.disabled) return;
  try {
    await chrome.downloads.open(installerDownloadId);
    engineStatusEl.dataset.state = "checking";
    engineStatusLabel.textContent = "Instalando FFmpeg";
    engineStatusEl.title = "Aguardando a instalacao terminar";
    runInstallerBtn.disabled = true;
    setDownloadAvailability(false);
    monitorFfmpegInstallation().catch(() => {});
  } catch (error) {
    installerDownloadId = null;
    await chrome.storage.local.remove("nativeInstaller");
    engineStatusEl.dataset.state = "error";
    engineStatusLabel.textContent = "Baixe novamente";
    engineStatusEl.title = error.message;
    runInstallerBtn.disabled = true;
    setDownloadAvailability(false);
  }
});

mediaTab.addEventListener("click", () => switchView("media"));
downloadsTab.addEventListener("click", () => switchView("downloads"));

rescanBtn.addEventListener("click", async () => {
  if (!currentTabId) await activeTab();
  await chrome.runtime.sendMessage({ type: "rescan-tab", tabId: currentTabId });
  window.setTimeout(load, 600);
});

clearBtn.addEventListener("click", async () => {
  if (currentView === "downloads") {
    const response = await chrome.runtime.sendMessage({ type: "clear-download-history" });
    downloadJobs = response.jobs || downloadJobs.filter(isActiveJob);
    renderAll();
    return;
  }

  if (!currentTabId) await activeTab();
  await chrome.runtime.sendMessage({ type: "clear-media", tabId: currentTabId });
  await load();
});

toggleAllBtn.addEventListener("click", () => {
  showAll = !showAll;
  renderAll();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "media-list-updated") {
    scheduleDetectedMediaRefresh(message.tabId);
    return;
  }
  if (message.type !== "download-job-update" || !message.job) return;
  upsertJob(message.job);
  startingUrls.delete(message.job.sourceUrl);
  syncMediaRow(message.job.sourceUrl, message.job);
  renderDownloads();
  switchView(currentView);
});

load();
ensureDependencies();
