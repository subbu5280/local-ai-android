<#
.SYNOPSIS
  Fetch stable-diffusion.cpp (pinned commit, with its ggml submodule) into android/sdjni/third_party/ for the optional
  on-device image generation. Without it the app still builds; image generation then reports "not in this build".
  The folder is git-ignored (about 300 MB of upstream source).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\fetch-sdcpp.ps1
#>
$ErrorActionPreference = 'Stop'
$Commit = '95b3090'  # master-975, 2026-10-18; the commit the app's image generation was tested with
$Dir = Join-Path (Split-Path -Parent $PSScriptRoot) 'android\sdjni\third_party\stable-diffusion.cpp'
if (-not (Test-Path $Dir)) {
  git clone --quiet https://github.com/leejet/stable-diffusion.cpp.git $Dir
}
git -C $Dir fetch --quiet origin
git -C $Dir checkout --quiet $Commit
git -C $Dir submodule update --quiet --init --recursive
Write-Host "stable-diffusion.cpp at $(git -C $Dir rev-parse --short HEAD) in $Dir"
