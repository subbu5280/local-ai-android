# Skills and workflows (M6)

A **skill** is a short, reusable, parameterized sequence of built-in tool calls. A **workflow** is a sequence of tool
calls and skills. Both are JSON definitions, stored on the phone, validated before they can be saved or run, and
executed by the existing agent engine (one engine, one permission policy). They contain no code.

## Formats

### Skill (`"format": "localai.skill"`)

```json
{
  "format": "localai.skill", "formatVersion": 1,
  "id": "doc-summary", "version": 1,
  "name": { "en": "Summarize documents on a topic", "te": "అంశంపై పత్రాల సారాంశం" },
  "description": { "en": "…" }, "instructions": { "en": "Shown to the user only." },
  "inputs": [{ "name": "topic", "label": { "en": "Topic" }, "type": "text", "required": true, "maxLength": 300 }],
  "output": "text",
  "tools": ["docs.search", "text.summarize"],
  "permissions": ["documents.read", "model.generate"],
  "limits": { "maxSteps": 2, "maxRetries": 1, "stepTimeoutSec": 120 },
  "compatibility": { "tools": { "docs.search": 1, "text.summarize": 2 } },
  "steps": [
    { "tool": "docs.search", "input": { "query": "{{topic}}", "limit": 6 }, "purpose": { "en": "Find relevant passages" } },
    { "tool": "text.summarize", "input": { "maxWords": 120 }, "fromStep": 1 }
  ]
}
```

### Workflow (`"format": "localai.workflow"`)

```json
{
  "format": "localai.workflow", "formatVersion": 1,
  "id": "research-report", "version": 1,
  "name": { "en": "Research report to a file" }, "purpose": { "en": "…" },
  "inputs": [{ "name": "topic", "label": { "en": "Topic" }, "type": "text", "required": true }],
  "limits": { "maxSteps": 3, "maxRetries": 1, "stepTimeoutSec": 120 },
  "compatibility": { "tools": { "file.export": 2 }, "skills": { "doc-compare": 1 } },
  "steps": [
    { "skill": "doc-compare", "skillVersion": 1, "inputs": { "topic": "{{topic}}" } },
    { "tool": "file.export", "input": { "fileName": "research-report.txt" }, "fromStep": 1 }
  ]
}
```

### Values and references

- Step inputs are the tool's own typed fields (see the tool list in the README). A value is a literal, a text
  template (`"Compare what the documents say about {{topic}}"`), or `{ "$input": "name" }` (needed for number fields).
- `fromStep: n` passes the result of an earlier step `n`. Its kind (`passages`, `text`, `value`) must be one the tool
  accepts; a skill step's result is the skill's `output`. In a workflow, skill steps take their values from
  workflow inputs, not from `fromStep`.
- Texts (`name`, `description`, `purpose`, `instructions`, labels) may be given in `en` (required), `te`, `hi`, `ta`,
  `kn`, `ml`. Ids, tool names and parameters are never translated.

## Validation (before saving, importing or running)

Rejected with a reason: unknown fields anywhere (including `__proto__`); definitions over 32 KB; unsupported
`format`/`formatVersion`; malformed ids; unknown tools; steps using tools the skill does not declare; declared
`permissions` that differ from what the tools need (a skill can neither understate nor grant itself permissions);
tool or skill versions different from this app's (`compatibility`); input fields a tool does not have; `{{name}}` or
`$input` references to undeclared inputs; `fromStep` that is not earlier or gives the wrong kind of data; more steps
than the limits allow (a workflow counts its skills' steps; at most 6); limits outside the app's bounds; missing,
disabled or differently versioned skills (workflows). Stored definitions are validated again when loaded, so a damaged
record shows its problems instead of running.

## Running

1. The input values are checked against the declared inputs.
2. The definition is compiled into engine steps (skills expanded in place, references renumbered).
3. The agent policy validates the steps against a principal that may use **exactly** the definition's tools, with
   limits clamped to the app bounds, in the run's document scope, with the model available if needed.
4. The engine runs them: sequential, step time limits, bounded retries for recoverable errors, a result check per
   step, and Cancel (stops the running step and starts no other). Steps that create files (`file.export`) ask the user
   every time, showing what will be saved; the save picker never replaces an existing file.
5. The answer language is the user's choice for the run, or detected from the inputs (Auto). Tools that use the
   model get one language line; English needs none.

Results: **Succeeded** only if every step succeeded; **Not found in documents** when the search found no evidence
(the model is not asked); **Failed** with the step and reason; **Cancelled** (also when a write was not allowed).
Re-run is offered for failed, cancelled or interrupted runs unless a file was already saved; it validates the plan
again and records the run it retries.

Document results keep their references: summaries number the passages they were given and list the cited ones; a
saved report ends with its "Sources:" list. Text rewritten from document-based text (`text.compose`) carries the
sources with a warning to check its claims. Nothing is called evidence-grounded unless retrieval found the passages.

## Drafting a workflow from a description

Workflows → Describe one. The on-device model proposes `{name, steps}` as JSON constrained to registered tools and
enabled skills; the app validates it like an import. If the model is not loaded or its draft is invalid, the reasons
are listed and a draft from the app's rules is offered; requests that start with an action this app can't do
("book", "buy", "send", "call", "install", "schedule", …) are explained instead. A draft is only shown: Save, Edit
before saving, or leave it.

## Storage, history and privacy

Definitions: tables `skills` and `workflows` (schema v7), validated JSON plus enabled/built-in flags. Built-in
examples can be switched off or duplicated, not edited or deleted. Run history uses the existing agent run tables,
with what was run (kind, id, version), a short input summary (80 characters per value, credential-like values
redacted), the answer language and the run it retried. Step results keep summaries, answer text and passage
references, never passage text. "Delete history" on a run screen deletes that definition's runs only; deleting a
definition keeps its history, and never touches chats, documents, vectors or models. Export uses Android's share sheet
or a new file you place; import reads pasted text or a picked file. Nothing is downloaded or uploaded.

## Deferred (not in M6)

Branching, loops, parallel steps, passing results into skill steps (`fromStep` into a skill), more than 6 steps,
per-step output selection beyond the previous step's result, scheduled runs, and any remote catalogue or MCP
integration. The language of a run is applied by an instruction line; whether the 1.5B model follows it in each
language is measured only by the on-phone answer evaluation (not run yet).
