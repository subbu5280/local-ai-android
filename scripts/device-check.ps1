<#
.SYNOPSIS
  Grouped device verification for Local AI, driven from the laptop over ADB.

.DESCRIPTION
  Builds the release APK, installs it as an upgrade (app data, saved chats and the downloaded model are kept), launches
  it and collects evidence into verification/runs/<timestamp>/:
    device.txt, apk.txt, launch.txt, meminfo-*.txt, thermal-*.txt, battery-*.txt, metrics.jsonl, logcat.txt,
    ui-*.xml (screen dumps; they contain chat text, so the runs folder is git-ignored) and summary.md.

  Results are read from the app's own LOCALAI_METRIC log lines (src/metrics.ts) and from Android tools
  (dumpsys, uiautomator). Nothing is guessed: a check that did not run is reported as NOT RUN.

  Safety:
    - never uninstalls the app, clears app data, or deletes chats or models;
    - never downloads the model by itself (the user taps "Get model" and confirms on the phone);
    - changes airplane mode only with -AirplaneTest AND a typed YES, and always restores the original state;
    - -DriveUi sends a few English test messages; they are saved as a new chat on the phone ("New chat" is tapped
      first, so the user's open chat is not touched).

.PARAMETER DriveUi
  Also drive the UI: History + Back, three test prompts with timings, Stop, memory during inference.
.PARAMETER AirplaneTest
  Also check that chat answers with airplane mode on (needs -DriveUi; asks for confirmation; restores the setting).
.PARAMETER Eval
  Also run the answer-quality evaluation (eval/datasets/answers-v1.json) on the phone's model through the app's
  developer screen; answers and automated checks are saved to eval-answers.jsonl (takes several minutes).
.PARAMETER SkipBuild
  Install the existing release APK instead of building it.
.PARAMETER ModelWaitSec
  How long to wait for the model to download/load when it is not installed yet (the user confirms on the phone).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\device-check.ps1 -DriveUi
#>
param(
  [switch]$DriveUi,
  [switch]$AirplaneTest,
  [switch]$SkipBuild,
  [switch]$Eval,
  [int]$ModelWaitSec = 900
)

$ErrorActionPreference = 'Continue' # native tools write to stderr; failures are checked through exit codes
$Package = 'com.subbu.localai'
$Root = Split-Path -Parent $PSScriptRoot
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Out = Join-Path $Root "verification\runs\$Stamp"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Results = New-Object System.Collections.Generic.List[object]

function Add-Result([string]$Check, [string]$Status, [string]$Detail = '') {
  # Status: PASS | FAIL | NOT RUN | INFO | MANUAL
  $Results.Add([pscustomobject]@{ Check = $Check; Status = $Status; Detail = $Detail })
  Write-Host ("[{0}] {1} {2}" -f $Status, $Check, $Detail)
}

# ---------------------------------------------------------------- adb

$Adb = if ($env:ANDROID_HOME) { Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' } else { 'adb' }
if (-not (Get-Command $Adb -ErrorAction SilentlyContinue)) { $Adb = 'adb' }

function Adb {
  # Returns stdout lines as strings; stderr is dropped (exit code is in $LASTEXITCODE).
  $o = & $Adb @args 2>$null
  return @($o | ForEach-Object { "$_" })
}
function Shell([string]$Command) { return (Adb shell $Command) }

function Write-Summary {
  $lines = @("# Local AI device check $Stamp", '', '| Check | Status | Detail |', '|---|---|---|')
  foreach ($r in $Results) { $lines += "| $($r.Check) | $($r.Status) | $($r.Detail -replace '\|', '/') |" }
  $lines += ''
  $lines += 'Statuses: PASS / FAIL = measured by this script; NOT RUN = not executed (see detail);'
  $lines += 'MANUAL = needs a person (judgment, non-English typing, visual layout); INFO = recorded value.'
  Set-Content -Path (Join-Path $Out 'summary.md') -Value $lines -Encoding UTF8
  Write-Host "`nEvidence and summary: $Out"
}

# ---------------------------------------------------------------- 1. device

$devices = Adb devices | Where-Object { $_ -match "`t" }
$ready = @($devices | Where-Object { $_ -match "`tdevice$" })
if ($ready.Count -ne 1) {
  $why = if ($devices | Where-Object { $_ -match 'unauthorized' }) { 'phone is connected but USB debugging is not authorized (accept the prompt on the phone)' }
         elseif ($ready.Count -gt 1) { 'more than one device connected; connect only the test phone' }
         else { 'no phone connected (USB debugging on, cable connected?)' }
  Add-Result 'Device connected' 'NOT RUN' $why
  Write-Summary
  exit 2
}
$serial = ($ready[0] -split "`t")[0]
$env:ANDROID_SERIAL = $serial # every adb call below targets this phone

$prop = { param($k) (Shell "getprop $k" | Select-Object -First 1).Trim() }
$sdk = [int](& $prop 'ro.build.version.sdk')
$deviceInfo = [ordered]@{
  model = "$(& $prop 'ro.product.manufacturer') $(& $prop 'ro.product.model')"
  android = & $prop 'ro.build.version.release'
  sdk = $sdk
  abi = & $prop 'ro.product.cpu.abi'
  soc = & $prop 'ro.soc.model'
  memTotal = (Shell 'grep MemTotal /proc/meminfo') -join ''
  memAvailable = (Shell 'grep MemAvailable /proc/meminfo') -join ''
  dataFree = (Shell 'df -h /data | tail -n 1') -join ''
}
$deviceInfo.GetEnumerator() | ForEach-Object { "$($_.Key): $($_.Value)" } | Set-Content (Join-Path $Out 'device.txt') -Encoding UTF8
Add-Result 'Device' 'INFO' "$($deviceInfo.model), Android $($deviceInfo.android) (SDK $sdk), $($deviceInfo.abi)"
if ($deviceInfo.abi -notin @('arm64-v8a', 'x86_64')) { Add-Result 'ABI supported' 'FAIL' 'llama.rn ships only arm64-v8a and x86_64' }

function Save-State([string]$Tag) {
  Shell "dumpsys meminfo $Package" | Set-Content (Join-Path $Out "meminfo-$Tag.txt") -Encoding UTF8
  Shell 'dumpsys thermalservice' | Set-Content (Join-Path $Out "thermal-$Tag.txt") -Encoding UTF8
  Shell 'dumpsys battery' | Set-Content (Join-Path $Out "battery-$Tag.txt") -Encoding UTF8
  $pss = (Get-Content (Join-Path $Out "meminfo-$Tag.txt") | Select-String -Pattern '^\s*TOTAL PSS:\s+(\d+)' | Select-Object -First 1)
  if (-not $pss) { $pss = (Get-Content (Join-Path $Out "meminfo-$Tag.txt") | Select-String -Pattern '^\s*TOTAL\s+(\d+)' | Select-Object -First 1) }
  $thermal = (Get-Content (Join-Path $Out "thermal-$Tag.txt") | Select-String -Pattern 'Thermal Status:\s*(\d+)' | Select-Object -First 1)
  $temp = (Get-Content (Join-Path $Out "battery-$Tag.txt") | Select-String -Pattern '^\s*temperature:\s*(\d+)' | Select-Object -First 1)
  $d = @()
  if ($pss) { $d += "app PSS $([math]::Round([int]$pss.Matches[0].Groups[1].Value / 1024)) MB" } else { $d += 'app not running (no PSS)' }
  if ($thermal) { $d += "thermal status $($thermal.Matches[0].Groups[1].Value)" }
  if ($temp) { $d += "battery $([int]$temp.Matches[0].Groups[1].Value / 10) C" }
  Add-Result "Resources ($Tag)" 'INFO' ($d -join ', ')
}

# ---------------------------------------------------------------- 2. build + install (upgrade only)

$apk = Join-Path $Root 'android\app\build\outputs\apk\release\app-release.apk'
if (-not $SkipBuild) {
  Push-Location (Join-Path $Root 'android')
  & .\gradlew.bat assembleRelease --console=plain *> (Join-Path $Out 'build.txt')
  $buildOk = $LASTEXITCODE -eq 0
  Pop-Location
  Add-Result 'Release build' $(if ($buildOk) { 'PASS' } else { 'FAIL' }) 'log: build.txt'
  if (-not $buildOk) { Write-Summary; exit 1 }
}
if (-not (Test-Path $apk)) { Add-Result 'APK present' 'FAIL' $apk; Write-Summary; exit 1 }
$apkInfo = "path: $apk`nbytes: $((Get-Item $apk).Length)`nsha256: $((Get-FileHash $apk -Algorithm SHA256).Hash)"
Set-Content (Join-Path $Out 'apk.txt') $apkInfo -Encoding UTF8

$install = (Adb install -r $apk) -join ' '
if ($install -match 'Success') {
  Add-Result 'Install (upgrade, data kept)' 'PASS' ("{0:N1} MB" -f ((Get-Item $apk).Length / 1MB))
} else {
  # e.g. INSTALL_FAILED_UPDATE_INCOMPATIBLE: a differently signed build is installed. Uninstalling would delete the
  # user's chats and model, so the script stops and leaves that decision to the user.
  Add-Result 'Install (upgrade, data kept)' 'FAIL' "$install (not uninstalling: that would delete chats and the model)"
  Write-Summary; exit 1
}

# ---------------------------------------------------------------- 3. launch + metrics from logcat

$since = (Shell "date '+%m-%d %H:%M:%S.000'" | Select-Object -First 1).Trim()
Shell "am force-stop $Package" | Out-Null # a clean start (only stops the process; no data is touched)
$launch = Shell "am start -W -n $Package/.MainActivity"
$launch | Set-Content (Join-Path $Out 'launch.txt') -Encoding UTF8
$total = ($launch | Select-String -Pattern 'TotalTime:\s*(\d+)' | Select-Object -First 1)
if ($total) { Add-Result 'App launch' 'PASS' "TotalTime $($total.Matches[0].Groups[1].Value) ms (cold start)" }
else { Add-Result 'App launch' 'FAIL' 'see launch.txt' }

function Get-Metrics {
  $lines = Adb logcat -d -v raw -T $since -s 'ReactNativeJS:*'
  $m = @()
  foreach ($l in $lines) {
    $i = $l.IndexOf('LOCALAI_METRIC ')
    if ($i -ge 0) { try { $m += ($l.Substring($i + 15) | ConvertFrom-Json) } catch {} }
  }
  return $m
}
function Wait-Metric([string[]]$Events, [int]$TimeoutSec, [int]$After = 0) {
  # The first metric with one of $Events beyond the first $After metrics, or $null on timeout.
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $all = @(Get-Metrics)
    $hit = $all | Select-Object -Skip $After | Where-Object { $Events -contains $_.event } | Select-Object -First 1
    if ($hit) { return $hit }
    Start-Sleep -Seconds 2
  }
  return $null
}

$state = Wait-Metric @('model_state') 60
if (-not $state) {
  Add-Result 'Metrics in logcat' 'FAIL' 'no LOCALAI_METRIC line within 60 s (app crashed, or release logging differs; see logcat.txt)'
} else {
  Add-Result 'Model state at launch' 'INFO' $state.state
  if ($state.state -ne 'installed') {
    Add-Result 'Model download' 'MANUAL' "on the phone: tap 'Get model', then 'Download' (Wi-Fi, about 1.1 GB). Waiting up to $ModelWaitSec s."
    Write-Host "`n>>> On the phone: tap 'Get model', then 'Download'. The script waits up to $ModelWaitSec s. <<<`n"
    $dl = Wait-Metric @('download') $ModelWaitSec
    if (-not $dl) { Add-Result 'Model download' 'NOT RUN' 'no download within the wait time' }
    elseif ($dl.result -eq 'ok') { Add-Result 'Model download + sha256' 'PASS' ("{0:N0} s" -f ($dl.ms / 1000)) }
    else { Add-Result 'Model download + sha256' 'FAIL' $dl.error }
  }
  $loaded = Wait-Metric @('model_loaded', 'model_load_failed') 180
  if (-not $loaded) { Add-Result 'Model load + test answer' 'NOT RUN' 'model not loaded within 180 s' }
  elseif ($loaded.event -eq 'model_loaded') {
    Add-Result 'Model load + test answer' 'PASS' "$($loaded.model): load $($loaded.loadMs) ms, test $($loaded.testTokPerSec) tok/s, gpu $($loaded.gpu), lib $($loaded.lib)"
  } else { Add-Result 'Model load + test answer' 'FAIL' $loaded.error }
}
$docs = Wait-Metric @('docs_ready') 30
if ($docs) { Add-Result 'Document search engine' $(if ($docs.engine -eq 'none') { 'FAIL' } else { 'PASS' }) "SQLite $($docs.engine) (fts5 preferred, fts4 fallback)" }
else { Add-Result 'Document search engine' 'NOT RUN' 'no docs_ready metric within 30 s' }
Save-State 'after-load'

# ---------------------------------------------------------------- 4. UI-driven checks (uiautomator, by accessibility label)

$uiCount = 0
function Get-Ui {
  $script:uiCount++
  $local = Join-Path $Out ("ui-{0:D2}.xml" -f $script:uiCount)
  # uiautomator needs an idle screen; right after a tap it can fail with "could not get idle state", so retry.
  for ($try = 0; $try -lt 3 -and -not (Test-Path $local); $try++) {
    Shell 'uiautomator dump /data/local/tmp/localai-ui.xml' | Out-Null
    Adb pull /data/local/tmp/localai-ui.xml $local | Out-Null
    Shell 'rm -f /data/local/tmp/localai-ui.xml' | Out-Null # only the dump file this script created
    if (-not (Test-Path $local)) { Start-Sleep -Seconds 1 }
  }
  if (-not (Test-Path $local)) { return $null }
  return [xml](Get-Content $local -Raw -Encoding UTF8)
}
function Find-Desc($ui, [string]$Desc) {
  if (-not $ui) { return $null }
  return $ui.SelectNodes("//node[@content-desc='$Desc']") | Select-Object -First 1
}
function Has-Text($ui, [string]$Text) {
  if (-not $ui) { return $false }
  return [bool]($ui.SelectNodes("//node[@text='$Text']") | Select-Object -First 1)
}
function Tap-At($Point) {
  Shell ("input tap {0} {1}" -f $Point[0], $Point[1]) | Out-Null
  Start-Sleep -Milliseconds 800
}
function Tap-Desc([string]$Desc) {
  # Taps the element with this accessibility label; returns its center, or $null if it is not on screen.
  $node = Find-Desc (Get-Ui) $Desc
  if (-not $node) { return $null }
  $b = [regex]::Matches($node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
  $center = @([int](($b[0] + $b[2]) / 2), [int](($b[1] + $b[3]) / 2))
  Tap-At $center
  return $center
}
function Send-Prompt([string]$Text) {
  # adb can only type plain ASCII; %s is a space for `input text`. Returns the Send button's center ($null = failed).
  if (-not (Tap-Desc 'Message')) { return $null }
  Shell ("input text '{0}'" -f ($Text -replace ' ', '%s')) | Out-Null
  Start-Sleep -Milliseconds 500
  return (Tap-Desc 'Send')
}
function App-InFront { return [bool]((Shell 'dumpsys window') -match "mCurrentFocus=.*$Package") }

if ($DriveUi) {
  if (-not $loaded -or $loaded.event -ne 'model_loaded') {
    Add-Result 'UI checks' 'NOT RUN' 'the model is not loaded'
  } else {
    # History opens, Android Back returns to the chat and does not close the app.
    if (Tap-Desc 'Saved chats') {
      $inHistory = Has-Text (Get-Ui) 'Saved chats'
      Shell 'input keyevent KEYCODE_BACK' | Out-Null
      Start-Sleep -Seconds 1
      $ui = Get-Ui
      $back = $inHistory -and -not (Has-Text $ui 'Saved chats') -and [bool](Find-Desc $ui 'Message') -and (App-InFront)
      Add-Result 'History opens; Back returns to chat (app stays open)' $(if ($back) { 'PASS' } else { 'FAIL' }) "history shown: $inHistory"
    } else { Add-Result 'History + Back' 'FAIL' "'Saved chats' button not found on screen" }

    Tap-Desc 'New chat' | Out-Null # test messages go to a new chat, not the user's open one
    $prompts = @('What is 2 + 2?', 'Explain what an Android Activity is in one sentence.',
                 'Summarize: Kafka stores records in topics. Consumers read them in order.')
    foreach ($p in $prompts) {
      $before = @(Get-Metrics).Count
      if (-not (Send-Prompt $p)) { Add-Result "Answer: $p" 'FAIL' 'could not type/send'; continue }
      $a = Wait-Metric @('answer', 'answer_failed') 240 $before
      if (-not $a) { Add-Result "Answer: $p" 'FAIL' 'no answer within 240 s' }
      elseif ($a.event -eq 'answer_failed') { Add-Result "Answer: $p" 'FAIL' $a.error }
      else {
        Add-Result "Answer: $p" 'PASS' "intent $($a.intent)/$($a.complexity), first token $($a.firstTokenMs) ms, $($a.tokens) tokens, $($a.tokPerSec) tok/s, total $($a.totalMs) ms"
      }
    }

    # Stop: a long answer is stopped; memory is sampled while it is generating.
    $before = @(Get-Metrics).Count
    $sendAt = Send-Prompt 'Tell me a long story about a robot who learns to paint.'
    if ($sendAt) {
      Start-Sleep -Seconds 4
      Save-State 'during-inference'
      # Stop replaces Send at the same place. Tapping that point avoids a screen dump while text is streaming,
      # when uiautomator often can't get an idle screen.
      Tap-At $sendAt
      $s = Wait-Metric @('answer', 'answer_failed') 60 $before
      $ok = $s -and $s.event -eq 'answer' -and $s.stopped
      Add-Result 'Stop ends a running answer' $(if ($ok) { 'PASS' } else { 'FAIL' }) $(if ($s) { "stopped=$($s.stopped), $($s.tokens) tokens" } else { 'no answer metric' })
      $ui = Get-Ui
      Add-Result 'Send available again after Stop' $(if (Find-Desc $ui 'Send') { 'PASS' } else { 'FAIL' })
    }
    Save-State 'after-inference'

    if ($AirplaneTest) {
      Write-Host "`nAirplane test: this turns AIRPLANE MODE ON on $($deviceInfo.model), then restores the current setting."
      $answer = Read-Host 'Type YES to allow it'
      if ($answer -ne 'YES') { Add-Result 'Offline chat (airplane mode)' 'NOT RUN' 'not approved' }
      elseif ($sdk -lt 30) { Add-Result 'Offline chat (airplane mode)' 'NOT RUN' 'needs Android 11+ for cmd connectivity' }
      else {
        $original = (Shell 'settings get global airplane_mode_on' | Select-Object -First 1).Trim()
        try {
          Shell 'cmd connectivity airplane-mode enable' | Out-Null
          Start-Sleep -Seconds 5
          $on = (Shell 'settings get global airplane_mode_on' | Select-Object -First 1).Trim() -eq '1'
          if (-not $on) { Add-Result 'Offline chat (airplane mode)' 'NOT RUN' 'Android refused to switch airplane mode from adb' }
          else {
            $before = @(Get-Metrics).Count
            $sent = Send-Prompt 'What is the capital of France?'
            $a = if ($sent) { Wait-Metric @('answer', 'answer_failed') 240 $before } else { $null }
            $ok = $a -and $a.event -eq 'answer'
            Add-Result 'Offline chat (airplane mode)' $(if ($ok) { 'PASS' } else { 'FAIL' }) $(if ($a) { "$($a.tokPerSec) tok/s" } else { 'no answer' })
          }
        } finally {
          if ($original -ne '1') { Shell 'cmd connectivity airplane-mode disable' | Out-Null }
          $now = (Shell 'settings get global airplane_mode_on' | Select-Object -First 1).Trim()
          Add-Result 'Airplane mode restored' $(if ($now -eq $original) { 'PASS' } else { 'FAIL' }) "now $now, was $original"
        }
      }
    }
  }
} else {
  Add-Result 'UI checks (History/Back, prompts, Stop)' 'NOT RUN' 'run with -DriveUi'
}

if ($Eval) {
  if (-not $loaded -or $loaded.event -ne 'model_loaded') { Add-Result 'Answer evaluation' 'NOT RUN' 'the model is not loaded' }
  elseif ((Tap-Desc 'Agents') -and (Tap-Desc 'Model evaluation') -and (Tap-Desc 'Run model evaluation')) {
    $before = @(Get-Metrics).Count
    $done = Wait-Metric @('eval_done') 2400 $before
    $evalLines = Adb logcat -d -v raw -T $since -s 'ReactNativeJS:*' | ForEach-Object { $i = $_.IndexOf('LOCALAI_EVAL '); if ($i -ge 0) { $_.Substring($i + 13) } }
    $evalLines | Set-Content (Join-Path $Out 'eval-answers.jsonl') -Encoding UTF8
    if ($done) { Add-Result 'Answer evaluation' 'INFO' "$($done.cases) cases answered; checks and answers in eval-answers.jsonl (review by a person)" }
    else { Add-Result 'Answer evaluation' 'FAIL' 'no eval_done within 40 min' }
    Shell 'input keyevent KEYCODE_BACK' | Out-Null; Shell 'input keyevent KEYCODE_BACK' | Out-Null
  } else { Add-Result 'Answer evaluation' 'FAIL' 'could not open the evaluation screen' }
}

# ---------------------------------------------------------------- 5. logs, crashes, metrics

$log = Adb logcat -d -T $since
$log | Set-Content (Join-Path $Out 'logcat.txt') -Encoding UTF8
@(Get-Metrics) | ForEach-Object { $_ | ConvertTo-Json -Compress } | Set-Content (Join-Path $Out 'metrics.jsonl') -Encoding UTF8
$crash = $log | Select-String -Pattern "FATAL EXCEPTION|Process: $Package|lowmemorykiller.*$Package|ANR in $Package"
Add-Result 'No crash / ANR / low-memory kill in logcat' $(if ($crash) { 'FAIL' } else { 'PASS' }) $(if ($crash) { ($crash | Select-Object -First 1).Line.Trim() } else { '' })

foreach ($m in @(
    'Telugu, Hindi, Tamil, Kannada, Malayalam prompts: adb cannot type these scripts; type one per language and judge the answer language',
    'Answer quality and whether task lines help (translation-only, no invented news): needs human judgment',
    'Keyboard layout: input stays above the keyboard while typing (visual)',
    'Offline download refusal: turn Wi-Fi and data off, tap Get model only if the model is not installed yet',
    'Sustained heat: several minutes of continuous answers (this script samples only a few points)',
    'Documents: import a TXT, Markdown, CSV and text PDF with the system picker, search them, ask in Docs mode (picker taps need a person)')) {
  Add-Result 'Needs a person' 'MANUAL' $m
}

Write-Summary
if ($Results | Where-Object { $_.Status -eq 'FAIL' }) { exit 1 } else { exit 0 }
