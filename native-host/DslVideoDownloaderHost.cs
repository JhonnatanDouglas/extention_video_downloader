using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class DslVideoDownloaderHost
{
    private const int HostApiVersion = 3;
    private const int DefaultParallelConnections = 4;
    private static readonly object OutputLock = new object();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer
    {
        MaxJsonLength = Int32.MaxValue,
        RecursionLimit = 128
    };

    private sealed class HlsAsset
    {
        public string Url;
        public string LocalName;
        public long? RangeStart;
        public long? RangeLength;
    }

    private sealed class HlsPlan
    {
        public string PlaylistText;
        public List<HlsAsset> Assets = new List<HlsAsset>();
        public bool CanPrefetch;
        public string FallbackReason;
    }

    private sealed class DownloadProgress
    {
        private readonly string _jobId;
        private readonly int _totalAssets;
        private readonly Stopwatch _timer;
        private readonly object _sync = new object();
        private int _completedAssets;
        private long _downloadedBytes;
        private long _lastReportMilliseconds;

        public DownloadProgress(string jobId, int totalAssets, Stopwatch timer)
        {
            _jobId = jobId;
            _totalAssets = Math.Max(1, totalAssets);
            _timer = timer;
        }

        public void AssetCompleted(long bytes)
        {
            lock (_sync)
            {
                _completedAssets += 1;
                _downloadedBytes += Math.Max(0, bytes);
                long elapsedMilliseconds = Math.Max(1, _timer.ElapsedMilliseconds);
                if (_completedAssets < _totalAssets && elapsedMilliseconds - _lastReportMilliseconds < 150)
                {
                    return;
                }

                _lastReportMilliseconds = elapsedMilliseconds;
                double fraction = Math.Min(1.0, (double)_completedAssets / _totalAssets);
                double elapsedSeconds = elapsedMilliseconds / 1000.0;
                double remainingSeconds = fraction > 0 ? elapsedSeconds * (1.0 - fraction) / fraction : 0;
                double megabytesPerSecond = _downloadedBytes / 1048576.0 / Math.Max(0.001, elapsedSeconds);

                SendMessage(new Dictionary<string, object>
                {
                    { "type", "progress" },
                    { "jobId", _jobId },
                    { "phase", "Baixando segmentos em paralelo" },
                    { "percent", Math.Round(fraction * 92.0, 2) },
                    { "elapsedSeconds", Math.Round(elapsedSeconds, 2) },
                    { "remainingSeconds", Math.Round(remainingSeconds, 2) },
                    { "totalSize", _downloadedBytes },
                    { "speed", String.Format(CultureInfo.InvariantCulture, "{0:0.0} MB/s", megabytesPerSecond) },
                    { "completedSegments", _completedAssets },
                    { "totalSegments", _totalAssets }
                });
            }
        }
    }

    private sealed class FfmpegResult
    {
        public int ExitCode;
        public string Error;
    }

    public static void Main()
    {
        try
        {
            ServicePointManager.DefaultConnectionLimit = 64;
            ServicePointManager.Expect100Continue = false;
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;

            Dictionary<string, object> message = ReadMessage();
            if (message == null)
            {
                return;
            }

            string action = GetString(message, "action");
            if (action == "ensure-ffmpeg" || action == "check-ffmpeg")
            {
                SendMessage(CheckDependencies());
                return;
            }

            if (action == "open-file")
            {
                SendMessage(OpenDownloadedFile(message));
                return;
            }

            if (action == "download-hls-stream" || action == "download-direct-media" || action == "download-media-pair")
            {
                RunMediaDownload(message, action);
                return;
            }

            SendMessage(ErrorResponse("Acao desconhecida no componente local."));
        }
        catch (Exception error)
        {
            SendMessage(ErrorResponse(FlattenError(error)));
        }
    }

    private static void RunMediaDownload(Dictionary<string, object> message, string action)
    {
        string ffmpeg = FindFfmpeg();
        if (String.IsNullOrEmpty(ffmpeg))
        {
            SendMessage(ErrorResponse("FFmpeg nao encontrado no Windows."));
            return;
        }

        string jobId = GetString(message, "jobId");
        string filenameBase = SafeName(GetString(message, "filenameBase"));
        if (String.IsNullOrWhiteSpace(filenameBase))
        {
            filenameBase = FallbackName();
        }

        string outputPath = UniqueOutputPath(filenameBase);
        string filename = Path.GetFileName(outputPath);
        Stopwatch timer = Stopwatch.StartNew();

        SendMessage(new Dictionary<string, object>
        {
            { "type", "started" },
            { "jobId", jobId },
            { "filename", filename },
            { "output", outputPath },
            { "hostApiVersion", HostApiVersion }
        });

        try
        {
            double durationSeconds = GetDouble(message, "durationSeconds");
            FfmpegResult result;

            if (action == "download-hls-stream")
            {
                result = RunHlsDownload(ffmpeg, message, outputPath, jobId, durationSeconds, timer);
            }
            else
            {
                string arguments = action == "download-media-pair"
                    ? BuildMediaPairArguments(message, outputPath)
                    : BuildDirectArguments(message, outputPath);
                result = RunFfmpeg(ffmpeg, arguments, jobId, durationSeconds, 0, 100, "Baixando e processando");
            }

            if (result.ExitCode != 0 || !File.Exists(outputPath) || new FileInfo(outputPath).Length == 0)
            {
                TryDeleteFile(outputPath);
                string error = String.IsNullOrWhiteSpace(result.Error)
                    ? "O FFmpeg nao conseguiu gerar o arquivo MP4."
                    : result.Error;
                SendMessage(new Dictionary<string, object>
                {
                    { "type", "error" },
                    { "jobId", jobId },
                    { "error", error }
                });
                return;
            }

            FileInfo output = new FileInfo(outputPath);
            SendMessage(new Dictionary<string, object>
            {
                { "type", "complete" },
                { "jobId", jobId },
                { "filename", output.Name },
                { "output", output.FullName },
                { "elapsedSeconds", Math.Round(timer.Elapsed.TotalSeconds, 2) },
                { "totalSize", output.Length }
            });
        }
        catch (Exception error)
        {
            TryDeleteFile(outputPath);
            SendMessage(new Dictionary<string, object>
            {
                { "type", "error" },
                { "jobId", jobId },
                { "error", FlattenError(error) }
            });
        }
    }

    private static FfmpegResult RunHlsDownload(
        string ffmpeg,
        Dictionary<string, object> message,
        string outputPath,
        string jobId,
        double durationSeconds,
        Stopwatch timer)
    {
        string mediaUrl = GetString(message, "url");
        string playlistText = GetString(message, "playlistText");
        int parallelConnections = (int)Math.Max(1, Math.Min(24, GetDouble(message, "parallelConnections")));
        if (GetDouble(message, "parallelConnections") <= 0)
        {
            parallelConnections = DefaultParallelConnections;
        }

        HlsPlan plan = BuildHlsPlan(playlistText, mediaUrl);
        if (!plan.CanPrefetch)
        {
            SendMessage(new Dictionary<string, object>
            {
                { "type", "progress" },
                { "jobId", jobId },
                { "phase", "Modo compativel HLS" },
                { "percent", (object)null },
                { "elapsedSeconds", Math.Round(timer.Elapsed.TotalSeconds, 2) },
                { "remainingSeconds", (object)null },
                { "totalSize", 0 },
                { "speed", "" },
                { "fallbackReason", plan.FallbackReason }
            });
            return RunFfmpeg(
                ffmpeg,
                BuildRemoteHlsArguments(message, outputPath),
                jobId,
                durationSeconds,
                0,
                100,
                "Baixando e processando");
        }

        string tempDirectory = Path.Combine(Path.GetTempPath(), "dsl-video-downloader", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDirectory);
        try
        {
            Dictionary<string, string> requestHeaders = GetStringDictionary(message, "requestHeaders");
            DownloadProgress progress = new DownloadProgress(jobId, plan.Assets.Count, timer);
            DownloadAssetsAsync(
                plan.Assets,
                tempDirectory,
                mediaUrl,
                GetString(message, "pageUrl"),
                GetString(message, "pageOrigin"),
                GetString(message, "userAgent"),
                requestHeaders,
                parallelConnections,
                progress).GetAwaiter().GetResult();

            string localPlaylist = Path.Combine(tempDirectory, "media.m3u8");
            File.WriteAllText(localPlaylist, plan.PlaylistText, new UTF8Encoding(false));

            SendMessage(new Dictionary<string, object>
            {
                { "type", "progress" },
                { "jobId", jobId },
                { "phase", "Finalizando MP4" },
                { "percent", 92.0 },
                { "elapsedSeconds", Math.Round(timer.Elapsed.TotalSeconds, 2) },
                { "remainingSeconds", (object)null },
                { "totalSize", plan.Assets.Sum(asset => ExistingFileLength(Path.Combine(tempDirectory, asset.LocalName))) },
                { "speed", "" }
            });

            string localArguments = String.Join(" ", new[]
            {
                CommonFfmpegArguments(),
                "-protocol_whitelist file,crypto,data",
                "-extension_picky 0 -allowed_segment_extensions ALL -allowed_extensions ALL",
                "-i", Quote(localPlaylist),
                "-map 0:v? -map 0:a? -c copy -movflags +faststart",
                Quote(outputPath)
            });
            return RunFfmpeg(ffmpeg, localArguments, jobId, durationSeconds, 92, 100, "Finalizando MP4");
        }
        catch (Exception error)
        {
            TryDeleteFile(outputPath);
            SendMessage(new Dictionary<string, object>
            {
                { "type", "progress" },
                { "jobId", jobId },
                { "phase", "Retentando em modo compativel" },
                { "percent", (object)null },
                { "elapsedSeconds", Math.Round(timer.Elapsed.TotalSeconds, 2) },
                { "remainingSeconds", (object)null },
                { "totalSize", 0 },
                { "speed", "" },
                { "fallbackReason", FlattenError(error) }
            });
            return RunFfmpeg(
                ffmpeg,
                BuildRemoteHlsArguments(message, outputPath),
                jobId,
                durationSeconds,
                0,
                100,
                "Baixando e processando");
        }
        finally
        {
            TryDeleteDirectory(tempDirectory);
        }
    }

    private static HlsPlan BuildHlsPlan(string playlistText, string mediaUrl)
    {
        HlsPlan plan = new HlsPlan();
        if (String.IsNullOrWhiteSpace(playlistText))
        {
            plan.FallbackReason = "A playlist nao foi enviada pela extensao.";
            return plan;
        }

        string[] lines = playlistText.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        if (!lines.Any(line => line.Trim() == "#EXTM3U"))
        {
            plan.FallbackReason = "Playlist HLS invalida.";
            return plan;
        }
        if (!lines.Any(line => line.Trim() == "#EXT-X-ENDLIST"))
        {
            plan.FallbackReason = "Playlist ao vivo ou ainda aberta.";
            return plan;
        }
        if (lines.Any(line => Regex.IsMatch(line.Trim(), "^#EXT-X-(PART|PRELOAD-HINT|SKIP|RENDITION-REPORT):", RegexOptions.IgnoreCase)))
        {
            plan.FallbackReason = "Playlist HLS de baixa latencia.";
            return plan;
        }

        Uri baseUri;
        if (!Uri.TryCreate(mediaUrl, UriKind.Absolute, out baseUri))
        {
            plan.FallbackReason = "URL da playlist invalida.";
            return plan;
        }

        Dictionary<string, HlsAsset> uniqueAssets = new Dictionary<string, HlsAsset>(StringComparer.Ordinal);
        Dictionary<string, long> nextRangeOffsets = new Dictionary<string, long>(StringComparer.Ordinal);
        long? pendingLength = null;
        long? pendingStart = null;
        int pendingRangeLine = -1;
        int assetNumber = 0;

        for (int index = 0; index < lines.Length; index += 1)
        {
            string trimmed = lines[index].Trim();
            if (trimmed.StartsWith("#EXT-X-BYTERANGE:", StringComparison.OrdinalIgnoreCase))
            {
                ParseByteRange(trimmed.Substring(trimmed.IndexOf(':') + 1), out pendingLength, out pendingStart);
                pendingRangeLine = index;
                continue;
            }

            if (trimmed.StartsWith("#EXT-X-KEY:", StringComparison.OrdinalIgnoreCase) && !Regex.IsMatch(trimmed, "METHOD=NONE", RegexOptions.IgnoreCase))
            {
                string uriValue = ExtractQuotedAttribute(trimmed, "URI");
                if (!String.IsNullOrEmpty(uriValue))
                {
                    HlsAsset asset = GetOrCreateAsset(uniqueAssets, plan.Assets, baseUri, uriValue, null, null, "key", ref assetNumber);
                    lines[index] = ReplaceQuotedAttribute(lines[index], "URI", asset.LocalName);
                }
                continue;
            }

            if (trimmed.StartsWith("#EXT-X-MAP:", StringComparison.OrdinalIgnoreCase))
            {
                string uriValue = ExtractQuotedAttribute(trimmed, "URI");
                if (!String.IsNullOrEmpty(uriValue))
                {
                    long? mapLength;
                    long? mapStart;
                    ParseByteRange(ExtractQuotedAttribute(trimmed, "BYTERANGE"), out mapLength, out mapStart);
                    HlsAsset asset = GetOrCreateAsset(uniqueAssets, plan.Assets, baseUri, uriValue, mapStart, mapLength, "init", ref assetNumber);
                    string rewritten = ReplaceQuotedAttribute(lines[index], "URI", asset.LocalName);
                    rewritten = RemoveAttribute(rewritten, "BYTERANGE");
                    lines[index] = rewritten;
                }
                continue;
            }

            if (String.IsNullOrEmpty(trimmed) || trimmed.StartsWith("#", StringComparison.Ordinal))
            {
                continue;
            }

            Uri segmentUri = new Uri(baseUri, trimmed);
            long? rangeStart = null;
            if (pendingLength.HasValue)
            {
                long implicitStart;
                if (!nextRangeOffsets.TryGetValue(segmentUri.AbsoluteUri, out implicitStart))
                {
                    implicitStart = 0;
                }
                rangeStart = pendingStart ?? implicitStart;
                nextRangeOffsets[segmentUri.AbsoluteUri] = rangeStart.Value + pendingLength.Value;
            }

            HlsAsset segment = GetOrCreateAsset(
                uniqueAssets,
                plan.Assets,
                baseUri,
                trimmed,
                rangeStart,
                pendingLength,
                "segment",
                ref assetNumber);
            lines[index] = segment.LocalName;
            if (pendingRangeLine >= 0)
            {
                lines[pendingRangeLine] = "";
            }
            pendingLength = null;
            pendingStart = null;
            pendingRangeLine = -1;
        }

        if (plan.Assets.Count < 2)
        {
            plan.FallbackReason = "A playlist nao possui segmentos suficientes para paralelismo.";
            return plan;
        }

        plan.PlaylistText = String.Join("\n", lines) + "\n";
        plan.CanPrefetch = true;
        return plan;
    }

    private static HlsAsset GetOrCreateAsset(
        Dictionary<string, HlsAsset> uniqueAssets,
        List<HlsAsset> assets,
        Uri baseUri,
        string value,
        long? rangeStart,
        long? rangeLength,
        string kind,
        ref int assetNumber)
    {
        Uri uri = new Uri(baseUri, value);
        string key = String.Join("|", uri.AbsoluteUri, rangeStart.HasValue ? rangeStart.Value.ToString(CultureInfo.InvariantCulture) : "", rangeLength.HasValue ? rangeLength.Value.ToString(CultureInfo.InvariantCulture) : "");
        HlsAsset asset;
        if (uniqueAssets.TryGetValue(key, out asset))
        {
            return asset;
        }

        string extension = Path.GetExtension(uri.AbsolutePath);
        if (String.IsNullOrEmpty(extension) || extension.Length > 10 || !Regex.IsMatch(extension, "^\\.[a-zA-Z0-9]+$"))
        {
            extension = ".bin";
        }
        assetNumber += 1;
        asset = new HlsAsset
        {
            Url = uri.AbsoluteUri,
            LocalName = String.Format(CultureInfo.InvariantCulture, "{0}-{1:000000}{2}", kind, assetNumber, extension),
            RangeStart = rangeStart,
            RangeLength = rangeLength
        };
        uniqueAssets.Add(key, asset);
        assets.Add(asset);
        return asset;
    }

    private static async Task DownloadAssetsAsync(
        IList<HlsAsset> assets,
        string destinationDirectory,
        string playlistUrl,
        string pageUrl,
        string pageOrigin,
        string userAgent,
        IDictionary<string, string> requestHeaders,
        int parallelConnections,
        DownloadProgress progress)
    {
        using (HttpClientHandler handler = new HttpClientHandler())
        {
            handler.AllowAutoRedirect = true;
            handler.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            handler.UseCookies = false;
            using (HttpClient client = new HttpClient(handler))
            using (SemaphoreSlim gate = new SemaphoreSlim(parallelConnections, parallelConnections))
            {
                client.Timeout = TimeSpan.FromMinutes(3);
                List<Task> tasks = assets.Select(async asset =>
                {
                    await gate.WaitAsync().ConfigureAwait(false);
                    try
                    {
                        long bytes = await DownloadAssetWithRetryAsync(
                            client,
                            asset,
                            Path.Combine(destinationDirectory, asset.LocalName),
                            playlistUrl,
                            pageUrl,
                            pageOrigin,
                            userAgent,
                            requestHeaders).ConfigureAwait(false);
                        progress.AssetCompleted(bytes);
                    }
                    finally
                    {
                        gate.Release();
                    }
                }).ToList();
                await Task.WhenAll(tasks).ConfigureAwait(false);
            }
        }
    }

    private static async Task<long> DownloadAssetWithRetryAsync(
        HttpClient client,
        HlsAsset asset,
        string destination,
        string playlistUrl,
        string pageUrl,
        string pageOrigin,
        string userAgent,
        IDictionary<string, string> requestHeaders)
    {
        Exception lastError = null;
        for (int attempt = 1; attempt <= 3; attempt += 1)
        {
            TryDeleteFile(destination);
            try
            {
                using (HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Get, asset.Url))
                {
                    ApplyHttpHeaders(request, asset.Url, playlistUrl, pageUrl, pageOrigin, userAgent, requestHeaders);
                    if (asset.RangeLength.HasValue)
                    {
                        long start = asset.RangeStart ?? 0;
                        request.Headers.Range = new RangeHeaderValue(start, start + asset.RangeLength.Value - 1);
                    }

                    using (HttpResponseMessage response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
                    {
                        response.EnsureSuccessStatusCode();
                        using (Stream input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                        using (FileStream output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 131072, true))
                        {
                            long skip = asset.RangeLength.HasValue && response.StatusCode != HttpStatusCode.PartialContent
                                ? asset.RangeStart ?? 0
                                : 0;
                            long remaining = asset.RangeLength ?? Int64.MaxValue;
                            byte[] buffer = new byte[131072];
                            while (skip > 0)
                            {
                                int skipped = await input.ReadAsync(buffer, 0, (int)Math.Min(buffer.Length, skip)).ConfigureAwait(false);
                                if (skipped <= 0) throw new EndOfStreamException("A origem terminou antes do byte-range solicitado.");
                                skip -= skipped;
                            }
                            while (remaining > 0)
                            {
                                int read = await input.ReadAsync(buffer, 0, (int)Math.Min(buffer.Length, remaining)).ConfigureAwait(false);
                                if (read <= 0) break;
                                await output.WriteAsync(buffer, 0, read).ConfigureAwait(false);
                                remaining -= read;
                            }
                        }
                    }
                }

                return new FileInfo(destination).Length;
            }
            catch (Exception error)
            {
                lastError = error;
                TryDeleteFile(destination);
            }
            if (attempt < 3) await Task.Delay(attempt * 350).ConfigureAwait(false);
        }

        throw new IOException(String.Format("Falha ao baixar segmento apos 3 tentativas: {0}", asset.Url), lastError);
    }

    private static void ApplyHttpHeaders(
        HttpRequestMessage request,
        string assetUrl,
        string playlistUrl,
        string pageUrl,
        string pageOrigin,
        string userAgent,
        IDictionary<string, string> requestHeaders)
    {
        string assetHost = new Uri(assetUrl).Host;
        string playlistHost = new Uri(playlistUrl).Host;
        foreach (KeyValuePair<string, string> header in requestHeaders)
        {
            string lower = header.Key.ToLowerInvariant();
            if (lower == "host" || lower == "content-length" || lower == "range" || lower == "referer" || lower == "origin")
            {
                continue;
            }
            if (lower == "cookie" && !String.Equals(assetHost, playlistHost, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            request.Headers.TryAddWithoutValidation(header.Key, CleanHeaderValue(header.Value));
        }

        if (!String.IsNullOrWhiteSpace(userAgent) && !request.Headers.Contains("User-Agent"))
        {
            request.Headers.TryAddWithoutValidation("User-Agent", CleanHeaderValue(userAgent));
        }
        if (!String.IsNullOrWhiteSpace(pageUrl))
        {
            request.Headers.TryAddWithoutValidation("Referer", CleanHeaderValue(pageUrl));
        }
        if (!String.IsNullOrWhiteSpace(pageOrigin))
        {
            request.Headers.TryAddWithoutValidation("Origin", CleanHeaderValue(pageOrigin));
        }
        request.Headers.ConnectionClose = false;
    }

    private static string BuildRemoteHlsArguments(Dictionary<string, object> message, string outputPath)
    {
        string inputOptions = HttpInputOptions(
            GetString(message, "pageUrl"),
            GetString(message, "pageOrigin"),
            GetString(message, "userAgent"),
            GetStringDictionary(message, "requestHeaders"));
        return String.Join(" ", new[]
        {
            CommonFfmpegArguments(),
            inputOptions,
            "-extension_picky 0 -allowed_segment_extensions ALL -http_persistent 1 -http_multiple 1",
            "-i", Quote(GetString(message, "url")),
            "-map 0:v? -map 0:a? -c copy -movflags +faststart",
            Quote(outputPath)
        });
    }

    private static string BuildDirectArguments(Dictionary<string, object> message, string outputPath)
    {
        string inputOptions = HttpInputOptions(
            GetString(message, "pageUrl"),
            GetString(message, "pageOrigin"),
            GetString(message, "userAgent"),
            GetStringDictionary(message, "requestHeaders"));
        return String.Join(" ", new[]
        {
            CommonFfmpegArguments(),
            inputOptions,
            "-i", Quote(GetString(message, "url")),
            "-map 0:v? -map 0:a? -c copy -movflags +faststart",
            Quote(outputPath)
        });
    }

    private static string BuildMediaPairArguments(Dictionary<string, object> message, string outputPath)
    {
        string inputOptions = HttpInputOptions(
            GetString(message, "pageUrl"),
            GetString(message, "pageOrigin"),
            GetString(message, "userAgent"),
            GetStringDictionary(message, "requestHeaders"));
        return String.Join(" ", new[]
        {
            CommonFfmpegArguments(),
            inputOptions,
            "-i", Quote(GetString(message, "videoUrl")),
            inputOptions,
            "-i", Quote(GetString(message, "audioUrl")),
            "-map 0:v:0 -map 1:a:0 -c copy -shortest -movflags +faststart",
            Quote(outputPath)
        });
    }

    private static string CommonFfmpegArguments()
    {
        return "-y -hide_banner -loglevel error -nostats -stats_period 0.5 -progress pipe:1";
    }

    private static string HttpInputOptions(
        string pageUrl,
        string pageOrigin,
        string userAgent,
        IDictionary<string, string> requestHeaders)
    {
        List<string> values = new List<string>
        {
            "-rw_timeout 60000000",
            "-reconnect 1",
            "-reconnect_streamed 1",
            "-reconnect_delay_max 5"
        };
        if (!String.IsNullOrWhiteSpace(userAgent))
        {
            values.Add("-user_agent " + Quote(CleanHeaderValue(userAgent)));
        }
        if (!String.IsNullOrWhiteSpace(pageUrl))
        {
            values.Add("-referer " + Quote(CleanHeaderValue(pageUrl)));
        }

        List<string> headers = new List<string>();
        if (!String.IsNullOrWhiteSpace(pageOrigin))
        {
            headers.Add("Origin: " + CleanHeaderValue(pageOrigin));
        }
        foreach (KeyValuePair<string, string> header in requestHeaders)
        {
            string lower = header.Key.ToLowerInvariant();
            if (lower == "user-agent" || lower == "referer" || lower == "origin" || lower == "host" || lower == "content-length" || lower == "range")
            {
                continue;
            }
            headers.Add(header.Key + ": " + CleanHeaderValue(header.Value));
        }
        if (headers.Count > 0)
        {
            values.Add("-headers " + Quote(String.Join("\r\n", headers) + "\r\n"));
        }
        return String.Join(" ", values);
    }

    private static FfmpegResult RunFfmpeg(
        string ffmpeg,
        string arguments,
        string jobId,
        double durationSeconds,
        double percentStart,
        double percentEnd,
        string phase)
    {
        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = ffmpeg,
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        StringBuilder errors = new StringBuilder();
        Dictionary<string, string> progressValues = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        object progressLock = new object();
        Stopwatch timer = Stopwatch.StartNew();

        using (Process process = new Process())
        {
            process.StartInfo = start;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                if (String.IsNullOrWhiteSpace(eventArgs.Data)) return;
                int separator = eventArgs.Data.IndexOf('=');
                if (separator <= 0) return;
                string key = eventArgs.Data.Substring(0, separator);
                string value = eventArgs.Data.Substring(separator + 1);
                lock (progressLock)
                {
                    progressValues[key] = value;
                    if (key == "progress")
                    {
                        SendFfmpegProgress(jobId, progressValues, durationSeconds, timer.Elapsed.TotalSeconds, percentStart, percentEnd, phase);
                    }
                }
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                if (String.IsNullOrWhiteSpace(eventArgs.Data)) return;
                lock (errors)
                {
                    if (errors.Length < 24000) errors.AppendLine(eventArgs.Data);
                }
            };

            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();
            process.WaitForExit();
            return new FfmpegResult
            {
                ExitCode = process.ExitCode,
                Error = LastErrorLines(errors.ToString(), 10)
            };
        }
    }

    private static void SendFfmpegProgress(
        string jobId,
        IDictionary<string, string> values,
        double durationSeconds,
        double wallSeconds,
        double percentStart,
        double percentEnd,
        string phase)
    {
        double mediaSeconds = ProgressSeconds(values);
        double? percent = null;
        double? remainingSeconds = null;
        if (durationSeconds > 0)
        {
            double fraction = Math.Max(0, Math.Min(1, mediaSeconds / durationSeconds));
            percent = percentStart + fraction * (percentEnd - percentStart);
            if (fraction > 0 && fraction < 1)
            {
                remainingSeconds = wallSeconds * (1 - fraction) / fraction;
            }
        }
        else if (String.Equals(GetDictionaryValue(values, "progress"), "end", StringComparison.OrdinalIgnoreCase))
        {
            percent = Math.Max(percentStart, percentEnd - 0.5);
        }

        SendMessage(new Dictionary<string, object>
        {
            { "type", "progress" },
            { "jobId", jobId },
            { "phase", phase },
            { "percent", percent.HasValue ? (object)Math.Round(percent.Value, 2) : null },
            { "elapsedSeconds", Math.Round(wallSeconds, 2) },
            { "remainingSeconds", remainingSeconds.HasValue ? (object)Math.Round(remainingSeconds.Value, 2) : null },
            { "totalSize", ParseLong(values, "total_size") },
            { "speed", GetDictionaryValue(values, "speed") }
        });
    }

    private static double ProgressSeconds(IDictionary<string, string> values)
    {
        string value = GetDictionaryValue(values, "out_time_us");
        long microseconds;
        if (Int64.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out microseconds))
        {
            return microseconds / 1000000.0;
        }
        value = GetDictionaryValue(values, "out_time");
        TimeSpan time;
        return TimeSpan.TryParse(value, CultureInfo.InvariantCulture, out time) ? time.TotalSeconds : 0;
    }

    private static Dictionary<string, object> CheckDependencies()
    {
        string ffmpeg = FindFfmpeg();
        return new Dictionary<string, object>
        {
            { "ok", !String.IsNullOrEmpty(ffmpeg) },
            { "installed", !String.IsNullOrEmpty(ffmpeg) },
            { "ffmpegPath", ffmpeg ?? "" },
            { "hostApiVersion", HostApiVersion },
            { "error", String.IsNullOrEmpty(ffmpeg) ? "FFmpeg nao encontrado no Windows." : "" }
        };
    }

    private static Dictionary<string, object> OpenDownloadedFile(Dictionary<string, object> message)
    {
        string path = GetString(message, "path");
        if (String.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return ErrorResponse("O arquivo baixado nao foi encontrado.");
        }
        Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true });
        return new Dictionary<string, object> { { "ok", true } };
    }

    private static string FindFfmpeg()
    {
        string fromPath = FindInPath("ffmpeg.exe");
        if (!String.IsNullOrEmpty(fromPath)) return fromPath;

        string[] knownPaths =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "ffmpeg", "bin", "ffmpeg.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ffmpeg", "bin", "ffmpeg.exe"),
            @"C:\ffmpeg\bin\ffmpeg.exe"
        };
        foreach (string path in knownPaths)
        {
            if (File.Exists(path)) return path;
        }

        string packages = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Packages");
        if (!Directory.Exists(packages)) return "";
        try
        {
            foreach (string directory in Directory.GetDirectories(packages, "Gyan.FFmpeg_*"))
            {
                string match = Directory.GetFiles(directory, "ffmpeg.exe", SearchOption.AllDirectories).FirstOrDefault();
                if (!String.IsNullOrEmpty(match)) return match;
            }
        }
        catch
        {
        }
        return "";
    }

    private static string FindInPath(string fileName)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string part in path.Split(Path.PathSeparator))
        {
            try
            {
                string candidate = Path.Combine(part.Trim().Trim('"'), fileName);
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
            }
        }
        return "";
    }

    private static string DownloadsDirectory()
    {
        string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        Directory.CreateDirectory(path);
        return path;
    }

    private static string UniqueOutputPath(string filenameBase)
    {
        string directory = DownloadsDirectory();
        string first = Path.Combine(directory, filenameBase + ".mp4");
        if (!File.Exists(first)) return first;
        for (int index = 1; index < 10000; index += 1)
        {
            string candidate = Path.Combine(directory, String.Format("{0} ({1}).mp4", filenameBase, index));
            if (!File.Exists(candidate)) return candidate;
        }
        return Path.Combine(directory, filenameBase + "-" + Guid.NewGuid().ToString("N") + ".mp4");
    }

    private static string SafeName(string value)
    {
        string result = Regex.Replace(value ?? "", "[<>:\"/\\\\|?*\\x00-\\x1f]", "_").Trim().TrimEnd('.');
        string upper = result.ToUpperInvariant();
        if (Regex.IsMatch(upper, "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)")) result = "_" + result;
        return result.Length > 180 ? result.Substring(0, 180).TrimEnd() : result;
    }

    private static string FallbackName()
    {
        return "video--" + DateTime.Now.ToString("dd-MM-yyyy--HH-mm-ss", CultureInfo.InvariantCulture);
    }

    private static Dictionary<string, object> ReadMessage()
    {
        Stream input = Console.OpenStandardInput();
        byte[] lengthBytes = ReadExactly(input, 4);
        if (lengthBytes == null) return null;
        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length <= 0 || length > 128 * 1024 * 1024) throw new InvalidDataException("Mensagem nativa com tamanho invalido.");
        byte[] payload = ReadExactly(input, length);
        if (payload == null) throw new EndOfStreamException("Mensagem nativa incompleta.");
        return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(payload));
    }

    private static void SendMessage(Dictionary<string, object> message)
    {
        byte[] payload = Encoding.UTF8.GetBytes(Json.Serialize(message));
        byte[] length = BitConverter.GetBytes(payload.Length);
        lock (OutputLock)
        {
            Stream output = Console.OpenStandardOutput();
            output.Write(length, 0, length.Length);
            output.Write(payload, 0, payload.Length);
            output.Flush();
        }
    }

    private static byte[] ReadExactly(Stream input, int count)
    {
        byte[] bytes = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int read = input.Read(bytes, offset, count - offset);
            if (read <= 0) return offset == 0 ? null : bytes.Take(offset).ToArray();
            offset += read;
        }
        return bytes;
    }

    private static Dictionary<string, object> ErrorResponse(string error)
    {
        return new Dictionary<string, object>
        {
            { "ok", false },
            { "type", "error" },
            { "error", error },
            { "hostApiVersion", HostApiVersion }
        };
    }

    private static string GetString(Dictionary<string, object> message, string key)
    {
        object value;
        return message != null && message.TryGetValue(key, out value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : "";
    }

    private static double GetDouble(Dictionary<string, object> message, string key)
    {
        object value;
        double result;
        return message != null && message.TryGetValue(key, out value) && value != null && Double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out result)
            ? result
            : 0;
    }

    private static Dictionary<string, string> GetStringDictionary(Dictionary<string, object> message, string key)
    {
        Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        object raw;
        if (message == null || !message.TryGetValue(key, out raw) || raw == null) return result;
        Dictionary<string, object> objectValues = raw as Dictionary<string, object>;
        if (objectValues != null)
        {
            foreach (KeyValuePair<string, object> item in objectValues)
            {
                result[item.Key] = item.Value == null ? "" : Convert.ToString(item.Value, CultureInfo.InvariantCulture);
            }
        }
        Dictionary<string, string> stringValues = raw as Dictionary<string, string>;
        if (stringValues != null)
        {
            foreach (KeyValuePair<string, string> item in stringValues) result[item.Key] = item.Value;
        }
        return result;
    }

    private static long ParseLong(IDictionary<string, string> values, string key)
    {
        long result;
        return Int64.TryParse(GetDictionaryValue(values, key), NumberStyles.Integer, CultureInfo.InvariantCulture, out result) ? result : 0;
    }

    private static string GetDictionaryValue(IDictionary<string, string> values, string key)
    {
        string value;
        return values != null && values.TryGetValue(key, out value) ? value : "";
    }

    private static string Quote(string value)
    {
        return "\"" + (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static string CleanHeaderValue(string value)
    {
        return (value ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
    }

    private static void ParseByteRange(string value, out long? length, out long? start)
    {
        length = null;
        start = null;
        if (String.IsNullOrWhiteSpace(value)) return;
        Match match = Regex.Match(value.Trim(), "^(?<length>\\d+)(?:@(?<start>\\d+))?$");
        long parsed;
        if (match.Success && Int64.TryParse(match.Groups["length"].Value, out parsed)) length = parsed;
        if (match.Success && match.Groups["start"].Success && Int64.TryParse(match.Groups["start"].Value, out parsed)) start = parsed;
    }

    private static string ExtractQuotedAttribute(string line, string name)
    {
        Match match = Regex.Match(line ?? "", "(?:^|,)\\s*" + Regex.Escape(name) + "\\s*=\\s*(?:\"(?<quoted>[^\"]*)\"|(?<plain>[^,]*))", RegexOptions.IgnoreCase);
        return match.Success ? (match.Groups["quoted"].Success ? match.Groups["quoted"].Value : match.Groups["plain"].Value.Trim()) : "";
    }

    private static string ReplaceQuotedAttribute(string line, string name, string value)
    {
        return Regex.Replace(
            line,
            "((?:^|,)\\s*" + Regex.Escape(name) + "\\s*=\\s*)(?:\"[^\"]*\"|[^,]*)",
            delegate(Match match) { return match.Groups[1].Value + "\"" + value.Replace("\"", "") + "\""; },
            RegexOptions.IgnoreCase);
    }

    private static string RemoveAttribute(string line, string name)
    {
        string result = Regex.Replace(
            line,
            ",?\\s*" + Regex.Escape(name) + "\\s*=\\s*(?:\"[^\"]*\"|[^,]*)",
            "",
            RegexOptions.IgnoreCase);
        return result.Replace(":,", ":");
    }

    private static long ExistingFileLength(string path)
    {
        try { return File.Exists(path) ? new FileInfo(path).Length : 0; }
        catch { return 0; }
    }

    private static void TryDeleteFile(string path)
    {
        try { if (!String.IsNullOrEmpty(path) && File.Exists(path)) File.Delete(path); }
        catch { }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (!String.IsNullOrEmpty(path) && Directory.Exists(path)) Directory.Delete(path, true); }
        catch { }
    }

    private static string LastErrorLines(string value, int count)
    {
        string[] lines = (value ?? "").Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        return String.Join(Environment.NewLine, lines.Skip(Math.Max(0, lines.Length - count)));
    }

    private static string FlattenError(Exception error)
    {
        Exception current = error;
        while (current is AggregateException && current.InnerException != null) current = current.InnerException;
        while (current.InnerException != null && (current is TargetInvocationException || current is AggregateException)) current = current.InnerException;
        return current.Message;
    }
}
