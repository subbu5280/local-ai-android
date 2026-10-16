# Local AI

A private AI assistant that runs **on your Android phone**. Chat, ask questions about your own documents, run small
agents, and review code, with a language model under 4B parameters that works offline once it is downloaded. Built
for six languages: English, Telugu, Hindi, Tamil, Kannada and Malayalam.

Nothing you type, import or record is uploaded. The network is used only for downloads you confirm, live questions
you ask (weather, news, prices), and MCP servers you add yourself.

This is a separate, enhanced successor to [AI-ChatBot](https://github.com/subbu5280/AI-ChatBot), whose features it
carries over without needing its laptop backend.

## Features

| | What you can do | Guide |
|---|---|---|
| 💬 **Chat** | On-device answers in six languages; Stop; Copy, Reply, Speak; prompt preview; saved chats | [User guide](docs/user-guide.md) |
| 📄 **Documents** | Import TXT, Markdown, CSV, PDF, Word, Excel, scans and photos (OCR); search; cited answers; exact spreadsheet totals | [Documents](docs/documents.md) |
| 🤖 **Agents** | Tasks run as checked tool steps; reusable skills and workflows | [Agents](docs/agents.md), [Skills and workflows](docs/skills-and-workflows.md) |
| ⌨️ **Code** | Ask about, debug and review a project folder; approve proposed changes file by file | [Coding assistant](docs/coding-assistant.md) |
| 🌦 **Live info** | Weather, time, prices and news from free services, with sources | [User guide](docs/user-guide.md#live-information-online) |
| 🎙 **Voice and photos** | Speak in six languages; ask about a photo with an on-device image model | [User guide](docs/user-guide.md#voice) |
| 🎮 **Games** | Tic-Tac-Toe, Rock Paper Scissors, Number Guessing, Memory Match, full screen or in chat | [User guide](docs/user-guide.md#games) |
| ⏰ **Scheduled tasks** | "Schedule daily 08:00 …" reminds you with a notification | [User guide](docs/user-guide.md#scheduled-tasks) |
| 🔌 **Connections** | Opt-in remote MCP servers; every tool off by default, every call confirmed | [User guide](docs/user-guide.md#connections-mcp-online) |
| 🛡 **Your data** | Password-encrypted backup and restore, storage report, cleanup | [Backup and restore](docs/backup-and-restore.md) |

## Requirements

- Node.js 22.11+, JDK 17, Android SDK (compileSdk 37, NDK 27.1).
- An arm64 Android phone (or an x86_64 emulator) with about 2 GB free for the chat model. Tested on a Samsung
  Galaxy M35 (Android 16, 8 GB RAM).

## Setup

```sh
git clone https://github.com/subbu5280/local-ai-android.git
cd local-ai-android
npm install
```

On Windows, run `npm install` from PowerShell or cmd, not Git Bash: llama.rn's install script calls `tar`, and Git
Bash's GNU tar misreads `C:\...` paths.

## Run

```sh
npm start             # Metro bundler
npm run android       # build and install the debug app on a connected phone or emulator
```

For a standalone release build: `cd android && ./gradlew assembleRelease` (output in
`android/app/build/outputs/apk/release/`). Signing and the release checklist: [docs/release.md](docs/release.md).

## Usage

1. Open the app and tap **Get model** (1.1 GB, once; Wi-Fi recommended). It is checked against its SHA-256 first.
2. When the status shows **● On-device · offline ready**, type in any of the six languages and tap **Send**.
3. Try:
   - `Kafka గురించి చెప్పండి` gets an answer in Telugu.
   - **Docs → Import** a PDF, turn on **Docs**, ask `What is the refund period?` and get an answer with its source.
   - `What is the total amount for North?` about a spreadsheet is calculated exactly by the app.
   - `Schedule daily 08:00 Give me one interview question`.
   - `Play tic tac toe`.

The language rules can also be used directly in code:

```ts
import { detect, instruction } from './src/core/language';

const lang = detect('Kafka గురించి చెప్పండి');  // { code: 'te', source: 'script', bcp47: 'te-IN', ... }
instruction(lang);                               // "Language: Respond in Telugu written in Telugu script. ..."
detect('ok', lang.code).code;                    // 'te': a short reply keeps the chat's language
```

## Tests

```sh
npm test               # 430 Jest tests
npm run release-check  # typecheck, lint, tests, manifest, permission and secret checks
```

More, including evaluations, emulator and phone checks, and what has been verified on which device:
[docs/testing.md](docs/testing.md).

## Known limits

- **Translation into Indian languages is poor** with the 1.5B model (chrF 10–20 of 100); the app shows a caution.
  [Measured results](eval/results/translation-m13.md).
- OCR is reliable on clean print; photos of handwriting or poor scans will contain mistakes.
- The model runs only while the app is open; scheduled tasks remind you rather than answer in the background.
- Not yet run on the phone: backup and restore, MCP with a real server, live data, voice and the image model.

## Documentation

| Guide | For |
|---|---|
| [User guide](docs/user-guide.md) | Everything on the phone, screen by screen |
| [Documents](docs/documents.md) | Formats, search, OCR, meaning search, Docs mode |
| [Agents](docs/agents.md) · [Skills and workflows](docs/skills-and-workflows.md) | Tools, plans, runs, formats |
| [Coding assistant](docs/coding-assistant.md) | Workspaces, review, proposals, approval |
| [Backup and restore](docs/backup-and-restore.md) | Encryption, format, restore modes |
| [Architecture](docs/architecture.md) | Routing, native modules, schema, project layout |
| [Security](docs/security.md) | Threat model, permissions, boundaries |
| [Testing](docs/testing.md) · [Evaluation](eval/README.md) | How it is tested and measured |
| [Release](docs/release.md) | Building, signing, release checks |
| [Demo script](docs/demo.md) | A 10-minute walkthrough |

## Licenses

App code: this repository. Models and components are downloaded separately, each under its own license:
Qwen2.5-1.5B-Instruct (Apache-2.0), multilingual-e5-small (MIT), Tesseract and tessdata_fast (Apache-2.0).
