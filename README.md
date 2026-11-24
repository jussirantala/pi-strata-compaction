# pi-strata-compaction

A [pi](https://github.com/earendil-works/pi) extension that writes **session compaction summaries with a local [Strata](https://strata.sh) model** instead of the model the session is running on.

It does not change *when* pi compacts or *which* messages are kept. It only replaces the summariser, and falls back to pi's default on any failure.

## Why

pi writes compaction summaries with the session model. On a long session that is tens of thousands of input tokens plus a long summary output, billed against your own API or subscription, and it is paid again on every automatic compaction. With a `claude-bridge` session model the summary request times out outright. Doing that one job with a local Strata model costs no paid tokens and keeps the paid budget for real work.

A long session is bigger than the context window configured for the model in pi's `models.json`, so the history is summarised in chunks and each chunk is folded into the running summary using pi's own update prompt. The chunk size is derived from that configured context window.

## Install

```bash
pi install git:github.com/jussirantala/pi-strata-compaction
```

Or, for one session only:

```bash
pi -e git:github.com/jussirantala/pi-strata-compaction
```

To hack on it locally, load the folder as a package:

```bash
pi install ./pi-strata-compaction
```

## Requirements

- A Strata server running locally, and a provider named `strata` in pi's `models.json`: the extension uses the model that provider serves, whatever its id is. `STRATA_COMPACT_MODEL="provider/id"` picks another provider, or one specific model when several are configured. If the lookup fails the extension shows a warning and pi uses its default compaction. The model's `contextWindow` in `models.json` is what the chunking is sized from; a small value produces small chunks.
- pi 1.4 or newer: since 1.4 pi ignores `reserveTokens` and caps output at `model.maxTokens`, so the extension sets that cap on a copy of the model itself.
- For the thinking setting to take effect, the model needs `"reasoning": true` in `models.json`, and a `thinkingLevelMap` that maps `minimal` to the server's no-thinking value (for Strata: `"minimal": "none"`). Without `reasoning: true` pi sends no thinking setting at all and the server's default applies.

## What it does

1. Hooks `session_before_compact`, so it covers both automatic compaction and `/compact`.
2. Sizes each chunk from the `contextWindow` configured for the model: `(contextWindow - MAX_SUMMARY_TOKENS - SUMMARY_TOKENS) * 3 * 0.5` characters, with a floor so a small window still gets a usable chunk. `SUMMARY_TOKENS` is the reserve for the previous summary and pi's prompt, about 10k tokens. `STRATA_COMPACT_CHUNK_CHARS` overrides the computed size only when it is a positive number, and never below the 8,000-character floor. The chunks are summarised one at a time, each fold receiving the previous summary.
3. Trims the previous summary before sending it (`trimSummary`): Strata ignores length instructions and rewrote a 42k-token summary until it hit the token cap. Appended sections keep their newest lines; `Goal` and `Next Steps`, which list the most important items first, keep their first lines.
4. Keeps the reply when it runs out of tokens (`salvage`): Strata sometimes repeats one line until the cap, and pi throws away a capped reply. The repeats are removed and the sections it never reached are carried over from the previous summary.
5. Retries a failed chunk once as two halves.
6. Re-appends the `<read-files>` / `<modified-files>` blocks. pi leaves out the file lists supplied by an extension's compaction, so the previous compaction's lists are carried forward and merged with the current ones.
7. Every fallback to pi's default compaction shows a warning: missing model, missing credentials, empty summary, or any other error.

Progress is reported as `Strata compaction: part 1/3`.

## Tuning

| Setting | Where | Notes |
|---|---|---|
| Chunk size | computed from the model's `contextWindow` in `models.json`; `STRATA_COMPACT_CHUNK_CHARS` env var overrides it when it is a positive number | Default is `(contextWindow - MAX_SUMMARY_TOKENS - SUMMARY_TOKENS) * 3 * 0.5` characters, floored at `8_000`: the chunk must share the window with the previous summary, the prompt and the reply, and the half is the safety margin for a rough estimate. `SUMMARY_TOKENS` is that reserve for the previous summary and pi's prompt, about 10k tokens. An override is raised to the 8,000-character floor; `0`, a negative number or something unparseable falls back to the computed size. 120k characters measured ~30-40k tokens on this model, hence 3 characters per token; for a 100k-token window the default is ~110k characters. |
| Section budget | `SECTION_CHARS` in the source, default `3_000` | Bounds the summary Strata copies into each fold. At 6k per section the copy filled the 16k token cap and the next fold ran out. |
| Output cap | `MAX_SUMMARY_TOKENS` in the source, default `16_384` | A normal summary is ~8k tokens; this only bounds how long a repeating reply runs. |
| Summarising model | `STRATA_COMPACT_MODEL` env var, default: the first chat model of the `strata` provider | Format `provider/id`; only the first `/` splits, so a model id may contain one. Unset, any id served by the `strata` provider works. Set it for another provider, or to choose one model when several are configured; its `contextWindow` is what the chunking is sized from. If the lookup fails the extension shows a warning and pi uses its default compaction. |

Thinking is requested at `minimal`; with the `thinkingLevelMap` above that is Strata's `none`, so the whole token cap goes to the summary.

## Known limits

- The summary is only as good as Strata's. It is noticeably terser than a frontier-model summary.
- Sections Strata never reached in a capped reply miss that chunk's news until the next compaction.
- A split turn (compaction in the middle of a long turn) is summarised together with the history; pi's own compaction gives the start of that turn its own summary, this extension does not.
- Compaction takes minutes on a local server, not seconds, on a long session.
