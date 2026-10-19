# User guide

How to use every part of Local AI on the phone. For documents see [documents.md](documents.md); for agents, skills
and workflows see [agents.md](agents.md) and [skills-and-workflows.md](skills-and-workflows.md); for the coding
assistant see [coding-assistant.md](coding-assistant.md); for backups see [backup-and-restore.md](backup-and-restore.md).

## First start

1. The first start shows three short welcome pages (privacy, what you can do, the download); **Skip** closes them.
   Then tap **Get model**. It downloads Qwen2.5-1.5B-Instruct (1.1 GB, Apache-2.0) once, only after you
   confirm, and checks it against its pinned SHA-256 before use. Use Wi-Fi. Offline, the app says so and downloads
   nothing. The download runs in Android's own download service: a notification shows progress, and it keeps going
   with the screen off or the app closed.
2. When the line under the title shows a green dot and **On-device · offline ready**, type a message and tap **Send**.

Everything below works offline unless it is marked **(online)**.

## The chat screen

- **Header:** the title and the model status (tap the status to open the **Model** screen), **🕘** saved chats and
  **＋** new chat. The row underneath scrolls sideways: Docs, Agents, Code, Games, Connect, Data.
- **Send / Stop:** Stop ends a long answer and keeps what was written so far.
- **Long-press Send** shows the exact prompt the model will receive, which you can edit before sending. Messages whose
  prompt differed from what you typed show **ⓘ Prompt sent to the model**.
- **Under every message:** **⧉ Copy**, **↩ Reply**, and on answers **🔊 Speak**. Answers that contain code also get
  **</> Copy code**, which copies only the code blocks.
- **Reply** shows a "Replying to …" bar above the input (✕ cancels). The quoted message is given to the model with
  your next message, so "make it shorter" knows what "it" is.
- **Formatted answers:** headings, bold, lists and quotes are shown formatted. Code blocks get colour, a language
  label and their own **⧉ Copy**; long lines scroll sideways.
- **Speed:** each answer shows how fast it was written, e.g. `⚡ 7.2 tok/s · 174 tokens`.
- **Saved chats:** every conversation is saved on the phone. The latest one reopens when the app starts.

## Languages

You can write in English, Telugu, Hindi, Tamil, Kannada or Malayalam, in their own script or romanized. The answer
follows your language:

- An explicit request wins: "in Tamil", "Tamil la sollu", "kannada alli", "తెలుగులో".
- Otherwise the script decides, then a few romanized marker words; otherwise English.
- Short replies such as "ok", "👍" or "2" keep the conversation's language.

These are word-list and script rules, not language understanding. The app's own buttons stay in English.

**Translation** uses the same small model and is measured to be poor **into** the Indian languages (chrF 10–20 out
of 100; see [the evaluation](../eval/results/translation-m13.md)). The app adds a caution under every translation
into an Indian language. Hindi to English works well (chrF 67).

## Live information (online)

Ask for weather ("Weather in Chennai tomorrow", "weather here"), local time, crypto prices ("Bitcoin price") or news
headlines ("Latest Chennai news"). These answers come from free services that need no account (Open-Meteo,
CoinGecko, Google News RSS), not from the model, and show their source links. Offline, the app says so instead of
guessing. Follow-ups such as "What about tomorrow?" continue the last live question.

"Weather here" asks once for **approximate location** (about 1 km). It is used only for that question and never
stored.

## Memory

**🧠 Memory** in the header shows everything the app tells the model about you:

- **Instructions for the model** (up to 600 characters), added to every chat, e.g. "Answer in short points. I'm a Java
  developer learning Kafka." Text that contains a real password, key or card number is refused.
- **What you asked me to remember**, each with **Edit** and **Forget**.
- **Picked up from your chats**, each with **Forget**.

In chat:

- "Remember my name is Ravi", "What is my name?", "Forget my name" are answered by the phone itself, without the
  model, in any mode.
- Passwords, PINs and similar secrets are refused and stored redacted.

## Voice

- **🎙** speaks a message using Android's own speech recognition, in all six languages. A long press chooses the
  language. What you said is put in the box; it is never sent automatically.
- **🔊 Speak** reads an answer aloud.

## Photos

**📷** takes a photo or picks one from the gallery; then ask about it ("What is this?"). The first time, the app
offers to download the phone's image model (1.7 GB, verified). The photo is not stored.

## Games

**Games** in the header opens Tic-Tac-Toe, Rock Paper Scissors, Number Guessing and Memory Match in full screen: the
status and navigation bars hide, and a swipe from the edge shows them. You can also ask in chat: "play tic tac toe",
"let's play a game". The game opens right in the conversation and stays there when you come back. Questions about
games ("rules of chess") still go to the model.

## Scheduled tasks

- **Schedule:** "Schedule daily 08:00 Give me one Kafka interview question", "schedule at 7:30 pm call mom".
- **List / cancel:** "Scheduled tasks", "Cancel task 2".

At the time, a notification appears; Android may delay it by a few minutes. Tapping it puts the prompt in the chat
box and **you** tap Send: the model never runs in the background, and a link from another app can never run a prompt.
The first task asks for notification permission (Android 13+). Tasks survive a phone restart; a one-time task that
came due while the phone was off notifies right after it starts.

## Connections (MCP) (online)

**Connect** lets you add a remote [MCP](https://modelcontextprotocol.io) server you trust by its `https://` address.

- **Suggested** servers (public, no sign-in) can be added with one tap: DeepWiki, Context7, Hugging Face, Cloudflare
  docs and GitMCP.
- Its tools are listed **switched off**; switch on only the ones you want.
- Before every call the app shows the server, the tool and the exact arguments, and sends nothing until you tap Send.
- **Use in chat** puts a result in the message box.
- Not supported: servers that need sign-in (OAuth), and MCP tools inside Agents.

## Model

Tap the status line. Each model shows its size, license, and whether it fits this phone's storage (download plus a
reserve of the larger of 3 GB and 5 % of storage) and memory. Switching downloads the new model, checks it with a
test question, and keeps the current one if the answer is wrong.

## Privacy and data

**Data** in the header shows what is stored and how big it is, cleanup actions, a database check, and **Backup and
restore** (password-encrypted; see [backup-and-restore.md](backup-and-restore.md)). Nothing is uploaded; Android
cloud backup and device-to-device transfer are switched off for this app.
