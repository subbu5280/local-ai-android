<#
.SYNOPSIS
  Translation evaluation (M13) on the laptop: the app's chat model (Qwen2.5 1.5B Instruct Q4_K_M, sha256-checked) on
  llama.cpp b10256 (the build inside llama.rn). Downloads (~1.1 GB, plus llama.cpp from eval-embeddings.ps1) go to
  eval/.cache (git-ignored). The phone is not involved.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\eval-translation.ps1
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Cache = Join-Path $Root 'eval\.cache'
$model = Join-Path $Cache 'qwen2.5-1.5b-q4km.gguf'
$sha = '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'
if (-not (Test-Path $model)) {
  Invoke-WebRequest -Uri 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf' -OutFile $model -UseBasicParsing
}
if ((Get-FileHash $model -Algorithm SHA256).Hash.ToLower() -ne $sha) { Remove-Item $model; throw 'sha256 mismatch; deleted' }
$llama = Join-Path $Cache 'llama'
if (-not (Test-Path (Join-Path $llama 'llama-server.exe'))) { throw 'Run scripts\eval-embeddings.ps1 once first (it fetches llama.cpp b10256)' }

$server = Start-Process -FilePath (Join-Path $llama 'llama-server.exe') -PassThru -WindowStyle Hidden -ArgumentList @(
  '-m', ('"' + $model + '"'), '--port', '8092', '-c', '2048', '-t', '4', '--host', '127.0.0.1')
try {
  for ($i = 0; $i -lt 60; $i++) {
    try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:8092/health' -UseBasicParsing).StatusCode -eq 200) { break } } catch {}
    Start-Sleep -Seconds 1
  }
  Push-Location $Root
  $env:LOCALAI_CHAT_URL = 'http://127.0.0.1:8092'
  if (-not $env:EVAL_LABEL) { $env:EVAL_LABEL = 'm13' }
  npx jest -c eval/jest.config.js eval/translation
  Pop-Location
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
