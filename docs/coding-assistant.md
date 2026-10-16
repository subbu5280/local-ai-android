# Coding assistant and project workspaces (M7)

The coding assistant works with a software project you pick on the phone. It reads bounded excerpts of your files,
answers questions, investigates errors and reviews code with references to files and lines, and proposes changes that
are applied **only after you review and approve them**. Everything runs on the phone. Source code is never uploaded,
and nothing is compiled, run or executed.

Status: implemented and tested on the laptop with Jest, using a fake document provider and a fake model. It has
**not been verified on a phone** yet. See "Unverified on a device" below.

## Workspaces and storage providers

**Code → Add folder** opens Android's folder picker (`ACTION_OPEN_DOCUMENT_TREE`). **Add files** opens the file picker
(`ACTION_OPEN_DOCUMENT`, several files). Android grants the app access to exactly what you pick, and the app keeps
that grant (a persistable URI permission). The app has no storage permission and never uses file system paths: every
file is a `content://` document that the storage provider resolves (android/.../AiWorkspaceModule.kt).

- **Read and write.** The app asks for both. If a provider grants read only, the workspace is marked "read only":
  you can still ask questions and review proposals, but you can't apply them.
- **Listing.** The folder is listed breadth-first through the provider, up to 3,000 entries and 12 levels deep. These
  folders are skipped: `node_modules`, `.git`, `build`, `dist`, `out`, `target`, `.gradle`, `.idea`, `.vscode`, `Pods`,
  `__pycache__`, `venv`, `.next`, `coverage`, `bin`, `obj`, `vendor`, … and other dot-folders except `.github`.
  **Refresh** lists again. A cancelled refresh keeps the previous listing.
- **Picked files** have no folder, so proposals in that kind of workspace can modify those files but can't create new
  ones.
- **Removing a workspace** deletes its listing, coding tasks and proposals (including saved originals) from the app,
  and gives up the grant. Your project files are not changed or deleted. Chats, documents, models, agents, skills and
  workflows are not affected.
- **Errors are explained, never worked around.** These cases each get an explanation and a next step: access revoked
  in Android settings, a file deleted or moved, a provider that can't list, write or create, and unreadable files.
  The app never falls back to broader storage access.

Providers tested: the in-memory fake only. Behavior of real providers (the phone's own storage, SD cards, cloud
providers such as Google Drive) is not verified. Some cloud providers don't support writing in place (`"wt"`), and
some don't support creating documents. The app reports "unsupported" in those cases.

## What is read, and the limits

Supported files are recognized by name and extension. They are treated as text, and no language parser is used:
TypeScript, JavaScript, Python, Java, Kotlin, C#, JSON, YAML, Markdown, XML, HTML, CSS/SCSS, Gradle, properties,
TOML/INI, shell, Go, Rust, Swift, C/C++, Dart, Ruby, PHP, SQL, Vue/Svelte, and `Dockerfile`, `Makefile` and
`CMakeLists.txt`. Minified files, source maps and lock files are skipped.

| Limit | Value |
|---|---|
| File read for analysis | ≤ 200 KB (larger files are listed, not read) |
| Content search | ≤ 250 files and ≤ 3 MB per search, ≤ 60 matching lines |
| Source text given to the model | ≈ 1,000 tokens per question; ≈ 800 for a change proposal |
| Excerpt | ≤ 60 lines per range; at most 8 files per question |

Values are in `LIMITS` in `src/code/files.ts`. The model's whole context window is 2,048 tokens.

**Never read:** binary content (NUL or control characters), and files that usually hold secrets: `.env*`, `*.pem`,
`*.key`, `*.p12`, `*.jks`, `*.keystore`, `id_rsa*`, `.npmrc`, `.netrc`, `credentials*.json`, `secrets.*`,
`local.properties`, `keystore.properties` and `service-account*.json`. A file that is not valid UTF-8 can be read,
with a warning, but is never rewritten.

**Secret redaction (best effort).** Before matching or showing text to the model, the app replaces recognizable
values with `«redacted»`. It recognizes three patterns:
- assignments whose name sounds secret (`password`, `token`, `apiKey`, `client_secret`, …)
- well-known token formats (AWS `AKIA…`, GitHub `ghp_…`, Google `AIza…`, Slack `xox…`, JWTs, `sk-…`, `hf_…`)
- private-key blocks

Line numbers stay the same. **This is imperfect.** A secret with no telltale name or format is not found. A value
that only looks secret can be hidden. A proposal can't edit a redacted value.

## How context is selected

