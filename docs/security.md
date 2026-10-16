# Security, privacy and data protection (M8)

This review covers M1–M8 at source level, done on 2026-10-13. Static checks and tests catch known mistakes; they do not
prove the app is secure. Nothing in this document claims protection beyond what is described.

## What the app stores, and where

| Data | Where | Kept until |
|---|---|---|
| Chats, memories, learned facts | App-private SQLite (`AiStoreModule`) | You delete them (History; memories commands) |
| Imported document text and its index | App-private SQLite | You delete the document (Documents) |
| Meaning-search vectors | App-private SQLite | Meaning search removed, or Data → Remove vectors |
| Agents, skills, workflows, run history | App-private SQLite | You delete them (the run history of a definition: Delete history) |
| Workspace listings, coding tasks | App-private SQLite (names and URIs; no file contents) | You delete them, or remove the workspace |
| Code proposals | App-private SQLite, **with the original and proposed text of each changed file** | You delete them; or the retention you choose (7 or 30 days, finished proposals only) |
| Models | App-private files (`models/`), each verified by SHA-256 | You remove them |
| Backup temporary files | App-private cache (`cache/backup/`) | Deleted after each backup or restore; abandoned ones are removed at launch |
| Restore journal | App-private SQLite: categories, modes, outcomes; never content or passwords | You dismiss it |
| Encrypted backups | Wherever you saved them | You delete them |

**Deletion** removes rows from SQLite or files from storage. `PRAGMA secure_delete` is on, so deleted rows are
overwritten in the database file. Flash storage wear-levelling, SQLite's journal and Android's file system may still
keep older copies until they are reused. This is **not a secure erase**. Android's file-based encryption protects
app data at rest when the phone is off or locked before first unlock.

## Network

The only outbound connection is a **model download the user confirmed**. The connection is checked first, and the
download is offered only online:
- **How:** `RNFS.downloadFile` from catalog URLs that must be `https://huggingface.co/…` (`modelManager.validateCatalog`).
- **Integrity:** the file is verified by SHA-256 before an "installed" marker is written. Only a model with that
  marker loads (`isInstalled`).
- **Release builds:** cleartext HTTP is off (`network_security_config.xml`). Debug builds allow it only for
  `localhost` / `127.0.0.1`, which Metro uses.

There is no telemetry, analytics, crash reporting, remote logging, remote backup, or code upload. Sharing a skill's
JSON uses Android's share sheet and happens only when you tap Share.

## Logging

`metric()` writes `LOCALAI_METRIC` lines to logcat, which `scripts/device-check.ps1` reads. They contain:
- numbers and labels;
- skill and workflow ids;
- model and runtime error messages, truncated to 120 characters.

They never contain message text, prompts, answers, document or source text, passwords or file names. Logcat is
readable over ADB on a phone with USB debugging enabled. A test (`backup.test.ts`) checks that a backup password never
reaches any `console` method, and `src/backup/` has no logging at all.

## Android configuration

- **Permissions** (updated after M14; the release check and `storage.test.ts` fail on any other):
  - `INTERNET` and `ACCESS_NETWORK_STATE`: confirmed downloads, live questions you ask, MCP servers you add.
  - `ACCESS_COARSE_LOCATION`: approximate location, asked only when you ask for "weather here"; never stored.
  - `RECORD_AUDIO`: asked when you tap the microphone.
  - `POST_NOTIFICATIONS`: asked when you schedule the first task (Android 13+).
  - `RECEIVE_BOOT_COMPLETED`: re-arms scheduled-task alarms after a restart (normal permission, no prompt).
  - `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, added by AndroidX; signature-level and internal.
  - No storage, media or camera permission: the camera and gallery go through Android's own pickers.
  - `READ`/`WRITE_EXTERNAL_STORAGE` from react-native-fs are explicitly removed.
- **Files:** documents, project folders and backups are reached only through the Storage Access Framework, for
  exactly what the user picks.
- **Backups and transfer:**
  - `android:allowBackup="false"`.
  - **New in M8:** `android:dataExtractionRules`, which excludes every domain from cloud backup and from
    device-to-device transfer. On Android 12+ `allowBackup="false"` alone does not stop device-to-device transfer.
  - `fullBackupContent` excludes everything on Android 6–11.
- **Exported components:** the launcher activity, which also opens `localai://task/<id>` links from scheduled-task
  notifications. Any app could open such a link, so it only puts the saved prompt in the message box; the user taps
  Send. `BootReceiver` is exported only to receive `BOOT_COMPLETED`, a protected broadcast other apps cannot send.
  `ScheduleReceiver` is not exported. There are no WebViews, and release builds are not debuggable.
