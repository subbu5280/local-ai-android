<#
.SYNOPSIS
  Reproduce the embedding evaluation: download llama.cpp b10256 (the llama.cpp build inside llama.rn 0.12.9) and the
  multilingual-e5-small Q8_0 GGUF used by the app, verify their sha256, start llama-server, and run the retrieval
  evaluation with keyword, meaning-only and hybrid retrieval.

  Downloads (~150 MB) go to eval/.cache (git-ignored). Nothing is installed system-wide. The phone is not involved.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\eval-embeddings.ps1
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Cache = Join-Path $Root 'eval\.cache'
New-Item -ItemType Directory -Force -Path $Cache | Out-Null

$files = @(
  @{ Name = 'llama.zip'; Url = 'https://github.com/ggml-org/llama.cpp/releases/download/b10256/llama-b10256-bin-win-cpu-x64.zip'; Sha = $null },
  @{ Name = 'e5-tw-q8_0.gguf'; Url = 'https://huggingface.co/TwinSunsLLC/multilingual-e5-small-gguf/resolve/main/multilingual-e5-small-q8_0.gguf';
     Sha = 'e011debc1208e31bf7b6aebee2d9fc8bd2ca11694a77ed66ac9d0c9d0a877c93' }
)
foreach ($f in $files) {
  $path = Join-Path $Cache $f.Name
  if (-not (Test-Path $path)) { Write-Host "Downloading $($f.Name)…"; Invoke-WebRequest -Uri $f.Url -OutFile $path -UseBasicParsing }
  if ($f.Sha -and (Get-FileHash $path -Algorithm SHA256).Hash.ToLower() -ne $f.Sha) { Remove-Item $path; throw "sha256 mismatch for $($f.Name); deleted" }
}
$llama = Join-Path $Cache 'llama'
if (-not (Test-Path (Join-Path $llama 'llama-server.exe'))) { Expand-Archive -Path (Join-Path $Cache 'llama.zip') -DestinationPath $llama -Force }

$server = Start-Process -FilePath (Join-Path $llama 'llama-server.exe') -PassThru -WindowStyle Hidden -ArgumentList @(
  # Quoted: Start-Process joins arguments with spaces, and this project's path contains spaces.
  '-m', ('"' + (Join-Path $Cache 'e5-tw-q8_0.gguf') + '"'), '--embedding', '--pooling', 'mean', '--port', '8091', '-c', '512', '-b', '512', '-ub', '512',
  '-t', '4', '--host', '127.0.0.1')
try {
  for ($i = 0; $i -lt 30; $i++) {
    try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:8091/health' -UseBasicParsing).StatusCode -eq 200) { break } } catch {}
    Start-Sleep -Seconds 1
  }
  Push-Location $Root
  $env:LOCALAI_EMBED_URL = 'http://127.0.0.1:8091'
  if (-not $env:EVAL_LABEL) { $env:EVAL_LABEL = 'e5' }
  npx jest -c eval/jest.config.js eval/retrieval
  Pop-Location
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
