# Encrypted backup and restore (M8)

**Data → Backup and restore.** Backups are made on the phone, encrypted with your password, and saved wherever you
choose in Android's file picker. The app never uploads a backup. If you save one to a cloud folder, the file is
encrypted before it leaves the app.

Status (M9): the production Kotlin cryptography has been run on the laptop JVM and on an Android 17 emulator. The
release app made and restored a backup end to end on that emulator. It has **not been run on a physical phone** yet;
see "Test evidence" at the end.

## What a backup can contain

You choose the categories. A category that another one needs is added automatically: Document text needs the
Document list.

| Category | Tables | Default | Notes |
|---|---|---|---|
| Settings | `meta`: `semantic_enabled`, `proposal_retention_days` | on | Only these two keys. |
| Chats | `conversations`, `messages` | on | |
| Memories | `memories`, `learned` | on | |
| Document list | `documents` | on | Names, sources and status; no text. |
| Document text | `chunks` | off | Extracted passages. Can be large and private. |
| Agents | `agents` | on | |
| Skills and workflows | `skills`, `workflows` (not built-in) | on | Built-in examples are never included. |
| Agent, skill and workflow history | `agent_runs`, `agent_steps` | off | |
| Code workspaces | `code_workspaces` | on | Names and URIs only; see restore. |
| Coding tasks | `code_tasks`, `code_turns` | off | Questions, answers, inspected line ranges. |
| Code proposals | `code_proposals`, `code_proposal_files` | off | **Contains source code**, which may hold secrets the app could not recognize. Shown with a warning. |

**Never included:**

| Item | Why |
|---|---|
| On-device models | Downloaded again and verified by SHA-256. |
| Meaning-search vectors and the keyword index | Rebuilt after a restore. |
| Workspace file listings | Listed again once you pick the folder again. |
| Android storage grants | The OS can't transfer them. |
| Temporary files, logs, the restore journal | Not user data. |
| Passwords and keys | The app never stores them. |

## Format (version 1)

A text file, written and read line by line:

```
LOCALAI-BACKUP/1
{"format":1,"cipher":"AES-256-GCM","kdf":{"name":"PBKDF2-HMAC-SHA256","iterations":600000,"salt":"<32 hex>"},"nonce":"<16 hex>"}
<base64 of chunk 0: AES-256-GCM ciphertext ‖ 128-bit tag>
<base64 of chunk 1>
…
```

- **Key:** PBKDF2-HMAC-SHA256 of the password with a fresh 16-byte random salt per backup gives a 256-bit key. The
  default is 600,000 iterations, OWASP's 2023 recommendation. Files are accepted only with 200,000–2,000,000
  iterations.
- **Nonces:** the header holds an 8-byte random prefix. Chunk *i* uses the prefix followed by *i* as 4 bytes
  big-endian, which gives 96 bits that never repeat under one key. The key is also new for every backup, because the
  salt is.
- **Authenticated data:** each chunk's associated data is both header lines, plus *i*, plus whether it is the last
  chunk. Editing the header, reordering, dropping, duplicating or appending chunks, or cutting the file short all fail
  authentication.
- **Plaintext:** JSON lines, at most 256,000 characters per chunk. In order:
  1. a manifest: `payloadVersion` (1), `appSchema` (the database schema of the app that made it), creation time,
     categories with record counts, excluded items;
  2. `{"type":"row","cat","table","row"}` records, category by category;
  3. an `end` record with the total record count.
- **No** compression, file names or paths. Nothing in a backup is executed or written to the file system as a file.
- **Primitives:** platform `javax.crypto`, in `BackupCrypto.kt`. `AiCryptoModule.kt` only adapts it to React
  Native, so the tests and the app run the same class. Derived keys stay in native code behind opaque handles and are
  overwritten after use. The container itself is defined in `src/backup/format.ts`.
- **JavaScript ↔ native interface** (`src/backup/crypto.ts` → `AiCrypto`): every call runs in order on one native
  worker thread and returns a Promise. Errors arrive as `{code, message}`; messages never contain input data.

  | Method | Arguments | Result | Errors |
  |---|---|---|---|
  | `randomHex(n)` | Int, 1–64 | n `SecureRandom` bytes as lowercase hex | — |
  | `deriveKey(password, saltHex, iterations)` | String, hex String, Int | An opaque key handle (hex) | `invalid` for parameters outside 100,000–10,000,000 iterations or a salt that isn't 16–64 bytes of lowercase hex; nothing is derived |
  | `seal(handle, nonceHex, aad, plaintext)` | 12-byte nonce in hex; both Strings encoded as UTF-8 | `base64(ciphertext ‖ 16-byte tag)` (standard alphabet, no line breaks) | — |
  | `open(handle, nonceHex, aad, sealed)` | As for `seal` | The plaintext, only after the tag verifies | `auth_failed` for a wrong key, nonce, AAD, tag or ciphertext, bad base64, or invalid UTF-8 |
  | `forget(handle)` | String | Overwrites and drops the key, queued after pending calls | — |

  - The key is PBKDF2-HMAC-SHA256 of the password (the provider encodes it as UTF-8) and the salt, giving a 256-bit
    key. The password's char copy is overwritten after use.
  - Any call fails with `unsupported` below Android 8.0 (API 26), and with `failed` for an unknown handle.
