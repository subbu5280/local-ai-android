# Architecture

## Overview

- **One React Native app, no backend.** `App.tsx` holds the chat and a stack of screens opened over it (Docs, Agents,
  Code, Games, Connect, Data, History, Model).
- **Chat routing.** A message is handled by the first route that applies, in this order (checked in
  `__tests__/combinations.test.tsx`):
  attached photo → schedule command → in-chat game → memory command → Docs mode → live lookup → the model.
- **Model.** On-device inference with llama.rn (Qwen2.5-1.5B-Instruct Q4_K_M), one operation at a time. Every model
  file is verified by SHA-256 before use.
- **Storage.** Everything is in the app's private SQLite database through `AiStoreModule.kt`, with versioned,
  forward-only migrations in `src/chatStore.ts` (schema v10). A database written by a newer app version is refused.
- **Untrusted input → validation → action.** Model plans, skills and workflows, imports, code proposals, MCP results
  and restored backups are all validated by app code before anything runs or is stored. Writes outside the app
  happen only through Android pickers or the coding assistant's approval screen.

## Native modules (Kotlin, narrow, no code execution)

| Module | Purpose |
|---|---|
| `AiStore` | SQLite |
| `AiDocs` | Document picker; text, PDF and Office extraction; save picker; backup file copies |
| `AiOcr` | Tesseract text recognition of images and scanned PDF pages |
| `AiWorkspace` | Project folders through the Storage Access Framework, with guarded writes |
| `AiCrypto` | Backup encryption (PBKDF2-HMAC-SHA256, AES-256-GCM) |
| `AiDevice` | Network state, screen-on during downloads, clipboard copy, full-screen mode |
| `AiLocation` | Approximate location for "weather here" |
| `AiVoice` | Speech recognition and text-to-speech; memory info |
| `AiSchedule` | Scheduled-task alarms and notifications; re-armed after a restart |

## Database schema history

| Version | Adds |
|---|---|
| 1 | conversations, messages |
| 2 | memories |
| 3 | learned facts |
| 4 | documents, passages, full-text index |
| 5 | agents and run history |
| 6 | passage vectors (meaning search) |
| 7 | skills, workflows |
| 8 | code workspaces, tasks, proposals |
| 9 | restore journal |
| 10 | document collections |

Settings such as Docs mode, scheduled tasks and MCP servers live in the `meta` table.

## Project layout

| Path | What |
|---|---|
| `App.tsx` | Chat screen, routing, header, screen stack |
| `src/core/` | Language detection, intent rules, prompt building, translation caution |
| `src/chatStore.ts`, `src/localModel.ts`, `src/modelManager.ts`, `src/ModelScreen.tsx` | Storage and migrations; model download, load, generate; model fit rules and screen |
| `src/knowledge/` | Formats, chunking, tokens, index, import, retrieval, meaning search, OCR, tables, collections, prompts |
| `src/KnowledgeScreen.tsx`, `src/DocumentScreen.tsx` | Documents library and document view |
| `src/agents/` and agent screens | Tools, calculator, policy, planner, engine, storage |
| `src/skills/` and library screens | Skill/workflow formats, storage, runner, drafts |
| `src/code/` and code screens | Coding assistant: workspaces, search, answers, proposals, apply |
| `src/backup/`, `src/storage.ts`, `src/DataScreen.tsx`, `src/BackupScreen.tsx` | Encrypted backup and restore, storage report, cleanup |
| `src/liveData.ts`, `src/location.ts` | Live weather, time, prices, news; approximate location |
| `src/memoryCommands.ts`, `src/learning.ts`, `src/topics.ts` | Memory commands and learned facts |
| `src/voice.ts`, `src/imageAttach.ts`, `src/visionCapability.ts` | Voice; photos and the image model |
| `src/Games.tsx`, `src/TicTacToe.tsx`, `src/GamesScreen.tsx` | Games, in chat and full screen |
| `src/schedule.ts`, `src/mcp.ts`, `src/McpScreen.tsx` | Scheduled tasks; MCP client and Connections screen |
| `src/theme.ts` | Colours for light and dark mode |
| `android/app/src/main/java/com/subbu/localai/` | Native modules listed above |
| `android/app/src/{test,androidTest,sharedTest}/` | Kotlin tests on the JVM and on a device or emulator |
| `__tests__/`, `testUtils/` | Jest tests and fakes |
| `eval/` | Evaluation datasets, runners and results ([eval/README.md](../eval/README.md)) |
| `scripts/` | Release check, device check, emulator tests, evaluations |
