# Evaluation (M5)

Three versioned, human-reviewable datasets and the code that measures the app against them. Scores are
measurements of this small dataset, not proof of quality: the datasets are small (42 / 35 / 30 cases), written for this
project, and need native-speaker review. No generated answer is treated as ground truth.

| Dataset | What it measures | Runs where | Checks |
|---|---|---|---|
| `datasets/language-v1.json` | Which language the answer should be in (single messages, follow-ups, switches, mixed and romanized text) | laptop (`npm run eval`) | deterministic: exact language code |
| `datasets/retrieval-v1.json` | Document retrieval: 10 documents in 6 languages, 35 queries (exact, inflected, paraphrase, synonym, cross-language, mixed, no evidence, duplicate) | laptop (`npm run eval`; embeddings via `scripts/eval-embeddings.ps1`) | deterministic: hit@1, hit@3, MRR (document level), false evidence on unanswerable queries, missed evidence, duplicate pair in top 3 |
| `datasets/answers-v1.json` | Model answers in 6 languages: explanation, summary, translation, multi-part, follow-up, switch, documents with fixed passages, insufficient evidence, cross-language | **phone** (Agents → Model evaluation, or `scripts/device-check.ps1 -Eval`) | automated and approximate: script share, citation numbers valid, cites a source, "not found" phrase, required facts by keyword. Correctness/faithfulness: human review of the listed answers |

## How to reproduce

```powershell
npm run eval                                          # language + keyword retrieval -> eval/results/*-current.md
$env:EVAL_LABEL='mine'; npm run eval                  # label the report
powershell -ExecutionPolicy Bypass -File scripts\eval-embeddings.ps1   # + meaning-only and hybrid retrieval
powershell -ExecutionPolicy Bypass -File scripts\device-check.ps1 -DriveUi -Eval   # answers on the phone
```

`npm run eval` runs `eval/*.eval.ts` with the app's own modules (Jest, node:sqlite; no model). Reports go to
`eval/results/<name>-<label>.md` (JSON copies are git-ignored). The retrieval run indexes the corpus with the app's
chunker and SQLite index, exactly as an import does.

## Results (laptop, 2026-10-10)

### Language (dataset v1, 42 cases, 9 marked hard)

| Code | Correct | Hard cases |
|---|---|---|
| M4 baseline | 33/42 | 0/9 |
| M5 | 42/42 | 9/9 |

Baseline failures: an English sentence quoting one Telugu/Hindi/Tamil word was answered in that language; romanized
Tamil/Kannada/Malayalam were not recognized; "Tamil la sollu", "kannada alli heli", "malayalam il parayu" were not
recognized as switches. Fixes: the script must be at least a third of the words (or already the conversation's
language); marker-word lists for romanized ta/kn/ml (disjoint, no English words); the three switch forms.
**Caveat:** the hard cases were written while studying the weaknesses, so 42/42 overstates real-world accuracy; the
unit tests add guards (e.g. "Which IDE…" stays English, one marker word is not enough).

### Retrieval (dataset v1, 28 answerable + 7 unanswerable queries, document level)

| Variant | hit@1 | hit@3 | MRR | Missed evidence | False evidence | Duplicate pair in top 3 |
|---|---|---|---|---|---|---|
| Keyword, M4 baseline | 0.643 | 0.643 | 0.643 | 0.286 | 0.286 | 1/1 |
| Keyword, M5 | 0.714 | 0.714 | 0.714 | 0.357 | **0** | 0/1 |
| Meaning only (e5-small) | 0.893 | **1.0** | 0.940 | 0 | 0 | 0/1 |
| **Hybrid (M5 with meaning search)** | **0.893** | **1.0** | **0.940** | **0** | **0** | 0/1 |

By kind, hybrid vs M5 keyword: inflected 1.0 / 1.0 (baseline 0.6), synonym 1.0 / 0.33, cross-language 1.0 / 0 (hit@3;
hit@1 0.5), paraphrase and exact 1.0 / 1.0. Keyword M5's extra missed evidence (0.357 vs 0.286) is the price of the
evidence rule that removed all false evidence: with keywords only, the app prefers "not found" to answering from a
passage that shares one common word. Laptop latency is not meaningful for the phone and is not reported as such.

