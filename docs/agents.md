# Agents

An agent runs a task as a short plan of checked tool steps, on the phone. Skills and workflows build reusable
sequences from the same tools; see [skills-and-workflows.md](skills-and-workflows.md).

An agent is a name, a purpose, a set of enabled tools and limits. Three are created on first use (Document assistant,
Calculator and clock, Notes writer); they can be edited, duplicated, disabled or deleted (**Agents** in the header).
Agents and their run history are stored only in the phone's database.

## Tools

Each tool is fixed app code with an id, a version, a typed input, a permission, a risk level and a time limit. There
is no shell, no code execution, no network tool, and no tool can read the app's own files, chats or the model.

| Tool | Does | Risk |
|---|---|---|
| `calculator` v1 | Exact arithmetic with a parser (no `eval`): + − × ÷ ^, %, "x% of y", mod, sqrt, round, min, max, ln, log | none |
| `datetime` v1 | Date, weekday, time and UTC offset from the phone's clock | reads the clock |
| `docs.search` v1 | Keyword search in the documents the task may read | reads documents |
| `docs.passages` v1 | Specific passages of one document | reads documents |
| `docs.read` v1 | The beginning of one selected document | reads documents |
| `docs.answer` v1 | Answers from passages of an earlier step, with sources and conflict flags | uses the model |
| `table.analyze` v1 | Exact count, sum, average, min, max over a CSV/Excel document, with a filter and group-by | reads documents |
| `text.summarize` v2 | Summarizes text or an earlier step's passages (fenced as data), keeping their sources | uses the model |
| `text.compose` v1 | Writes text about an earlier step's result following a short instruction | uses the model |
| `code.search` v1 | Lines containing a text in a registered project workspace (secrets redacted) | reads workspaces |
| `code.read` v1 | Up to 80 numbered lines of one workspace file | reads workspaces |
| `file.export` v2 | Saves an earlier step's text as a **new** file you name and place in Android's save picker | writes: asks every time |

## How a task runs

1. **Plan.** The model proposes steps as JSON, constrained by llama.rn to a schema of the agent's enabled tools. The
   app validates the plan like any untrusted input: known tools, valid inputs, `fromStep` pointing only to an earlier
   compatible step, documents inside the task's scope, step count within the limit. If the model isn't loaded or its
   plan is rejected, the app uses its own default plan. The screen says which one you see and why.
2. **Approve.** The plan is shown; **Run** starts it.
3. **Execute.** Steps run one after another with no re-planning. Tool results are data and can never add steps or
   change permissions. Each step has a result check, a time limit and at most 0–2 retries. A failed step stops the
   run; a run is **Succeeded** only if every step succeeded. Cancel stops the running step.
4. **Confirm writes.** Before `file.export` the app shows exactly what will be saved; "Don't allow" cancels with
   nothing written. Existing files are never overwritten; imported documents are never modified.

When the document search finds nothing, the run ends as **Not found in documents**; the model is not asked.

## History and limits

Every run records the agent (id, name, version), the task, where the plan came from, and per step: tool, input,
status, attempts, timings and a short result summary. A run cut off by the app closing shows as **Interrupted**.
Failed, cancelled or interrupted runs can be re-run (validated again) unless a file was already saved.

Limits per agent, inside app bounds: 1–6 steps, 0–2 retries per step, 5–180 s per step.