- **Network beyond downloads** (M11–M14): live questions go to Open-Meteo, CoinGecko and Google News RSS with only the
  place or topic asked about; MCP calls go only to https servers you added, with only the arguments you confirmed.
- **Signing:** see [release.md](release.md). By default release builds are still signed with the public debug key, as
  before. A real key is used only when the `LOCALAI_RELEASE_*` properties are set outside the repository. The
  release check prints which key was used.
- **Native module boundaries:**
  - `AiDocs.saveCopy` / `openCopy` accept only paths directly inside `cache/backup`.
  - `AiWorkspace` writes only after the approval flow.
  - `AiCrypto` keeps keys native.
  - No module executes code, starts processes, or deletes user files, except two removals of a file the app itself
    just created: a backup copy that failed verification, and a workspace file the provider renamed.

## Content security

- **Untrusted input:** imported documents, source files, error text, skill and workflow imports, model output, and
  restored backups are all treated as untrusted. Each is fenced as data in prompts and validated against fixed
  schemas.
- **Agents:** agent plans, skills and workflows can use only registered tools with validated inputs. There is no
  shell, `eval` or network tool. File-creating tools always ask first.
- **Coding assistant:** changes are applied only by `src/code/apply.ts`, after explicit approval, with paths
  re-validated and stale files detected.
- **Restored definitions** are validated again exactly as new ones are, and invalid ones are skipped. A restored
  *ready* code proposal becomes stale and can't be applied.
- **Backups** are JSON rows checked against per-table column schemas, with no paths, archives or compression.
  Nothing in a backup can execute or write outside the database.
- **Error messages** name fields and rules, not values: credentials in memories are refused, backup errors don't echo
  content, and restore notes name items by id or name only.

## Encrypted backups

AES-256-GCM is used with a key from PBKDF2-HMAC-SHA256 (600,000 iterations and a fresh 16-byte salt per backup).
Chunk nonces never repeat, and the header, chunk order and the end of the file are all authenticated. The whole
backup is authenticated and validated before any data is imported. See
[backup-and-restore.md](backup-and-restore.md).

Limitations:
- A weak password can be guessed offline by anyone who has the file. PBKDF2 only slows that down. The app requires
  at least 10 characters but can't judge password strength.
- A forgotten password makes the backup unrecoverable.
- The password is a JavaScript string while typed, and JS strings can't be wiped from memory. It is cleared from the
  screen state after use and is never stored or logged.
- Argon2id would resist GPU guessing better. It is not used because no maintained implementation is already in the
  project, and adding a native crypto dependency was not justified for M8. PBKDF2-HMAC-SHA256 is a platform API.

## Threat model

| Threat | Mitigation | What remains |
|---|---|---|
| Accidental data loss (deleting, a bad restore) | Deletions ask first and name what is removed. Merge never overwrites; replace needs confirmation. Each restored category is one transaction, with a journal. | No undo after a confirmed delete or replace. Make a backup first. |
| Device loss or theft | Android device encryption and the lock screen. App data is excluded from cloud backup and device transfer. | A thief with the phone unlocked sees everything. The app has no PIN of its own. |
| Backup theft | AES-256-GCM with a PBKDF2 key; nothing readable without the password. | Offline guessing of weak passwords. Metadata visible without the password: file size, creation time (file system), KDF settings. |
| Backup tampering | Every chunk and the header are authenticated, along with chunk order and the end marker. Strict limits apply before key derivation. Everything is validated before import. | A valid backup made by someone else who knows your password is accepted. |
| Malicious imported content | Documents, source, error text, skills and workflows, and backups are fenced or validated. The model has no free tools. Writes need approval. | A small model can still give wrong or misleading answers. |
| Unreliable storage providers | Writes are hash-checked with read-back. New files never replace existing ones. Backup copies are verified. Provider limits are reported. | No atomic multi-file writes or rollback. Some providers may not support truncation or creation (unverified on a device). |
| Crash during writes | Proposals: per-file outcome recorded, *interrupted* on restart, restore original. Restore: journal and per-category transactions. Imports: *interrupted* and retry. Model download: `.part` file, verified before install. Backup: temporary file, never presented as done. | A crash mid-write inside a provider can leave a damaged file. The app reports *unknown* and offers restore where possible. |
| Unauthorized file changes | Only the approval screen can write project files, after re-validation and stale checks. Agents, skills and workflows have read-only workspace tools. | The user can approve a bad change. Review the diff. |
| Weak or forgotten backup password | Minimum length, confirmation, and a clear warning. | Can't be recovered, by design. |
| Secrets retained in proposals | Best-effort redaction before the model sees text. Proposals are excluded from backups by default, with a warning. Retention and deletion controls; secure_delete. | Unrecognized secrets stay in proposal text until deleted. Deletion is not a secure erase. |
| Dependency vulnerabilities | Few dependencies: React Native 0.87.1, llama.rn 0.12.9, react-native-fs 2.40.3, safe-area-context. Versions are pinned in `package-lock.json`. | `npm audit` needs the network and was not run in M8. Check before publishing. |
| Physical access to an unlocked device | None beyond Android's. | Full access to app data and the ability to make backups. |

