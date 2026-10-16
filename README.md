# Local AI

A local-first Android AI assistant: chat with an on-device language model under 4B parameters, with no laptop,
server or internet needed once the model is downloaded. The reference proof of concept is
[subbu5280/AI-ChatBot](https://github.com/subbu5280/AI-ChatBot); this is a separate project that reuses its verified
pieces. The reference repository is never modified.

**Status: M10, final release preparation (conditionally ready; see docs/release.md).** Offline chat, six-language
handling, a local document library with keyword and optional meaning search, sourced answers, local agents, skills and
workflows, a coding assistant whose changes are applied only after your approval, and password-encrypted backup and
restore. Chat was verified on the Galaxy M35 (M2.4). The backup cryptography and the backup/restore flow were run on
the laptop JVM and on an Android 17 emulator (M9). Nothing newer than M2.4 has been verified **on a phone** yet (see
"Device-only checks" at the end).

## What it does

- **Chat on the phone only.** Answers come from Qwen2.5-1.5B-Instruct (Q4_K_M, Apache-2.0, 1.1 GB) via llama.rn.
  The model is downloaded once, only after you confirm, and checked against its sha256 before use.
- **Saved conversations.** Messages are stored in the phone's private SQLite database; the latest chat reopens on launch.
  **History** lists saved chats (newest first, with date); open one to continue it, or delete it after confirming.
- **Offline-safe model download.** Before downloading, the app checks the connection with Android's
  ConnectivityManager: offline, it explains and downloads nothing. Chat and history never need the network.
- **Language-aware answers.** Each message's language is detected on the phone, and the model is told which
  language to answer in. A short reply like "ok" keeps the chat's language.
- **Intent-aware prompts.** Keyword rules recognize greetings, translation, summaries, coding, questions that need
  current information, explanations and other questions, plus a simple/medium/complex estimate. They only add a
  one-line hint where a small model tends to go wrong (e.g. "reply with the translation only", "you have no internet");
  the user's text is passed on unchanged. These are pattern rules, not language understanding.
- **Stop.** A running answer can be stopped; the partial answer is kept.
- **Documents.** Import files, search them, and ask questions answered from their passages (see below).
- **Agents.** Run tasks as a short plan of checked tool steps: document search and answers, summaries, exact
  arithmetic, the date, and saving a text file you place (see below).
- **Code.** Pick a project folder; ask about it, debug errors, review code, and review and approve proposed changes
  (see below and [docs/coding-assistant.md](docs/coding-assistant.md)).
- **Data.** Encrypted backup and restore of the categories you choose, storage usage, cleanup, proposal retention, a
  database check, and what stays on the phone (see below and [docs/backup-and-restore.md](docs/backup-and-restore.md)).

## Project layout

| Path | What | Origin |
|---|---|---|
| `App.tsx` | Chat screen: model status, download, send/stop, history restore | New |
| `src/core/language.ts` | Language detection and the model's language instruction | Ported from the POC's `backend/app/language.py`; Malayalam added |
| `src/core/intent.ts` | Intent and complexity rules, with the deciding words | Adapted from the POC's `backend/app/context.py` |
| `src/core/prompt.ts` | Builds the model's prompt: language line + task line + the user's text | New |
| `src/HistoryScreen.tsx` | Saved-chat list: open, delete with confirmation, empty/error states | New |
| `src/device.ts`, `android/.../AiDeviceModule.kt` | Network state before a download; screen kept on while downloading | New |
| `src/knowledge/text.ts` | Supported formats, size limits, normalization, Markdown and CSV to text | New |
| `src/knowledge/chunker.ts` | Passages of ~220 tokens with ~40-token overlap, never crossing PDF pages | New |
| `src/knowledge/tokens.ts` | Search tokens (Latin + Indian scripts), stop words | New |
| `src/knowledge/docStore.ts` | `documents` / `chunks` tables, FTS5-or-FTS4 index, transactional replace and delete | New |
| `src/knowledge/indexer.ts` | Import pipeline: checks, extraction, duplicates, one import at a time, retry, remove | New |
| `src/knowledge/retrieve.ts` | Safe query parsing, FTS candidates, BM25 ranking, excerpts | New |
| `src/knowledge/knowledgePrompt.ts` | Passage budget, fenced sources, citations, no-evidence reply | New |
| `src/KnowledgeScreen.tsx`, `src/DocumentScreen.tsx` | Library, import, search, scope choice; document details and passages | New |
| `android/.../AiDocsModule.kt` | System file picker and save picker, text decoding, SHA-256, PDF text per page | New |
| `src/agents/types.ts` | Tool, plan, run and agent types; input-schema validator; limit bounds | New |
| `src/agents/tools.ts` | The built-in tool registry (7 tools) | New |
| `src/agents/calculator.ts` | Arithmetic parser (no eval) | New |
| `src/agents/policy.ts` | Plan and agent validation, permissions, confirmation rule | New |
| `src/agents/planner.ts` | Model plan (JSON-schema constrained) or the app's default plan | New |
| `src/agents/engine.ts` | Sequential execution: checks, retries, timeouts, cancel, confirmation | New |
| `src/agents/agentStore.ts` | Agents and run history in SQLite (schema v5), interrupted-run recovery | New |
| `src/AgentsScreen.tsx`, `src/AgentEditScreen.tsx`, `src/AgentRunScreen.tsx` | Agent list, editor, task runner | New |
| `src/knowledge/embeddings.ts` | Embedding model record, vectors in SQLite (schema v6), batched build, cosine search, llama.rn embedder | New (M5) |
| `src/knowledge/hybrid.ts` | Keyword + meaning retrieval (reciprocal rank fusion), honest mode, evidence list | New (M5) |
| `src/knowledge/semantic.ts` | Meaning search on/off, opt-in download, background build, removal | New (M5) |
| `src/eval/metrics.ts`, `src/eval/answerEval.ts`, `src/EvalScreen.tsx` | Evaluation metrics, on-phone answer checks, developer screen | New (M5) |
| `eval/` | Datasets, evaluation runs, results and methodology (eval/README.md) | New (M5) |
| `src/skills/format.ts` | Skill/workflow JSON formats, strict validation, compilation to engine steps | New (M6) |
| `src/skills/skillStore.ts`, `src/skills/builtins.ts` | Storage (schema v7), built-in examples, import/export, duplicate | New (M6) |
| `src/skills/runner.ts`, `src/skills/draft.ts` | Run preparation through the agent policy; drafts from a description | New (M6) |
| `src/LibraryPanels.tsx`, `src/DefinitionEditScreen.tsx`, `src/DefinitionRunScreen.tsx`, `src/DraftScreen.tsx` | Skills/workflows lists, editor, runner, drafting | New (M6) |
| `docs/skills-and-workflows.md` | Formats, validation, running, privacy, deferred features | New (M6) |
| `android/.../AiWorkspaceModule.kt` | Folder/file picker with kept grants, folder listing, hash-checked write with read-back, create-only; no delete | New (M7) |
| `src/code/native.ts`, `paths.ts`, `files.ts` | Workspace bindings, path normalization, file types, limits, binary detection, secret redaction | New (M7) |
| `src/code/workspaceStore.ts`, `search.ts` | Workspaces (schema v8), listing, bounded reads, name/content search, trace matching, context selection | New (M7) |
| `src/code/assistant.ts`, `proposals.ts`, `diff.ts` | Questions/debug/review with checked references; proposal validation and storage; line diff | New (M7) |
| `src/code/apply.ts` | The only code that writes project files: approval, revalidation, stale checks, per-file outcome, restore | New (M7) |
| `src/CodeScreen.tsx`, `WorkspaceScreen.tsx`, `CodeFileScreen.tsx`, `CodeTaskScreen.tsx`, `ProposalScreen.tsx` | Coding assistant screens | New (M7) |
| `docs/coding-assistant.md` | Workspaces, limits, context, review, proposals, approval, recovery, security, limitations | New (M7) |
| `android/.../AiCryptoModule.kt` | PBKDF2-HMAC-SHA256, AES-256-GCM, SecureRandom from javax.crypto; keys stay native | New (M8) |
| `android/.../BackupCrypto.kt` | The crypto itself (no Android/RN types), used by AiCryptoModule and by the native tests | New (M9) |
| `android/app/src/{sharedTest,test,androidTest}/` | Kotlin tests of the production crypto on the JVM and on a device/emulator; shared vectors | New (M9) |
| `scripts/emulator-backup-e2e.mjs` | Release app backup → wrong password → restore through the real UI on an emulator | New (M9) |
| `src/backup/format.ts`, `crypto.ts` | Versioned encrypted container (header, nonces, authenticated chunks, limits); crypto binding | New (M8) |
| `src/backup/categories.ts`, `backup.ts` | Backup categories and strict row schemas; streamed, verified backup creation | New (M8) |
| `src/backup/payload.ts`, `merge.ts`, `restore.ts` | Payload reading and validation; merge/replace rules; staged restore with journal (schema v9) | New (M8) |
| `src/storage.ts` | Storage report, cleanup actions, proposal retention, database check | New (M8) |
| `src/DataScreen.tsx`, `src/BackupScreen.tsx` | Privacy and data; backup and restore | New (M8) |
| `scripts/release-check.mjs` | Typecheck, lint, tests, manifest, secret and dangerous-API checks, optional release build | New (M8) |
| `docs/backup-and-restore.md`, `docs/security.md`, `docs/release.md` | Backup format and workflows; audit and threat model; build and signing | New (M8) |
| `src/chatStore.ts` | Conversations, messages, memory tables, bounded context window, transactional delete | POC, laptop link removed; `deleteConversation` added |
| `src/localModel.ts` | Model download/verify, load, generate, stop (one llama.rn call at a time) | POC, `stop()` added |
| `src/modelManager.ts`, `src/modelCatalog.json` | Model catalog and device-fit rules | POC, unchanged |
| `android/.../AiStoreModule.kt` | Native bridge to Android's built-in SQLite | POC, unchanged |

## Setup

Requirements: Node.js 22.11+, JDK 17, Android SDK (compileSdk 37, NDK 27.1).

```sh
npm install
```

On Windows, run `npm install` from PowerShell or cmd, not Git Bash: llama.rn's install script calls `tar`, and Git
Bash's GNU tar misreads `C:\...` paths.

## Run

```sh
npm test                 # Jest: everything below
npx jest __tests__/knowledge   # documents only: text, index/search on FTS5 and FTS4, app flows
npx jest __tests__/agents      # agents only: tools, calculator, policy, planner, engine, history, screens
npx jest __tests__/m5          # M5: language rules, normalization, evidence, duplicates, vectors, hybrid, eval checks
npx jest __tests__/skills      # M6: formats, hostile imports, storage, compile, permissions, runs, drafts, migration, screens
npx jest __tests__/code        # M7: workspaces, inspection, redaction, context, answers, proposals, approval, recovery, boundary, screens
npx jest __tests__/backup __tests__/restore __tests__/storage __tests__/dataApp   # M8: encryption, tampering, restore modes, recovery, cleanup, integrity, security
npm run release-check          # all of the above + manifest, secret and dangerous-API checks (-- --build adds the APK)
(cd android && ./gradlew :app:testDebugUnitTest --offline)   # M9: the production Kotlin crypto (BackupCrypto) on the JVM
node scripts/release-check.mjs --build --emulator emulator-5554 --reference ../AI-ChatBot   # M9: full qualification incl. emulator
npm run eval                   # six-language evaluation (language + retrieval) -> eval/results/
powershell -ExecutionPolicy Bypass -File scripts\eval-embeddings.ps1   # retrieval with the real embedding model
npm run typecheck        # TypeScript
npm start                # Metro bundler
npm run android          # build and install the debug app on a connected device or emulator
```

The debug build (`android/gradlew assembleDebug`) targets arm64-v8a (phones) and x86_64 (emulator) only, because
llama.rn ships native libraries only for those.

## Usage

1. Open the app and tap **Get model** (use Wi-Fi: about 1.1 GB, once).
2. When the status shows **On-device · offline ready**, type a message in any of the six languages and tap **Send**.
3. Tap **Stop** to end a long answer, **New chat** to start a fresh conversation, **History** to reopen or delete a saved chat.

```ts
import { detect, instruction } from './src/core/language';

const lang = detect('Kafka గురించి చెప్పండి');  // { code: 'te', source: 'script', bcp47: 'te-IN', ... }
instruction(lang);                               // "Language: Respond in Telugu written in Telugu script. ..."
detect('ok', lang.code).code;                    // 'te': a short reply keeps the chat's language
```

## Device verification (Galaxy M35 or any arm64 phone)

`scripts/device-check.ps1` runs a grouped check from the laptop over ADB and writes evidence to
`verification/runs/<timestamp>/` (git-ignored: screen dumps contain chat text). Run it from PowerShell with the phone
connected (USB debugging on):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\device-check.ps1            # build, install, launch, model, memory, logs
powershell -ExecutionPolicy Bypass -File scripts\device-check.ps1 -DriveUi   # + History/Back, 3 timed prompts, Stop
powershell -ExecutionPolicy Bypass -File scripts\device-check.ps1 -DriveUi -AirplaneTest  # + offline chat (asks first)
```

It installs the release APK as an upgrade (`adb install -r`; chats and the model are kept), never uninstalls or clears
data, never downloads the model itself (if it is missing, you tap **Get model** on the phone), and changes airplane mode
only after you type YES, restoring it afterwards. Timings come from the app's `LOCALAI_METRIC` log lines
(`src/metrics.ts`: numbers and labels only, never message text). `summary.md` marks each check PASS / FAIL / NOT RUN /
MANUAL; MANUAL checks (Indian-language prompts, answer quality, keyboard layout) need a person.

## Documents (local knowledge)

**Supported formats**

| Format | How text is read | Limit |
|---|---|---|
| TXT | UTF-8 (UTF-16 with a byte-order mark); invalid bytes shown as � with a warning | 10 MB |
| Markdown | as text, with link/image/emphasis syntax removed | 10 MB |
| CSV | one line per row, each value labelled with its column ("Row 3: name: Asha; city: Pune") | 10 MB |
| PDF | Android's own PDF renderer, page by page (Android 15+, or Android 12–14 with recent system updates) | 50 MB |

At most 2,000,000 characters of text and 4,000 passages per document. Scanned PDFs (pages with no selectable text)
are reported, not guessed: a fully scanned PDF fails with "no selectable text … OCR isn't supported yet"; a partly
scanned one is indexed with a warning naming how many pages had no text. Password-protected and damaged PDFs fail with
their own message. Other formats (DOCX, XLSX, images) are refused at import.

**Import and search.** Docs → Import opens Android's file picker (several files at once; no storage permission: the
picker grants access to each chosen file only). Each file shows its result: indexed, unchanged, duplicate (same bytes
already imported from elsewhere), or failed with the reason. Picking the same file again re-indexes it only if it
changed. Typing in the search box shows ranked passages with the file name, page or passage number and a highlighted
excerpt; tapping one opens that passage, with Previous / Next. Search never uses the model, works offline, and accepts
any text: "quoted phrases" and prefix* words work, and characters like `( ) : - AND OR` are simply ignored.

**How ranking works.** Text is split into lowercase word tokens (Latin and Indian scripts, plural "s" removed, English
stop words removed from queries) and stored in SQLite's full-text index: FTS5 if the phone's SQLite has it, otherwise
FTS4 (always present on Android). The Documents screen shows which one is used; if neither exists, it says search is
unavailable. The index finds candidate passages; they are ranked by BM25 multiplied by how many of the query's words a
passage contains, so results are identical on FTS5 and FTS4. There are no embeddings yet; `retrieve.ts` has a
`Retriever` interface so a semantic retriever can be added later without changing the library.

**Asking questions about documents.** Turn on **Docs** next to the message box (or "Ask questions about all
documents", or "Ask about this document" on a document). The bar above the input shows the scope; **Change** picks
documents. In Docs mode the app retrieves the best passages (at most 4, about 900 tokens in total), and the model gets
your question unchanged, the language line, and the passages inside a clearly marked sources block, with the rule to
answer only from them and cite them like [1]. The sources shown under the answer come from retrieval, not from the
model; only citation numbers that really exist are listed (if the model cites none, all the given passages are listed
and labelled as such). Each question is answered on its own (earlier chat turns are left out to leave room for the
passages). Turn Docs off for ordinary chat, which works exactly as before.

**When nothing relevant is found** the app answers itself: "I couldn't find anything about this in your documents …"
— the model is not asked, so nothing is made up.

**Documents are data, never instructions.** Document text is never put in the system message, the sources block's
markers are removed from document text (a file can't close the block and add its own instructions), the model is told
to ignore instructions inside sources, and the app gives the model no tools, so a document can never trigger an
action. A small model can still be swayed by text in a source; the answer is shown with its sources so it can be
checked.

**Storage and deletion.** Extracted text, passages and the index live only in the app's private SQLite database on
the phone; nothing is uploaded and metrics never contain file names or text. Remove (on a document) asks first, then
deletes the document, its passages and its index entries in one transaction and gives up the app's access to the
file. **The original file is never changed or deleted.** Chats and the downloaded model are not affected. An import
interrupted by the app closing is marked failed at the next launch and can be retried.

## Agents (bounded local tasks)

An agent is a name, a purpose, a set of enabled tools and limits. Three are created on first use (Document assistant,
Calculator and clock, Notes writer); they can be edited, duplicated, disabled or deleted, and new ones created
(**Agents** in the header). Agents and their run history are stored only in the phone's database.

**Tools.** Each tool is fixed app code with an id, a version, a typed input, a permission, a risk level and a time
limit. There is no shell, no code execution, no network tool, and no tool can read the app's own files, chats or the model.

| Tool | Does | Risk |
|---|---|---|
| `calculator` v1 | Exact arithmetic with a parser (no `eval`): + − × ÷ ^, %, "x% of y", mod, sqrt, round, min, max, ln, log | none |
| `datetime` v1 | Date, weekday, time and UTC offset from the phone's clock | reads the clock |
| `docs.search` v1 | Keyword search in the documents the task may read (M3 search) | reads documents |
| `docs.passages` v1 | Specific passages of one document | reads documents |
| `docs.read` v1 | The beginning of one selected document | reads documents |
| `docs.answer` v1 | Answers from passages of an earlier step, with sources (the M3 Docs-mode prompt) | uses the model |
| `text.summarize` v2 | Summarizes given text or an earlier step's text/passages (fenced as data); passages are numbered and cited, and keep their sources (v2) | uses the model |
| `text.compose` v1 | Writes text about an earlier step's result following a short instruction (M6; the result is fenced as data) | uses the model |
| `code.search` v1 | Lines containing a text in a registered project workspace (M7; secrets redacted) | reads workspaces |
| `code.read` v1 | Up to 80 numbered lines of one workspace file (M7; normalized paths, secret files refused) | reads workspaces |
| `file.export` v2 | Saves an earlier step's text as a **new** .txt/.md file you name and place in Android's save picker; a report ends with its sources (v2) | writes: asks every time |

**How a task runs.**
1. *Plan.* The on-device model proposes steps as JSON; llama.rn constrains its output to a schema listing only the
   agent's enabled tools, so it is always well-formed. The app then validates it like any untrusted input: known and
   enabled tools, inputs matching each tool's schema, `fromStep` pointing only to an earlier step that produces the
   right kind of data, documents inside the task's scope, step count within the agent's limit. If the model is not
   loaded or its plan is rejected, the app uses its own default plan for the kind of task (documents question,
   arithmetic, date, summary). The screen always says which one you see and why.
2. *Approve.* The plan is shown; Run starts it (agents can skip this when they have no write tools to worry about —
   the "Show the plan and wait for Run" setting).
3. *Execute.* Steps run one after another with no re-planning: document text and tool results are passed on as data
   and can never add steps, change tools or permissions. Each step has a result check (e.g. a search must find
   passages, an answer must not be empty), a time limit (stopping generation when exceeded), and at most 0–2 retries
   for recoverable errors. A failed step stops the run and the rest are marked skipped; a run is **Succeeded** only if
   every step succeeded. Cancel (or leaving the screen) stops the running step and starts no other.
4. *Confirm writes.* Before a `file.export` step the app shows exactly what will be saved; "Don't allow" cancels the
   run with nothing written. The save picker always creates a new file; an existing file is never overwritten.
   Imported documents are never modified or deleted by any tool.

**No evidence.** When the document search finds nothing, the run ends as **Not found in documents** with an honest
reply; the model is not asked to answer.

**History.** Every run records the agent (id, name, version), the task, whether the plan came from the model or the
app, and per step: tool id and version, input, status, attempts, timings, a short result summary, warnings and errors.
Stored step results keep answer text and passage references with short excerpts, not whole documents. A run cut off
by the app closing is shown as **Interrupted** at the next launch. Failed, cancelled or interrupted runs can be re-run
(the plan is validated again against the agent as it is now) unless a file was already saved.

**Limits** (per agent, inside app bounds): 1–6 steps, 0–2 retries per step, 5–180 s per step.

## Languages and meaning search (M5)

**Language of answers.** Explicit requests win ("in Tamil", "Tamil la sollu", "kannada alli", "malayalam il",
"తెలుగులో"); then the script, when it is at least a third of the message's words (an English question quoting one
Telugu word stays English); then romanized Telugu, Hindi, Tamil, Kannada or Malayalam (two everyday marker words);
otherwise English, except that short replies ("ok", "👍", "2") keep the conversation's language. Each saved message
keeps its language. The app's own interface stays English whatever the answer language. These are word-list and
script rules, not language understanding: romanized messages without marker words are treated as English.

**Keyword search.** Words in the five Indian languages also match their other forms through a prefix of the query
word (e.g. రైతులకు finds రైతులు); zero-width joiners and the two Malayalam chillu encodings are normalized; question
words and postpositions are ignored in queries; a single shared common word is not counted as evidence; copied
passages are shown once. Documents imported before M5 are re-indexed automatically at the next start.

**Meaning search (optional).** Documents → "Get (132 MB)" downloads multilingual-e5-small (MIT) after confirmation and
a connection check, sha256-checked. Vectors are then built in the background in small batches (Stop keeps finished
batches; the next start continues). Search then combines keyword and meaning results (reciprocal rank fusion); this
finds paraphrases, synonyms and **questions in a different language from the document**. The Documents screen shows
which search is active ("Keyword search · SQLite FTS5" or "… + meaning (n of m passages)"); without the model, or with
it switched off, everything works by keywords alone. Remove deletes the model and its vectors; documents stay.
Measured on the laptop (eval/README.md): relevant document in the top 3 for 100% of answerable test queries (keyword
only: 71%), cross-language 100% (keyword: 0%), no false evidence. Not yet measured on a phone: indexing speed, memory,
battery.

**Evaluation.** See eval/README.md for the datasets, methodology, results and the model-selection record, and run
`device-check.ps1 -DriveUi -Eval` (or Agents → Model evaluation) for model answers in all six languages on the phone.

## Skills and workflows (M6)

Agents → **Skills** / **Workflows** tabs. A skill is a reusable, parameterized sequence of built-in tool calls; a
workflow chains tool calls and skills. Both are validated JSON (format reference, validation rules, running, privacy
and deferred features: [docs/skills-and-workflows.md](docs/skills-and-workflows.md)).

- **Built-in examples:** skills *Summarize documents on a topic*, *Compare documents on a topic*, *Summarize a text*,
  *Calculate and explain*; workflows *Research report to a file*, *Study notes from documents*, *Calculation with
  explanation*. They use only registered tools; they can be switched off or duplicated.
- **Create / edit:** New opens a form: id (fixed), name/description/instructions in any of the six languages, typed
  inputs, steps from tools (fields from each tool's schema; `{{input}}` or `$input` values; "uses result of step n")
  or skills (workflows), reorder (references follow) and remove, limits. Required tools and permissions are derived
  from the steps and shown; Save is possible only when the definition is valid. Test runs it on a sample input.
- **Import / export:** Import accepts pasted JSON or a picked .json file, shows its validation result and the tools and
  permissions it needs, and saves only on confirmation (an existing id can be replaced or imported as a copy). Export
  shares the JSON or saves it as a new file.
- **Run:** inputs, answer language (Auto or one of six), Run. Progress per step, Cancel, permission prompts before
  saving files, result with document sources, Re-run when safe, past runs (deletable per skill/workflow).
- **Describe one:** the on-device model drafts a workflow from a sentence; the app validates it and explains anything
  unsupported; it is saved only if you choose.

Boundaries: definitions contain no code and can only use registered tools with their own validated inputs; a
definition's run may use exactly the tools it declares (a principal checked by the existing agent policy), within app
limits; file-creating steps always ask; document text and imported instructions are treated as data. Not in M6:
branching, loops, parallel steps, scheduling, remote catalogues, MCP.

## Coding assistant (M7)

**Code** (chat header) → **Add folder** or **Add files**. Android's picker grants the app access to exactly what you
pick (no storage permission, no file paths). The assistant reads bounded excerpts on the phone; source code is never
uploaded and nothing is compiled, run or executed. Full reference: [docs/coding-assistant.md](docs/coding-assistant.md).

- **Workspace:** browse folders, search file names or contents, select files, Refresh (cancellable). Dependency and
  output folders (`node_modules`, `build`, `.git`, …), binary files, files over 200 KB and secret files (`.env`, keys,
  keystores, …) are not read. Recognizable secrets are redacted before the model sees text: a best-effort pattern
  match, not a guarantee.
- **Tasks:** Ask, Debug (paste an error or stack trace), Review, or Propose change, in Auto or one of six answer
  languages (code and identifiers are never translated). The app picks a few relevant excerpts (selected files, files
  named in the trace, name and content matches) within ~1,000 tokens and lists exactly which lines it inspected.
  Findings are labelled observed / inferred / hypothesis with file:line links; references to files or lines the model
  wasn't shown are removed and the finding downgraded. Review and Debug add deterministic pattern checks (eval,
  HTML injection, shell exec, SQL from strings, empty catch, …), marked "worth checking, not confirmed". With no
  relevant files the app says so without asking the model.
- **Proposals:** modify (unique find/replace edits or full content) or create files; validated before you see them
  (path traversal and encoded paths, out-of-workspace or secret targets, unsupported operations such as delete or
  rename, ambiguous or overlapping edits, conflicts, size and count limits). Review shows a diff per file with
  Accept/Reject.
- **Apply:** only after you confirm. Every change is re-validated and every file re-read first; if any file changed
  since the proposal, nothing is written (stale). Files are written one at a time with a hash check right before the
  write and a read-back after it; each outcome is recorded; a failure partway is reported as **partial** with the exact
  applied / failed / not-applied files. **Restore original** writes the saved original back only while the file still
  holds the applied text. The app never deletes or renames project files, and doesn't claim atomic multi-file writes.
- **Boundaries:** agent tools `code.search` / `code.read` are read-only; no tool, agent, skill or workflow can write a
  project file (enforced by structure and tests). No shell, subprocess, `eval` or script execution exists.
- **Removing a workspace** deletes its listing, tasks and proposals from the app only; project files, chats,
  documents, models, agents, skills and workflows are untouched.

Not verified on a phone yet: pickers and kept grants on Android 16, real providers' write/create support, model JSON
answers and proposals within the 2,048-token context, and listing/search speed on a real project.

## Architecture

- **One React Native app, no backend.** `App.tsx` holds the chat and a screen stack: Docs, Agents (skills and
  workflows), Code, Data, History.
- **Storage.** Everything is in the app's private SQLite through `AiStoreModule.kt`, with versioned forward-only
  migrations in `src/chatStore.ts` (schema v9). A database written by a newer app version is refused, not used.
  Models are files in app storage, each verified by SHA-256.
- **Native modules** (Kotlin, narrow, no code execution):

  | Module | Purpose |
  |---|---|
  | `AiStore` | SQLite |
  | `AiDocs` | Document picker and text/PDF extraction, save picker, backup file copies |
  | `AiWorkspace` | Project folders through the Storage Access Framework, with guarded writes |
  | `AiCrypto` | Backup encryption |
  | `AiDevice` | Network state, screen-on during a download |

- **Untrusted input → validation → action.** Model plans, skills and workflows, imports, proposals and restored
  backups are all validated by app code before anything runs or is stored. Writes outside the app (exported files,
  project changes, backup copies) happen only through Android pickers or the coding assistant's approval screen.
- **Model.** On-device inference with llama.rn (Qwen2.5-1.5B-Instruct), one operation at a time.

## Privacy and data (M8)

**Data** (chat header) brings everything about your data together. Details:
[docs/backup-and-restore.md](docs/backup-and-restore.md), [docs/security.md](docs/security.md),
[docs/release.md](docs/release.md).

- **Backup.** Choose categories:
  - included by default: settings, chats, memories, document list, agents, skills/workflows, workspaces;
  - optional: document text, run history, coding tasks, and code proposals (flagged: they contain source code).

  Models, indexes, workspace listings and Android folder access are never included. Enter a password twice (10+
  characters). The backup is encrypted with AES-256-GCM (key from PBKDF2-HMAC-SHA256, 600,000 iterations, a fresh
  salt each time), streamed to a private temporary file, read back and authenticated, then copied to a new file you
  place and verified by SHA-256. **A lost password can't be recovered.**
- **Restore.** Pick the file and enter the password. The whole backup is decrypted, authenticated and validated, and
  compared with the phone's data, before anything changes. You then choose categories and **Merge** (adds what is
  missing; conflicts keep the current version or add a copy) or **Replace** (confirmed; not offered for workspaces).
  Each category is one transaction. A journal records each category's outcome, and an interrupted restore is shown
  at the next launch. Restored definitions are validated again, and restored proposals become review-only.
  Restored workspaces need their folder picked again.
- **Storage.** The database size, model files and temporary files are measured; per-category text sizes are labelled
  estimates. Cleanup removes only:
  - rebuildable data: vectors (rebuilt in the background), and a rebuild of the keyword index;
  - temporary files;
  - incomplete downloads, never while one is running;
  - finished code proposals;
  - coding tasks.

  Chats, documents and workspaces are deleted from their own screens. Proposal retention: until deleted, 30 days or
  7 days (finished proposals only).
- **Integrity.** "Check database" runs SQLite's quick_check and looks for unreachable records. It reports only;
  removing those records is a separate, explicit action. Nothing is repaired or recreated automatically.
- **Android.** Cloud backup and device-to-device transfer are excluded for all app data (`dataExtractionRules`). The
  app has no storage permission. Deleted rows are overwritten (`secure_delete`), but this is not a secure erase.
- **Release.** `npm run release-check` (see [docs/release.md](docs/release.md)). Release builds keep the debug key
  unless you configure your own key outside the repository.

## Device-only checks

One consolidated, non-destructive Galaxy M35 session: see "Galaxy M35 validation" in [docs/release.md](docs/release.md).
Already verified on an Android 17 emulator (M9): the backup cryptography (14 on-device tests) and the release app's
backup → wrong password → restore flow.

## Carried over from the original app, and M11

These features came from the original AI-ChatBot phone app. They were left out of M1–M10, and M11 ports them along
with new document features. They are tested on the laptop (Jest and Kotlin JVM), not yet on a phone.

- **Live information in chat** (`src/liveData.ts`):
  - covers weather (also "weather here", using approximate location), local time, crypto prices and news headlines;
  - comes from free services that need no account or key: Open-Meteo, CoinGecko, Google News RSS;
  - answers are built from the fetched data only, with source links. Offline or failed lookups say so and never guess.
  - **This is network use beyond the model download, and it only happens when you ask a live question.**
- **Location** (`src/location.ts`, `AiLocationModule.kt`): approximate (about 1 km) and asked once. It is used only
  for weather and never stored.
- **Games** (header → Games): Tic-Tac-Toe, Rock Paper Scissors, Number Guessing, Memory Match. Fully offline.
- **Memory commands** ("Remember my name is …", "What is my name?", "Forget …") and quiet learning of facts you
  state. Credentials are refused and stored redacted.
- **Voice** (`src/voice.ts`, `VoiceModule.kt`):
  - 🎙 uses Android's own speech recognition, in all six languages (Malayalam was added); a long press chooses the
    language. A transcription is never sent automatically.
  - 🔊 Speak reads an answer aloud.
- **Photos** (📷, camera or gallery): "What is this?" answered by the phone's own image model, offered for download
  (1.7 GB, verified) on first use.
- **Word (.docx) and Excel (.xlsx) import** (`OfficeText.kt`). It has ZIP-bomb limits and never resolves XML entities.
- **Exact table analysis** of CSV and Excel files: count, sum, average, min and max, with filter and group-by,
  computed by the app (`table.analyze` tool).
- **Named document collections**, and a flag when **different documents give different amounts** ("30 days" vs
  "14 days").
- **Re-ranking was evaluated and not adopted**: hybrid hit@1 fell from 0.893 to 0.821
  (`eval/results/retrieval-m11-rerank.md`).
- **Permissions now** (all asked at the moment of use): internet, network state, approximate location, microphone.
- **Schema v10:** collections. Collections are also a backup category.

## M13: Text recognition (OCR)

Scanned PDFs and photos of text (JPG, PNG, WebP) can be imported into Documents. Tesseract 5 reads them on the phone
(Tesseract4Android 4.9.0, Apache-2.0); the files are never uploaded.

- **Languages:** English, Telugu, Hindi, Tamil, Kannada, Malayalam. In Documents, go to *Text recognition* and tap a
  language. The app shows the size (1–5 MB) and downloads the file only after you confirm. Each file is checked against
  its pinned sha256 (`src/knowledge/ocr.ts`) before it is used.
- **Limits:** at most 50 pages per scanned PDF, and images up to 30 MB. Recognized text is marked as possibly
  containing mistakes.
- **On-device test (emulator only):**
  `.\scripts\push-tessdata.ps1 -Serial emulator-5554 -From <folder with .traineddata>`, then
  `adb shell am instrument -w -e class com.subbu.localai.OcrDeviceTest com.subbu.localai.test/androidx.test.runner.AndroidJUnitRunner`.

## M13: Translation quality (measured)

Translation uses the on-device model. Results for Qwen2.5 1.5B with the app's own prompt, on 8 sentences in each
direction (`scripts\eval-translation.ps1`, report in `eval/results/translation-m13.md`; chrF 0–100):

| into → | Telugu | Hindi | Tamil | Kannada | Malayalam |
|---|---|---|---|---|---|
| from English | 12.3 | 19.9 | 16.8 | 9.5 | 11.5 |
| to English | 20.6 | 67.4 | 18.3 | 17.1 | 25.8 |

Translation into Indian languages is poor: replies are often wrong or repetitive. Hindi to English is usable. The app
adds a caution under every translation into an Indian language.

## M14: Scheduled tasks and MCP connections

- **Scheduled tasks:** *"Schedule daily 08:00 Give me a Kafka question"*, *"Scheduled tasks"*, *"Cancel task 1"*. At
  that time a notification appears (Android may delay it by a few minutes). Tapping it puts the prompt in the chat, and
  you send it yourself. The model never runs in the background. Tasks come back after the phone restarts (a boot
  receiver re-arms them); a one-time task that was due while the phone was off notifies right after the restart.
- **Connect (MCP):** add a remote MCP server by its `https://` address. Its tools start switched off. Each call shows the
  server, the tool and the exact arguments before anything is sent. Not supported: sign-in/OAuth servers, and use of
  MCP tools from Agents.
- Demo walkthrough: `docs/demo.md`.

## Restored from the original app: Copy, Reply, games in chat

- Every message has **⧉ Copy**. Answers that contain code also get **</> Copy code**, which copies only the fenced
  code.
- **↩ Reply** quotes a message: a preview appears above the input, and the quoted text is given to the model with your
  next message.
- *"Play tic tac toe"*, *"Create game tic toc tie here"*, *"let's play a game"* open the game inside the chat.
  Questions about games (rules, history) still go to the model. Games shown in chat are not kept in history.

## Exact spreadsheet answers in Docs mode

Questions such as *"What is the total amount for North?"*, *"average amount"* or *"highest amount in South"* about a
CSV or Excel document are calculated exactly by the app (`tableQuestion` in `src/knowledge/tables.ts`), not by the
model. Found on the Galaxy M35: the model answered 1200 where the right total is 1500, because it summed only one of
the two North rows. Questions without total/average/count/highest/lowest still go to the model.

- **Docs mode survives restarts:** Docs mode and its document scope are saved, so they are still set after Android
  closes the app in the background.
- **Games stay in history:** an in-chat game is kept in the conversation and opens as a new game when you return.
