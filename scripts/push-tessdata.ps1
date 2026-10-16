# M13: copy tessdata_fast language files onto an EMULATOR's debug build for OcrDeviceTest (run-as works only on
# debuggable apps). Usage: .\scripts\push-tessdata.ps1 -Serial emulator-5554 -From C:\path\to\tessdata
# Refuses any serial that is not an emulator, so the physical phone's app data is never touched.
param([Parameter(Mandatory)][string]$Serial, [Parameter(Mandatory)][string]$From)
if ($Serial -notlike 'emulator-*') { throw "Only emulators are allowed (got $Serial)" }
$pkg = 'com.subbu.localai'
adb -s $Serial shell run-as $pkg mkdir -p files/ocr/tessdata
foreach ($f in Get-ChildItem $From -Filter *.traineddata) {
  adb -s $Serial push $f.FullName "/data/local/tmp/$($f.Name)" | Out-Null
  adb -s $Serial shell "run-as $pkg cp /data/local/tmp/$($f.Name) files/ocr/tessdata/$($f.Name) && rm /data/local/tmp/$($f.Name)"
  Write-Host "pushed $($f.Name)"
}
