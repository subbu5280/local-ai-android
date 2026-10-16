# Building and releasing

## Toolchain (as used for M1–M10)

| Tool | Version |
|---|---|
| Node.js | 24.x (24.18.0 used) |
| npm | Bundled with Node |
| JDK | 17 (Temurin 17.0.20.1 used; Gradle 9.4.1 wrapper, Android Gradle Plugin via React Native 0.87.1) |
| Android SDK | compileSdk 37, targetSdk 36, minSdk 24, build tools 37.0.0, NDK 27.1.12297006 |
| ABIs | arm64-v8a, x86_64 |
| Environment | `ANDROID_HOME` (or `android/local.properties` with `sdk.dir`) |

On Windows, run `npm install` from **PowerShell**: llama.rn's install step fails under Git Bash's `tar`.

## Commands

```sh
npm install                                   # dependencies (exact versions from package-lock.json)
npm run typecheck                             # TypeScript
npm run lint                                  # ESLint
npm test                                      # all Jest suites (no phone needed)
npm run release-check                         # all of the above + manifest, secret and dangerous-API checks
node scripts/release-check.mjs --build        # ...and the release APK, with its size and SHA-256
cd android && ./gradlew assembleRelease       # release APK only (gradlew.bat on Windows)
cd android && ./gradlew assembleDebug         # debug APK (needs Metro: npm start)
```

The release APK is written to `android/app/build/outputs/apk/release/app-release.apk`, about 130 MB. Most of that is
llama.rn's native libraries for two ABIs. Models are not in the APK; they are downloaded after install.

**Debug vs release:**
- Debug loads JavaScript from Metro, is debuggable, and allows cleartext to localhost.
- Release bundles the JavaScript (Hermes), is not debuggable, and has cleartext off.

**Verify an artifact:** `node scripts/release-check.mjs --build` prints the SHA-256. With the Android build tools,
`apksigner verify --print-certs app-release.apk` shows the signing certificate.

## Signing

Without configuration, release APKs are signed with the **public debug key**, `android/app/debug.keystore`, as in
M1–M7. That is fine for your own phone, but it is not a secure identity for distribution.

To sign with your own key (owner action, done once). Nothing goes into the repository:

