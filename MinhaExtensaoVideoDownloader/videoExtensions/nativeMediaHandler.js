const activeJobPorts = new Map();

async function connectDownloadJob(dependencies, job, payload) {
  const { nativeHost, updateJob, getReplayHeaders } = dependencies;
  const requestHeaders = typeof getReplayHeaders === "function"
    ? await Promise.resolve(getReplayHeaders(job.sourceTabId, job.mediaUrl)).catch(() => ({}))
    : {};
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
    const runtimeError = chrome.runtime.lastError?.message || "";
    activeJobPorts.delete(job.id);
    if (finished) return;
    const error = runtimeError || "A conexao com o FFmpeg foi encerrada.";
    updateChain = updateChain.then(() => updateJob(job.id, {
      status: "error",
      phase: "Download interrompido",
      error
    }, true)).catch(() => {});
  });

  let pageOrigin = "";
  try {
    pageOrigin = job.pageUrl ? new URL(job.pageUrl).origin : "";
  } catch {
  }

  port.postMessage({
    ...payload,
    jobId: job.id,
    pageUrl: job.pageUrl,
    pageOrigin,
    filenameBase: job.filenameBase,
    durationSeconds: job.durationSeconds || 0,
    userAgent: job.userAgent || "",
    requestHeaders
  });
}

export function createNativeMediaHandler(dependencies, configuration) {
  const {
    activeJobStates,
    ensureNativeDependencies,
    normalizeUrl,
    createFilenameBase,
    getJobs,
    persistJobs,
    updateJob,
    broadcastJob
  } = dependencies;
  const { id, action, createPayload } = configuration;

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
      videoExtension: id,
      sourceUrl,
      mediaUrl: sourceUrl,
      audioUrl: message.audioUrl ? normalizeUrl(message.audioUrl) : "",
      pageUrl: message.pageUrl || "",
      sourceTabId: Number(message.tabId ?? tabId ?? 0),
      filenameBase,
      filename: `${filenameBase}.mp4`,
      outputPath: "",
      status: "preparing",
      phase: "Preparando video",
      percent: null,
      resolution: message.resolution || "",
      bitrateKbps: Number(message.bitrateKbps || 0),
      durationSeconds: Number(message.durationSeconds || 0),
      elapsedSeconds: 0,
      remainingSeconds: null,
      totalSize: 0,
      speed: "",
      userAgent: message.userAgent || "",
      error: "",
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
      completedAt: null
    };

    jobs.set(job.id, job);
    await persistJobs(jobs);
    broadcastJob(job);

    try {
      await connectDownloadJob(dependencies, job, {
        action,
        ...createPayload(job)
      });
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
    return start({ ...previous, url: previous.sourceUrl, tabId: previous.sourceTabId }, previous.sourceTabId);
  }

  return Object.freeze({ id, start, retry });
}
