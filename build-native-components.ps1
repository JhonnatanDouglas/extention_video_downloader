$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$framework = Split-Path -Parent $compiler
$hostSource = Join-Path $root "native-host\DslVideoDownloaderHost.cs"
$hostOutputDirectory = Join-Path $root "native-host\bin"
$hostOutput = Join-Path $hostOutputDirectory "DslVideoDownloaderHost.exe"
$installerSource = Join-Path $root "setup-installer\DslVideoDownloaderSetup.cs"
$installerOutput = Join-Path $root "MinhaExtensaoVideoDownloader\installer\DSL-Video-Downloader-Setup.exe"

if (-not (Test-Path -LiteralPath $compiler)) {
    throw "Compilador .NET Framework nao encontrado em $compiler"
}

New-Item -ItemType Directory -Force -Path $hostOutputDirectory | Out-Null

& $compiler /nologo /optimize+ /target:exe /platform:anycpu `
    "/out:$hostOutput" `
    "/reference:$(Join-Path $framework 'System.dll')" `
    "/reference:$(Join-Path $framework 'System.Core.dll')" `
    "/reference:$(Join-Path $framework 'System.Net.Http.dll')" `
    "/reference:$(Join-Path $framework 'System.Web.Extensions.dll')" `
    $hostSource
if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar o host nativo." }

& $compiler /nologo /optimize+ /target:winexe /platform:anycpu `
    "/out:$installerOutput" `
    "/reference:$(Join-Path $framework 'System.dll')" `
    "/reference:$(Join-Path $framework 'System.Core.dll')" `
    "/reference:$(Join-Path $framework 'System.Windows.Forms.dll')" `
    "/resource:$hostOutput,DslVideoDownloaderHost.exe" `
    $installerSource
if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar o instalador." }

Write-Host "Host: $hostOutput"
Write-Host "Instalador: $installerOutput"