1. **Create the key** in a folder **outside the project**, for example `D:\keys\`:
   ```sh
   keytool -genkeypair -v -keystore D:/keys/localai-release.jks -alias localai -keyalg RSA -keysize 4096 -validity 10000
   ```
2. **Configure it outside the repository**, in one of two ways:
   - The Gradle user properties file. On this machine that is `%GRADLE_USER_HOME%\gradle.properties` =
     `D:\gradle-home\gradle.properties`; elsewhere it is `~/.gradle/gradle.properties`.
     ```
     LOCALAI_RELEASE_STORE_FILE=D:/keys/localai-release.jks
     LOCALAI_RELEASE_STORE_PASSWORD=...
     LOCALAI_RELEASE_KEY_ALIAS=localai
     LOCALAI_RELEASE_KEY_PASSWORD=...
     ```
   - Environment variables named `ORG_GRADLE_PROJECT_LOCALAI_RELEASE_STORE_FILE` (and so on). Avoid passing passwords
     with `-P` on a command line, because shells keep a history.
3. **Build:** `cd android && gradlew assembleRelease`, or `node scripts/release-check.mjs --build`.
4. **Verify:** `apksigner verify --print-certs android/app/build/outputs/apk/release/app-release.apk` must show
   *your* certificate, not `CN=Android Debug`. `release-check --build` prints it.
5. **Back up the keystore and both passwords** in two places you control, for example an encrypted USB drive and a
   password manager. Without them, updates to the installed app can't be signed: you would have to uninstall, and
   that deletes its data.

**Safety checks in `android/app/build.gradle` (M10, tested with a throwaway key):** the build **fails** rather than
quietly falling back to the debug key when:
- `LOCALAI_RELEASE_STORE_FILE` is set but the keystore file doesn't exist;
- any of the passwords or the alias is missing;
- the keystore is inside the project folder.

`*.jks`, `*.keystore` (except the public `debug.keystore`) and `keystore.properties` are git-ignored, and
`release-check` scans for leaked passwords.

An APK signed with a different key **can't update** an installed one. Switching from the debug key to your own means
uninstalling first, which deletes the app's data, so **make an encrypted backup first** and restore it afterwards.
The package id `com.subbu.localai` is unchanged.

## Limits of the checks

- `release-check` scans the files git would track for known secret formats and for dangerous APIs. It does not prove
  absence.
- `npm audit` needs the network and is not part of the check. Run it before publishing.
- The on-device tests (M9) cover the backup cryptography and the backup/restore flow on an emulator. Other device
  behavior (model speed, providers such as Google Drive, a real phone) is checked with `scripts/device-check.ps1`
  and the device-only list in the README.

## Native and emulator checks (M9)

```sh
cd android && ./gradlew :app:testDebugUnitTest --offline      # production BackupCrypto on the laptop JVM (11 tests)
node scripts/release-check.mjs --build --emulator emulator-5554 --reference ../AI-ChatBot
```

The full command runs everything above, then:
- builds the release APK, and checks its merged manifest and its signing certificate with `apksigner`;
- on the emulator:
  - installs the debug app and the instrumentation APK, and runs the 14 on-device crypto tests (`am instrument`);
  - runs `scripts/emulator-backup-e2e.mjs`, the release app's backup and restore through the real UI;
- confirms the reference repository has no changes.

The emulator steps **refuse a physical phone**, because they clear the app's data. Start an emulator first, for
example `emulator -avd Pixel_10a -no-window`. The test libraries (JUnit 4.13.2, AndroidX Test runner 1.7.0 and
ext-junit 1.3.0) are test-only dependencies and are not in the app. They resolve from the local Gradle cache, so
`--offline` works.

**Signing (verified M9):** `apksigner verify --print-certs` on the release APK reports
`CN=Android Debug, OU=Android, O=Unknown`. That signature is fine for your own phone, but **it is not a production
release**. Configure your own key as described above before distributing the app. Switching keys means reinstalling,
which deletes app data, so back up first.

## Galaxy M35 validation (one owner session)

Every check here is non-destructive. Nothing clears app data or uninstalls. Before you start: make an encrypted
backup in the app you have now (Data → Backup and restore) and keep it on the phone or PC.

**Install.** `adb -s <M35 serial> install -r android/app/build/outputs/apk/release/app-release.apk`. This updates the
app in place, and your data stays, **only if** it is signed with the same key as the installed app, which is the debug
key. If you've switched to your own key, read "Signing" first: a key change needs an uninstall, which deletes data.

| # | Check | Pass when |
|---|---|---|
| 1 | Data → Backup: create with a password, and save to **internal storage**, then to **Google Drive** | "Saved … checked after writing and after copying" both times. Note the seconds from Create to the save dialog (PBKDF2; the emulator took 2–4 s). |
| 2 | Data → Restore: pick that backup, enter a **wrong** password | "Wrong password … Nothing was restored"; Chats, Documents and Agents unchanged |
| 3 | Same backup with the right password → Merge | "Restore finished."; everything is "already here"; nothing duplicated |
| 4 | Documents: import a TXT and a text-layer PDF from internal storage, then search a word in each | Both are listed as ready, and search finds both (FTS5 on Android 16) |
| 5 | Code: add a folder from internal storage, ask about a file, apply a one-line proposal to a **test** file, then Restore original | Diff applied and verified; the original is restored |
| 6 | Docs mode question, and an agent task with the model loaded | Answer with sources; a valid plan (model JSON) |
| 7 | Data → Storage numbers | Database and model sizes roughly match Android Settings → Apps → Local AI → Storage |
| 8 | `adb shell bmgr backupnow com.subbu.localai` | Reports the package as not eligible or excluded; nothing of the app is backed up (device-to-device transfer can only be checked during a real phone setup) |
| 9 | Optional: on an SD card or Google Drive, repeat check 5's folder access | It works, or the app clearly explains the limitation |

Record the results, especially the seconds in check 1. Any failure is a defect to fix before release.

## Final release status (M10, 2026-10-14)

**Conditionally ready.** One owner action and one owner validation session remain:
- signing with your own key ("Signing" above);
- the "Galaxy M35 validation" checks.

| Check | Result |
|---|---|
| `release-check --build --reference` | 16/16 |
| Jest | 325/325 |
| Kotlin JVM crypto | 11/11 |
| TypeScript | 0 errors |
| ESLint | 0 errors, 44 warnings, reviewed: intentional bitwise code in vector encoding and hashing, styling, test code |
| Emulator crypto and end to end (M9; the code they cover is unchanged since) | 14 tests, 11/11 steps |
| Release manifest | Not debuggable; cleartext off; cloud backup and device transfer excluded; only INTERNET and ACCESS_NETWORK_STATE |

**Artifact:** `android/app/build/outputs/apk/release/app-release.apk`, 135,913,277 bytes (129.6 MB),
SHA-256 `20edee7e9b7b4229e5be782dfaac463328ce1794d9d84fcd8cf1c828ec0f5a74`. **Signed with the debug key**
(`CN=Android Debug`), so it is not production-signed.
