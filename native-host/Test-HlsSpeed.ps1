param(
    [int]$SegmentCount = 10,
    [string]$MediaUrl = "https://test-streams.mux.dev/x36xhzz/url_6/193039199_mp4_h264_aac_hq_7.m3u8",
    [int[]]$Connections = @(1, 2, 4, 6, 8, 12),
    [string]$PageUrl = "https://test-streams.mux.dev/",
    [string]$PageOrigin = "https://test-streams.mux.dev",
    [string]$UserAgent = "Mozilla/5.0",
    [switch]$KeepOutputs
)

$ErrorActionPreference = "Stop"
$hostExecutable = Join-Path $PSScriptRoot "bin\DslVideoDownloaderHost.exe"

function Invoke-NativeHost([hashtable]$Message) {
    $json = $Message | ConvertTo-Json -Compress -Depth 20
    $payload = [Text.Encoding]::UTF8.GetBytes($json)
    $start = [Diagnostics.ProcessStartInfo]::new($hostExecutable)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $process = [Diagnostics.Process]::Start($start)

    $process.StandardInput.BaseStream.Write([BitConverter]::GetBytes($payload.Length), 0, 4)
    $process.StandardInput.BaseStream.Write($payload, 0, $payload.Length)
    $process.StandardInput.BaseStream.Flush()
    $process.StandardInput.Close()

    $memory = [IO.MemoryStream]::new()
    $process.StandardOutput.BaseStream.CopyTo($memory)
    $process.WaitForExit()

    $bytes = $memory.ToArray()
    $messages = @()
    $offset = 0
    while ($offset + 4 -le $bytes.Length) {
        $size = [BitConverter]::ToInt32($bytes, $offset)
        $offset += 4
        if ($size -lt 0 -or $offset + $size -gt $bytes.Length) { break }
        $messages += [Text.Encoding]::UTF8.GetString($bytes, $offset, $size) | ConvertFrom-Json
        $offset += $size
    }
    return $messages
}

$response = Invoke-WebRequest -Uri $MediaUrl -Headers @{
    Referer = $PageUrl
    Origin = $PageOrigin
    "User-Agent" = $UserAgent
} -UseBasicParsing -TimeoutSec 30
$playlist = if ($response.Content -is [byte[]]) {
    [Text.Encoding]::UTF8.GetString($response.Content)
} else {
    [string]$response.Content
}

$selected = [Collections.Generic.List[string]]::new()
$segments = 0
$duration = 0.0
foreach ($line in ($playlist -split "`r?`n")) {
    $trimmed = $line.Trim()
    if ($trimmed -eq "#EXT-X-ENDLIST") { continue }
    if ($trimmed.StartsWith("#EXTINF:")) {
        if ($segments -lt $SegmentCount) {
            $selected.Add($line)
            $duration += [double](($trimmed.Substring(8) -split ",")[0])
        }
        continue
    }
    if ($trimmed -and -not $trimmed.StartsWith("#")) {
        if ($segments -lt $SegmentCount) { $selected.Add($line) }
        $segments += 1
        continue
    }
    if ($segments -lt $SegmentCount) { $selected.Add($line) }
}
$selected.Add("#EXT-X-ENDLIST")
$shortPlaylist = ($selected -join "`n") + "`n"

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$results = @()
foreach ($connectionCount in $Connections) {
    $name = "dsl-speed-test-$connectionCount-$stamp"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $messages = Invoke-NativeHost @{
        action = "download-hls-stream"
        jobId = "benchmark-$connectionCount"
        url = $MediaUrl
        playlistText = if ($connectionCount -eq 0) { "" } else { $shortPlaylist }
        parallelConnections = $connectionCount
        filenameBase = $name
        durationSeconds = $duration
        pageUrl = $PageUrl
        pageOrigin = $PageOrigin
        userAgent = $UserAgent
        requestHeaders = @{ Accept = "*/*"; "User-Agent" = $UserAgent }
    }
    $watch.Stop()
    $final = $messages[-1]
    $results += [PSCustomObject]@{
        Connections = $connectionCount
        WallSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2)
        Result = $final.type
        Output = $final.output
        Bytes = $final.totalSize
        Error = $final.error
        ParallelPhase = [bool]($messages | Where-Object { $_.phase -eq "Baixando segmentos em paralelo" })
    }
}

$baseline = $results | Where-Object Connections -eq 0 | Select-Object -First 1
if (-not $baseline) { $baseline = $results | Where-Object Connections -eq 1 | Select-Object -First 1 }
$fastest = $results | Where-Object Connections -ne 0 | Sort-Object WallSeconds | Select-Object -First 1
$gain = if ($baseline.WallSeconds -gt 0 -and $fastest.WallSeconds -gt 0) {
    [Math]::Round($baseline.WallSeconds / $fastest.WallSeconds, 2)
} else {
    0
}

$results | Format-Table -AutoSize
Write-Host "Fastest: $($fastest.Connections) connection(s), ${gain}x versus baseline"
$failures = $results | Where-Object Result -ne "complete"
foreach ($failure in $failures) {
    Write-Host "Error with $($failure.Connections) connection(s): $($failure.Error)"
}
if (-not $KeepOutputs) {
    foreach ($result in $results) {
        if ($result.Output -and [IO.File]::Exists($result.Output)) {
            [IO.File]::Delete($result.Output)
        }
    }
}
