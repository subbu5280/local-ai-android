# Demo script (about 10 minutes)

A walkthrough for an interview or review. Every step works on a phone with the model downloaded. Steps marked
**(online)** need a connection; everything else works in airplane mode.

## 1. Private by default (1 min)
- Turn on airplane mode. Ask *"Explain Kafka consumer groups in Telugu"*. The answer comes from Qwen2.5 1.5B on the
  phone, in Telugu.
- Long-press **Send** to see and edit the exact prompt the model receives (prompt transparency, M12).

## 2. Your documents (2 min)
- **Documents → Import** a PDF, a Word file and an Excel sheet. Switch on **Docs** mode and ask a question. The answer
  cites the page or sheet it came from. When two documents disagree, the app says so.
- Import a **photo of a printed page** (after downloading a language under *Text recognition*). It becomes searchable
  (OCR, M13).

## 3. Agents, skills, code (2 min)
- Ask an agent to *"compare the totals in sales.xlsx by region"*. It runs the `table.analyze` tool step by step, and
  you can see each step.
- **Code**: open a workspace and ask for a change. You get a diff proposal to approve; nothing runs on its own.

## 4. Carried over from the original app (2 min) (online)
- *"Weather here tomorrow"*, *"Latest Chennai news"*, *"Bitcoin price"*. These come from live services, not the
  model.
- **Games**: Tic-Tac-Toe, Memory Match. The microphone takes voice input in 6 languages.

## 5. Automation, with limits (1 min)
- *"Schedule daily 08:00 Give me one Kafka interview question"*. At 8 a notification appears; tapping it puts the
  prompt in the chat (it is never sent by itself).
- **Connect** (online): add an MCP server by https address. Its tools start switched off, and each call shows exactly
  what will be sent.

## 6. Trust (2 min)
- **Data → Backup**: an encrypted backup to a file you choose. Restore merges it, or replaces data after you confirm.
- Talking points: Android backup is off, nothing is uploaded, every download asks first and is hash-checked.
  Measured results are in `eval/results/` (retrieval, language detection, translation). The weak spots are written
  there too.
