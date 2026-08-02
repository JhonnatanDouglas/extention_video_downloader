$ErrorActionPreference = "Stop"
$hostExecutable = Join-Path $PSScriptRoot "bin\DslVideoDownloaderHost.exe"
$sampleUrl = "https://www.w3schools.com/html/mov_bbb.mp4"
$pageUrl = "https://www.w3schools.com/html/html5_video.asp"
$pageOrigin = "https://www.w3schools.com"

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

function Assert-Completed($Messages, [string]$Action) {
    $final = $Messages[-1]
    if ($final.type -ne "complete") {
        throw "$Action falhou: $($final.error)"
    }
    if (-not (Test-Path -LiteralPath $final.output)) {
        throw "$Action nao gerou o arquivo informado."
    }
    return $final
}

$dependencies = (Invoke-NativeHost @{ action = "ensure-ffmpeg" })[-1]
if (-not $dependencies.ok -or $dependencies.hostApiVersion -ne 4) {
    throw "A verificacao do host API 4 falhou."
}
$ffprobe = Join-Path (Split-Path -Parent $dependencies.ffmpegPath) "ffprobe.exe"
$stamp = Get-Date -Format "yyyyMMddHHmmss"
$outputs = [Collections.Generic.List[string]]::new()

try {
    $direct = Assert-Completed (Invoke-NativeHost @{
        action = "download-direct-media"
        jobId = "test-direct"
        url = $sampleUrl
        filenameBase = "dsl-host-test-direct-$stamp"
        pageUrl = $pageUrl
        pageOrigin = $pageOrigin
        userAgent = "Mozilla/5.0"
        requestHeaders = @{ Accept = "*/*"; "User-Agent" = "Mozilla/5.0" }
    }) "download-direct-media"
    $outputs.Add($direct.output)

    $pair = Assert-Completed (Invoke-NativeHost @{
        action = "download-media-pair"
        jobId = "test-pair"
        videoUrl = $sampleUrl
        audioUrl = $sampleUrl
        filenameBase = "dsl-host-test-pair-$stamp"
        pageUrl = $pageUrl
        pageOrigin = $pageOrigin
        userAgent = "Mozilla/5.0"
        requestHeaders = @{ Accept = "*/*"; "User-Agent" = "Mozilla/5.0" }
    }) "download-media-pair"
    $outputs.Add($pair.output)

    $results = foreach ($path in $outputs) {
        $probe = & $ffprobe -v error -show_entries "stream=codec_type" -of json $path | ConvertFrom-Json
        $types = @($probe.streams.codec_type)
        if ($types -notcontains "video" -or $types -notcontains "audio") {
            throw "O arquivo $path nao contem video e audio."
        }
        [PSCustomObject]@{
            File = Split-Path -Leaf $path
            Video = $types -contains "video"
            Audio = $types -contains "audio"
            Bytes = (Get-Item -LiteralPath $path).Length
        }
    }
    $results | Format-Table -AutoSize
    $missingFolder = (Invoke-NativeHost @{
        action = "reveal-file"
        path = "Z:\\dsl-video-downloader-test\\arquivo-inexistente.mp4"
    })[-1]
    if ($missingFolder.ok -or -not $missingFolder.error) {
        throw "A validacao de caminho inexistente do Explorer falhou."
    }

    Write-Host "Host API 4, Explorer, download direto e faixas separadas validados."
}
finally {
    foreach ($path in $outputs) {
        if ($path -and (Test-Path -LiteralPath $path)) { Remove-Item -LiteralPath $path -Force }
    }
}