For each question the app finds the relevant files without loading the project:
1. Files you selected.
2. Files named in a pasted error or stack trace. It understands JS/TS `path:line:col`, Python
   `File "…", line N`, Java/Kotlin `(Foo.kt:42)` and tsc/C# `file(12,5)`. Each reference is matched to the
   workspace by the longest path suffix.
3. Files whose name matches a term in the question, and lines containing its most specific identifiers (one bounded
   content search).
4. For broad questions ("architecture", "dependencies", "build"), project files such as `package.json`, Gradle files,
   `tsconfig`, the README and the manifest.
5. Files inspected earlier in the same task.

Each file is read once and appears once. A short file that the question is clearly about is given whole. Otherwise
the app uses windows of a few lines around the relevant lines, with the file's real line numbers, until the budget is
used up. The task screen lists every file and line range that was inspected, which files were skipped and why, and
whether the context was cut off at the limit.

## Asking, debugging and reviewing

Choose **Ask**, **Debug** (paste the error), **Review** or **Propose change**, plus an answer language: Auto or
English, Telugu, Hindi, Tamil, Kannada or Malayalam. Code, identifiers, file names, API names and error text are
never translated. A task keeps its selected files, language and its last turns as context for follow-up questions.

The model answers in a fixed JSON shape that llama.rn constrains: the answer, whether the context was enough, up to
six findings, a suggested fix, side effects and checks. Each finding is **observed**, **inferred** or **hypothesis**,
with a file and line. The app then checks every reference against what the model was actually shown:
- A file that was not inspected: the reference is dropped, an "observed" finding becomes a hypothesis, and a note
  says why.
- A line outside the inspected lines: the line is dropped and "observed" becomes "inferred".

So a small model can't present an invented location as evidence. If no file matches the question, the app says so
**without asking the model**. If the model reports insufficient context, the answer is marked "Not enough context".

**Debug and Review** also run deterministic **pattern checks** on the inspected lines, with exact locations: `eval` /
`new Function`, direct HTML insertion, shell or system commands, SQL built from strings, empty `catch` /
`except: pass`, plain `http://`, `Math.random()` used for keys or tokens, and values that were redacted as secrets.
These are labelled "worth checking; not a confirmed defect". Review works with only these checks when the model is not
loaded.

Every answer says: **Nothing was compiled, run or tested.** Suggested checks and commands are for you to run.

**Untrusted content.** Source code, comments, README text and error messages are fenced between `<<<FILE …` /
`FILE>>>` markers. Any such markers inside your files are neutralized. The model is told they are data. More
importantly, the model has no tools in this flow. Nothing it writes is executed, and nothing it proposes changes a
file without your approval.

## Change proposals

**Propose change** asks the model for a proposal. Each proposal has:
- a title, objective and reason
- for each file: `modify` (a list of `{find, replace}` edits, or the complete new content) or `create` (complete
  content), with its purpose
- assumptions, risks and validation steps

The app validates the proposal before you see it, and invalid proposals are not saved. The task screen lists the
reasons. A proposal is rejected for any of these:
- **Paths:** absolute paths, drive letters, `~`, URIs, `..` or `.` segments, empty segments, backslashes,
  percent-encoding (`%2e%2e`), control characters, Unicode that changes under NFKC (for example fullwidth dots),
  overly long names.
- **Targets:** anything outside the workspace listing; dependency or output folders; secret files; unsupported or
  binary types; `create` where a file already exists or its folder doesn't (the app never creates folders); `modify`
  where the file doesn't exist; read-only grants; provider flags that don't allow writing or creating.
- **Operations:** anything other than modify and create. Delete, rename, move and chmod are never supported.
- **Patches:** an empty `find`; a `find` that matches zero or several places (exact match, or else a match that
  ignores indentation and trailing spaces); overlapping edits; both edits and full content; edits touching a redacted
  value; a change that changes nothing; content that isn't plain text.
- **Conflicts and limits:** two changes to one file (compared case-insensitively); more than 6 files; more than 8
  edits per file; more than 100,000 characters per file or 300,000 in total; unknown fields.

Line-number prefixes copied from excerpts (`12| `) are stripped. Windows line endings are kept.

## Review, approval and application

The proposal screen shows each file's operation, purpose, a line diff, and **Accepted/Rejected** toggles. **Apply N
approved** asks for confirmation, and only `src/code/apply.ts` then writes:
1. The proposal must be *ready* and belong to this workspace. An approval is used once: a proposal that is applied,
   partly applied, stale, failed or rejected can't be applied again. Ask for a fresh one.
2. Before anything is written, every approved change is re-validated against the provider's current listing: path
   form, workspace, file type, grants and provider flags. Every file to modify is re-read. If its bytes differ from
   the ones the proposal was made from, **nothing is written** and the proposal is marked **stale**. A new file whose
   name now exists is also stale. Existing files are never replaced by a `create`.