## Audit findings and changes in M8

1. **Fixed:** app data could move to a new phone through Android 12+ device-to-device transfer, despite
   `allowBackup="false"`. `dataExtractionRules` and `fullBackupContent` now exclude everything.
2. **Fixed:** a database written by a newer app version would have been opened and written to. It is now refused
   unchanged (`NewerDatabaseError`).
3. **Fixed:** deleted rows stayed readable in free database pages. `PRAGMA secure_delete` is now on (reduces, does
   not guarantee).
4. **Fixed:** a link to a deleted or unrestored code proposal showed "Loading…" forever. It now explains.
5. **Added:**
   - a proposal retention control;
   - storage reporting;
   - cleanup of rebuildable data, temporary files and incomplete downloads;
   - a database check (`quick_check` plus orphans; reports only, removal is explicit);
   - optional release signing from properties outside the repository;
   - `npm run release-check`.
6. **Kept, documented:**
   - release builds use the debug key unless configured;
   - metrics in logcat (labels only);
   - JS password strings can't be wiped;
   - no app lock.

## M9: native cryptography review and verification

**Review of the exact construction.**
- **Nonce:** chunk *i* uses the 8 random header bytes followed by *i* as 4 bytes big-endian (`nonceFor`). The writer
  refuses more than 4,096 chunks, so the counter can never wrap or repeat under one key. The key itself is new for
  every backup, because every backup gets a fresh 16-byte `SecureRandom` salt.
- **Associated data:** both header lines, then *i*, then the last-chunk flag. Changing the header, chunk order or
  the end of the file is detected, which the Kotlin tests confirm on the JVM and on Android.
- **Checks before work:** header fields and limits are checked before key derivation, in TypeScript and again
  natively.
- **Tags:** verified before any plaintext is returned.
- **Keys and errors:** keys are 256-bit; errors never include input data.

No cryptographic flaw was found, so the backup format is unchanged: `LOCALAI-BACKUP/1`, and existing backups read as
before.

**Fixed in M9:**
1. **Restore reported "finished only partly" when a chosen category had no records.** The emulator end-to-end test
   found it; it is now reported as done. A replace of an empty category still removes the current data, but only
   with the confirmation. A regression test covers this.
2. **The native password copy was not wiped.** The `char[]` copy of the password and the decrypted byte buffer are
   now overwritten after use. Java and JavaScript strings still can't be wiped.
3. **The restore screen kept a password after a failed attempt.** Both backup and restore passwords are now cleared
   after every attempt.
4. **`forget()` could run before pending calls finished.** It is now queued behind pending native calls, so a key
   can't vanish under a running operation.
5. **Backup creation ran PBKDF2 twice.** It now derives once (about 2–4 s on the emulator). The finished file is
   still fully authenticated, and its header must be byte-identical to the one the key was derived for.
6. **Invalid UTF-8 after authentication** is now rejected instead of silently replaced.
7. **The crypto was not testable apart from React Native.** It moved into `BackupCrypto.kt` (no Android or React
   Native types), which the module, the JVM tests and the device tests all use. There is one implementation.

**Still open:**
- Not verified on a physical phone.
- The release APK is debug-signed; `apksigner` reports `CN=Android Debug`.
- Weak-password guessing is limited only by PBKDF2.
- There is no app lock.