Keyword changes (all measured above): zero-width joiners removed and Malayalam chillu letters unified (index and
query alike, `TOKENIZER_VERSION` 2 rebuilds existing indexes); question words and postpositions of the five Indian
languages dropped from queries (never from the index); a prefix match on the first 60% of long Indian-language query
words for other word forms (no stemming, the index text is never changed); an evidence rule (a passage must match half
the query's words or two of them); near-duplicate passages (token Jaccard ≥ 0.85) shown once; at most two passages
per document before other documents get a turn in the model's context.

### Semantic evidence threshold

e5 similarities sit in a narrow band. On this dataset the best cosine per query was ≥ 0.781 for every answerable
query and ≤ 0.747 for every unanswerable one; the threshold `SEMANTIC_EVIDENCE = 0.77` sits in that gap (0.84 was tried
first: 25% missed evidence). 35 queries is a thin basis: expect to re-calibrate on real documents.

### Answers on the phone

Not run yet (the phone was not connected during M5). The dataset, checks and runner are in place; run
`device-check.ps1 -DriveUi -Eval` and review `eval-answers.jsonl`. Until then nothing is claimed about answer quality
per language. When a language does badly, compare its docs cases (fixed gold passages: model/prompt problem) with its
retrieval results (retrieval problem) before changing prompts.

## Embedding model selection

Requirements: under 4B parameters, the six languages, a license allowing use, a GGUF that runs on **the llama.cpp
inside llama.rn 0.12.9 (build b10256)**, small enough to sit next to the 1.5B chat model on ordinary phones.

| Candidate | Size | License | Six languages | Verdict |
|---|---|---|---|---|
| **multilingual-e5-small** (intfloat) | 118M params, Q8_0 132 MB | MIT | yes (model tags te, hi, ta, kn, ml) | **chosen** |
| Qwen3-Embedding-0.6B (official GGUF) | 600M, Q8_0 639 MB | Apache-2.0 | multilingual (claimed) | too large next to the chat model for ordinary phones; revisit if e5 proves too weak on the phone |
| bge-m3 | 568M | MIT | yes | same size problem; no official GGUF |
| EmbeddingGemma-300M | 300M | Gemma terms, gated | – | excluded: gated, non-OSI license |
| paraphrase-multilingual-MiniLM-L12-v2 | 118M | Apache-2.0 | only Hindi of the five | excluded: language coverage |

Runtime: llama.rn 0.12.9 exposes `initLlama({ embedding: true, pooling_type })` and `context.embedding()`, and its
bundled llama.cpp (build 10256) has the BERT/XLM-R architectures and the UGM/SPM tokenizers. The laptop evaluation
uses the same llama.cpp build (`llama-b10256-bin-win-cpu-x64`), so model-file compatibility findings carry over to the
phone; speed, memory and heat do not.

**Compatibility findings for e5-small GGUF files** (none of the conversions is from Microsoft/intfloat):

| File | sha256 (prefix) | On llama.cpp b10256 |
|---|---|---|
| `cstr/multilingual-e5-small-GGUF` q8_0 (most downloaded) | 0a34067a… | **does not load**: "bert model needs to define token type count" (made by an older converter) |
| `keisuke-miyako/multilingual-e5-small-gguf-q8_0` | 0d5a5a0b… | loads, but **wrong tokenizer**: BERT WordPiece ids (101/102, most words → [UNK] 100) for an XLM-R model; useless embeddings |
| **`TwinSunsLLC/multilingual-e5-small-gguf` q8_0** | e011debc… | loads; XLM-R SentencePiece ids (`<s>`=0, `</s>`=2, whole Telugu words); results above. Its README documents mean pooling and a Q8_0-vs-f16 check |

Provenance and license record: base model intfloat/multilingual-e5-small, MIT; GGUF conversion and Q8_0 quantization
by TwinSunsLLC (third party); file
`https://huggingface.co/TwinSunsLLC/multilingual-e5-small-gguf/resolve/main/multilingual-e5-small-q8_0.gguf`,
132,439,008 bytes, sha256 `e011debc1208e31bf7b6aebee2d9fc8bd2ca11694a77ed66ac9d0c9d0a877c93` (checked by the app before
use). Not independently verified against the original PyTorch model (no PyTorch on the laptop); the tokenizer check
and the retrieval results are the evidence that it behaves as an XLM-R e5 model.

## Decision

Adopt multilingual-e5-small as **optional** meaning search (hybrid with keyword search), downloaded only when the user
asks. Keyword search stays the default and the fallback. Deferred to the phone: embedding speed per passage, load time,
extra memory next to the chat model (estimate ~150–200 MB: a 132 MB file plus a 512-token context; not measured),
battery and heat while building an index. If those are poor, meaning search stays off by default or moves to
building only while charging.