3. Files are written one at a time. Each write checks the file's SHA-256 natively immediately before writing, writes
   with truncation (`"wt"`), and reads the result back. If the read-back differs, the original bytes are written
   back. A new file is created only if no file of that name exists. If the provider renames it, the empty file the
   app just created is removed and the change fails.
4. Each file's outcome is saved as soon as it is known: applied and verified, failed, stale, not applied, or unknown.
   A failure stops the remaining files. The result says exactly which files changed, and the proposal is **partial**,
   never "applied".

**Recovery.** The original text of every modified file is kept with the proposal. **Restore original** writes it
back, but only while the file still holds exactly the applied text, so it never overwrites newer edits. The app
never deletes files, so a created file you don't want has to be removed in a file manager. If the app closes while
applying, the next launch marks the proposal *interrupted*, and files whose outcome wasn't recorded become
*unknown*. Restore is offered for those if the file holds the proposed text.

**Storage-provider limits.** Android's document providers offer no atomic multi-file replacement or rollback, and
the app doesn't claim either. A single write is checked and verified, but a provider could still fail halfway
through writing one file. When that happens and the read-back differs, the app tries to restore the original bytes
and reports whether that worked.

## Security boundaries

- Reading never grants writing. The agent tools `code.search` and `code.read` (permission `workspace.read`) only
  read, and no tool, agent, skill, workflow or imported definition can write a workspace file. Tests check that
  only the proposal screen imports `apply.ts`, and that only `apply.ts` calls the native write and create.
- Proposals come from the model and are untrusted. They are validated when made and again at application time.
- Workspace grants come only from your picks in the system picker. The app requests no storage permissions.
- Source text stays on the phone. History (`code_turns`) keeps questions, answers and which lines were inspected,
  never the source text. Proposals keep the original and proposed text of the files they change, because review and
  restore need it. Deleting the proposal or removing the workspace deletes that text.

## Execution restrictions

There is no shell, no subprocess, no `eval`, no running of generated code or project scripts, no remote execution,
and no MCP. A test checks the app sources and the Kotlin modules for execution APIs. The assistant can explain build
configuration, suggest commands and tests, and explain test output you paste. Validation is always reported as
**not run**.

## Storage (schema v8)

| Table | Holds |
|---|---|
| `code_workspaces` | Name, kind, granted tree URI, root document URI, write grant, last listing time and size |
| `code_entries` | Last listing: path, document URI, folder flag, size, modified time, provider write/create flags (no contents) |
| `code_tasks` / `code_turns` | Task title, selected files, language; per turn: mode, question, status, answer and findings, inspected ranges, error, proposal link |
| `code_proposals` / `code_proposal_files` | Title, body, status, outcome; per file: operation, path, purpose, original hash and text, proposed text, status, result hash, error |

The v7 → v8 migration only adds tables. Tests upgrade from v7 and v4 databases and check that chats, documents and
skills are kept.

## Tests

```sh
npx jest __tests__/codeWorkspace   # registration, listing limits, revoked/deleted, filtering, redaction, search, traces, context, removal
npx jest __tests__/codeAssistant   # checked references, insufficient context, pattern checks, injection, six languages, proposal validation
npx jest __tests__/codeApply       # approval, stale, partial failure, restore, provider limits, interruption, boundary and no-exec checks, migration
npx jest __tests__/codeApp         # the screens: add folder, debug, open reference, review, cancel/approve, restore, remove
```

These run on the laptop with no phone. The provider is `testUtils/fakeWorkspace.ts`, an in-memory fake with switches
for revoked access, deleted files, unsupported writes, failing writes and failed verification. The model is faked
with fixed JSON.

## Known limitations

- Text inspection only: no syntax trees, symbol index or type information. "Where is X used" is a line search.
- The 1.5B model with about 1,000 tokens of code gives short, sometimes wrong answers. The structure and the reference
  checks keep that visible, but they don't make the answers correct. Proposals often fail validation when the model
  copies a `find` text inexactly. The task then says why.
- No folder creation, deletion, rename or move. No editing of a proposal before applying it: you accept or reject
  each file.
- Files encoded as UTF-16 are rewritten as UTF-8 if changed.
- Search reads at most 250 files per query, so very large projects are only partly searched (the screen says so).

## Unverified on a device

These need a phone: the folder and file pickers and persisted grants on Android 16 (Galaxy M35), real providers'
flags and `"wt"` support, write and read-back on internal storage and on cloud providers, revoking access in system
settings, model JSON answers and proposals from Qwen2.5-1.5B within the 2,048-token context, and timings for listing
and searching a real project.
