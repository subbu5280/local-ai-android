# Testing and verification

## On the laptop

```sh
npm test                       # Jest: all app tests (430), real SQLite through node:sqlite, fakes only at the device boundary
npx jest __tests__/knowledge   # one area, e.g. documents (also: agents, skills, code, backup, combinations, ...)
npm run typecheck              # TypeScript
npm run lint                   # ESLint
npm run release-check          # all of the above + manifest, permission, secret and dangerous-API checks (-- --build adds the APK)
(cd android && ./gradlew :app:testDebugUnitTest --offline)   # Kotlin JVM tests: backup crypto, Office extraction
```

`__tests__/combinations.test.tsx` runs the real app and checks features **against each other**: Docs mode with live
and memory questions, voice into memory, photos with Docs mode, follow-ups, a double Send, and a restart.

## Evaluations

Scores are measurements, not pass/fail tests; reports go to `eval/results/`.

```sh
npm run eval                                                       # language detection and keyword retrieval
powershell -ExecutionPolicy Bypass -File scripts\eval-embeddings.ps1    # retrieval with the real embedding model
powershell -ExecutionPolicy Bypass -File scripts\eval-translation.ps1   # translation with the app's model (chrF)
```

The two scripts download their models (SHA-256 checked) into the git-ignored `eval/.cache` and run llama.cpp b10256,
the build inside llama.rn. See [eval/README.md](../eval/README.md).

## On an emulator

```sh
node scripts/release-check.mjs --build --emulator emulator-5554   # + backup crypto on the device and a backup/restore run through the UI
```

OCR: push the language files with `scripts\push-tessdata.ps1 -Serial emulator-5554 -From <folder>` (it refuses
anything that isn't an emulator), then run `OcrDeviceTest`:
`adb shell am instrument -w -e class com.subbu.localai.OcrDeviceTest com.subbu.localai.test/androidx.test.runner.AndroidJUnitRunner`.

## On a phone

`scripts\device-check.ps1` installs the release APK as an upgrade (chats and the model are kept), launches it,
measures load and answer speed from the app's `LOCALAI_METRIC` log lines (numbers only, never message text) and
writes evidence to the git-ignored `verification/runs/`. `-DriveUi` adds History, timed prompts and Stop. It never
uninstalls, clears data or downloads the model.

## What has been verified where

| Feature | Laptop | Emulator | Galaxy M35 |
|---|---|---|---|
| Chat, speed, Stop, history | ✓ | ✓ | ✓ 9.8–11.2 tok/s, load 6.0 s |
| Database upgrade v3 → v10 with old chats kept | ✓ | | ✓ |
| Documents: TXT, PDF, DOCX, XLSX through the picker, Docs answers | ✓ | | ✓ |
| OCR: photo and scanned PDF, language download | ✓ | ✓ 6 languages | ✓ English |
| Exact spreadsheet answers | ✓ | | ✓ |
| Translation caution | ✓ | | ✓ |
| Scheduled task notification | ✓ | ✓ incl. reboot | ✓ screen off, battery saver |
| In-chat games, Copy, Reply | ✓ | | ✓ |
| Docs mode kept after the app is closed | ✓ | | ✓ |
| Full-screen games, new theme | | | ✓ screenshots |
| Backup cryptography and restore flow | ✓ | ✓ 11/11 (2026-10-20 build) | ✓ backup saved, wrong password refused, checked (no restore) |
| MCP | ✓ fake server, live DeepWiki | ✓ add suggested server, tools off, confirm, real call | ✓ same, real DeepWiki call |
| Image generation (SD-Turbo + TAESD) | ✓ 7.5 s per image | ✓ 45 s per image, download confirm, 2 GB verified | ✓ 79 s per image, chat model back after |
| Location permission prompt, "where am I", time | ✓ | ✓ Android prompt, then answer | ✓ |
| Agents: model-made plans (after the JSON fix) | ✓ | ✓ "plan proposed by the on-device model" | ✓ 18% of 250 = 45 |
| Chat model download via Android's download service | ✓ | ✓ notification, 130 s, verified | not yet |
| Live weather, memory, in-chat game, translation caution | ✓ | ✓ | ✓ (weather, game, caution) |
| Voice: Speak (text-to-speech) | ✓ | | ✓ reads aloud (Google TTS; Samsung's engine is private to Samsung apps) |
| Voice: microphone | ✓ | | not yet (needs a person speaking) |
| Game celebration and win line | ✓ | | ✓ screenshot |
| Agents: arithmetic in words ("15% of 240 plus 7" = 43) | ✓ | ✓ | ✓ |