- **Android version:** Android 8.0 or newer (`PBKDF2WithHmacSHA256`). Older versions refuse. There is never an
  unencrypted fallback.
- **Versioning:** the backup format (`LOCALAI-BACKUP/1`), the payload version, and the database schema are separate
  numbers. Payload migrations go in `MIGRATE` in `src/backup/payload.ts`; none are needed yet. A backup from an older
  app may lack newer columns, and their defaults are filled in. A backup from a newer app (`appSchema` greater than
  this app's) is refused before anything changes. The live database is never downgraded.

**Limits** (anything outside them is refused):

| Limit | Value |
|---|---|
| File | 512 MB |
| Header | 1,024 characters |
| Chunk line | 1.5 M characters |
| Chunks | 4,096 |
| Records | 500,000 |
| Per category, in one transaction | 60,000 records or 48 M characters |
| Per column | Fixed maximum length and type (`src/backup/categories.ts`) |

## Making a backup

1. **Choose categories.** The screen shows what each one holds, the record counts, what is never included, and an
   estimated size, labelled as an estimate.
2. **Enter the password twice.** At least 10 characters, and both entries must match. **If you lose the password,
   the backup can't be opened by anyone, including you.**
3. **The app checks free space** for about 1.5 times the estimate plus 50 MB, and refuses if there isn't enough.
4. **The app writes the backup** to `cache/backup/b-*.part` one chunk at a time, so only one chunk of plaintext is in
   memory.
5. **The finished file is read back** with the password: every chunk must authenticate, and the record count must
   match.
6. **You choose where to save it.** The app creates a new file and copies the backup into it; an existing file is
   never overwritten. It then reads the copy back and compares SHA-256 with the original. If the copy differs or the
   write fails, the new file is removed and the backup is reported as **not saved**.
7. **The temporary file is deleted.**

Cancelling, low storage, a full disk during writing, or a picker failure all delete the temporary file, so nothing
is ever presented as a finished backup. Abandoned temporary files older than an hour are removed at launch, and
**Data → Remove temporary files** removes them on demand. Files that are in use are never removed.

## Restoring

1. **Choose the backup file.** It is copied into private storage (`cache/backup/r-*.bak`). The original is only read.
2. **Enter the password → Check.** The app checks the header strictly, derives the key, then decrypts and
   authenticates **every chunk** and validates every record. It also compares each category with the data now on the
   phone, and **changes nothing**. A wrong password, a tampered or truncated file, or a malformed or unsupported
   payload stops at this step.
3. **Read the plan.** For each category: new / already here / conflicts / invalid / skipped, any notes (for example
   "workspaces need their folder picked again"), and errors. A category with duplicate records, or one too large for
   a single transaction, is not offered.
4. **Choose categories and modes, then Restore.** Each chosen category is applied in **one SQLite transaction**: all
   of it or none of it. The backup is authenticated again while it is read. Document text is added one document per
   transaction afterwards, and the keyword index is updated with it.
5. **Read the result.** It shows each category's outcome, SQLite's `quick_check` after the restore, and notes. A
   category that failed is shown as failed and its data is unchanged. A restore where only some categories succeeded
   is reported as **partial**, never "done".

The key is wiped and the private copy deleted when you leave the screen.

### Modes and conflict rules

**Merge** (the default) never changes what is already on the phone:

| Category | Rule |
|---|---|
| Chats | A conversation is "already here" if all its messages are. If the same id holds other content, that is a conflict: keep the current one, or, if you choose, add the backup's as a copy titled "… (restored)" with new ids. |
| Memories | Matched by type + scope + key. The same value is a duplicate. A different value keeps the current memory. |
| Learned facts | Added. If a current value exists for the same kind + key, the backup's is added as inactive history. |
| Documents | Already present (same id or same file) means kept. New ones are added; without their text they are marked "restored without text, import again". |
| Agents | A different id with identical content (such as the default agents) is a duplicate. The same id with different content is a conflict: keep, or add a copy. Copies and name clashes are renamed "(restored)". Every agent is validated again (`validateAgent`) and invalid ones are skipped. |
| Skills and workflows | The same id with a different definition is a conflict: keep, or add a copy as `…-restored`. Each is validated again (`validateSkill` / `validateWorkflow`), and invalid ones (for example an unknown tool) are skipped with the reason. |
| Run history | Runs that already exist are skipped. |
| Workspaces | Already present (same id or same folder) means kept. New ones start unlisted. **Android does not restore folder access**: pick the folder again under Code. |
| Coding tasks and proposals | Restored only if their workspace exists. A restored *ready* proposal becomes **stale** (review only), so it can never be applied over files that may have changed. |
| Settings | Only keys not set on the phone are added. |

**Replace** deletes the category's current data and inserts the backup's in the same transaction. It needs an
explicit confirmation that names what will be deleted. It is not offered for workspaces, because tasks and proposals
belong to them and folder access can't be restored. Built-in skills are never touched. There is **no "replace
everything"**: that would need restoring Android grants and models, which the app can't do.

### Interrupted restores

Before applying, a row is added to `restore_journal`. It holds the categories, modes and the backup's creation time,
and each category's outcome is recorded as soon as it is known. It never holds the password or any content. If the
app closes during a restore:
- the next launch marks the row **interrupted**;
- **Data** shows which categories finished;
- documents left half-indexed are marked failed and can be retried, using the existing M3 recovery.

Nothing is redone automatically. To finish, restore the remaining categories again with **Merge**: records that are
already restored are recognized as duplicates. Startup recovery is idempotent.

## Test evidence (M9)

What each kind of test proves, and on which cryptography it ran:

| Tests | Cryptography used | Environment | What it proves |
|---|---|---|---|
| Jest `backup`, `restore`, `storage`, `dataApp` (35 tests) | **Node's crypto** behind the AiCrypto interface (`testUtils/fakeBackupEnv.ts`) | Laptop | The TypeScript format, limits, restore rules, journal and screens. It does **not** prove the Android module works. |
| Jest `cryptoVectors`: stored vectors | Production `format.ts` + Node/OpenSSL | Laptop | Writes the shared vectors and container (`android/app/src/test/resources/backup/`, test-only fixed salt and nonce) and fails if they change. |
| Jest `cryptoVectors`: emulator-made backup | Node/OpenSSL reading a file **written by Kotlin on Android** | Laptop | A backup produced by the release app on the emulator (`__tests__/fixtures/android-emulator-backup-v1.txt`) decrypts with the TypeScript reader. A wrong password fails. |
| `BackupCryptoJvmTest` (11) | **Production `BackupCrypto.kt`**, JDK provider | Laptop, Temurin JDK 17 (`gradlew :app:testDebugUnitTest --offline`) | Details below. |
| `BackupCryptoDeviceTest` (11) | **Production `BackupCrypto.kt`**, Android's provider | Emulator: Android 17 (API 37), x86_64, Google APIs Play Store 16K-page image | The same checks as the JVM tests. |
| `AiCryptoModuleDeviceTest` (3) | **Production `AiCryptoModule`** | Same emulator | The @ReactMethod entry points with bridge argument types, Promise results and error codes, the worker thread, and key release. Also measures timings. |
| `scripts/emulator-backup-e2e.mjs` (11 steps) | Release APK: bundled JS + React Native bridge + Kotlin | Same emulator | Backup through the real UI and Android's save picker. Then, in a cleared app, a wrong password is refused and a merge restore with the right one brings the data back. |

The JVM and emulator runs of `BackupCryptoChecks` show that the production Kotlin code:
- matches the RFC 7914 PBKDF2-HMAC-SHA256 vectors;
- matches Node/OpenSSL byte for byte, with a Unicode password (Telugu, emoji) at 200,000 and 600,000 iterations, and with AES-GCM ciphertexts;
- decrypts the TypeScript-written container chunk by chunk, including an empty chunk;
- rejects a changed ciphertext, tag, authenticated header, nonce (chunk position) or "last chunk" flag, and a wrong password;
- rejects reordered, removed, appended or truncated chunks;
- round-trips the empty chunk and the maximum-size chunk (ASCII and multi-byte);
- refuses unsafe KDF parameters before deriving anything;
- rejects malformed input (bad base64, input shorter than a tag, wrong nonce length, unknown key);
- gives fresh random values, and makes forgotten keys unusable.

**Not tested on a physical phone.** The Galaxy M35 was connected but deliberately not used: running these tests installs a debug build over the app and clears or changes its data. See the device checks in the README.

### Measurements

These come from the emulator and the laptop, **not** the Galaxy M35:

| Measurement | Environment | Result |
|---|---|---|
| PBKDF2-HMAC-SHA256, 600,000 iterations | Emulator (Android 17, x86_64 on an i7-13650HX host), Android provider | 2.2 s and 4.3 s in two runs |
| PBKDF2-HMAC-SHA256, 600,000 iterations | Laptop, Node/OpenSSL | about 70 ms |
| AES-256-GCM, 10 MiB in 256 KiB chunks | Emulator | Seal 19.1 MiB/s, open 38.1 MiB/s |
| Backup, from "Create" to the save picker | Emulator, small backup: one PBKDF2 + writing + verification | 5.2–5.9 s |
| Restore "Check backup", wrong or right password | Emulator: one PBKDF2 + authenticating every chunk | 4.7–4.8 s |

Peak memory was not measured. By design, at most one chunk (256 K characters) of plaintext is held while writing or reading, plus one category's rows during restore (limited to 60,000 records or 48 M characters). Temporary storage is about 1.4 × the plaintext size for the backup, plus the private copy of a backup during restore.
