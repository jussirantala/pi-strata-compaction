// Summarises every compaction (auto and /compact) with the local Strata model instead of the
// session's model: the claude-bridge summary of a session this long times out.
// The context window configured for the model in pi's models.json is smaller than a long session, so
// the history is summarised in chunks, each one folded into the running summary with pi's own update
// prompt. The chunk size is derived from that context window. Any failure returns nothing, which makes
// pi fall back to its default compaction.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { convertToLlm, generateSummaryWithUsage, serializeConversation } from "@earendil-works/pi-coding-agent"
import { contentText } from "@earendil-works/pi-ai/compat"

// Strata ignores length instructions (asked for 3,000 words, it rewrote a 42k-token summary until the 16k cap),
// so the previous summary is trimmed here. Appended sections keep their newest lines; Goal and Next Steps,
// which put the most important items first, keep their first lines. Strata copies the trimmed summary into
// its output before adding new items, so this bounds the copy: at 6k per section the copy took ~12k of the
// 16k-token cap and the next fold ran out.
const SECTION_CHARS = 3_000
// The file lists this extension appends; they are carried over from the previous compaction's details instead.
const FILE_BLOCKS = /\n*<(read|modified)-files>[\s\S]*?<\/\1-files>/g
const SECTIONS = /\n(?=#{2,3} )/
const DROPPED = "- (entries dropped to keep the summary short)"

export function trimSummary(summary: string): string {
  return summary
    .replace(FILE_BLOCKS, "")
    .split(SECTIONS)
    .map((section) => {
      if (section.length <= SECTION_CHARS) return section
      // Strata copies the marker into its reply, so old ones are removed before a new one is added.
      const [heading, ...lines] = section.split("\n").filter((line) => line !== DROPPED)
      const headFirst = /^## (Goal|Next Steps)/.test(heading)
      if (!headFirst) lines.reverse()
      const kept: string[] = []
      let size = 0
      for (const line of lines) {
        if (size + line.length >= SECTION_CHARS) break
        kept.push(line)
        size += line.length + 1
      }
      // A single line longer than the limit is cut rather than emptying the section (blank lines don't count).
      if (!kept.some((line) => line.trim())) {
        const line = lines.find((line) => line.trim())
        if (line) kept.push(line.slice(0, SECTION_CHARS))
      }
      if (!headFirst) kept.reverse()
      return [heading, DROPPED, ...kept].join("\n")
    })
    .join("\n")
}

// Strata sometimes repeats one line until the token cap (497 copies of one Blocked item). Its reply is kept
// up to there without the repeats, and the sections it never reached come from the previous summary.
// shortcut: those sections miss this chunk's news until the next compaction; re-ask for them if that hurts.
export function salvage(reply: string, previous = ""): string {
  const lines = [...new Set(reply.split("\n").slice(0, -1))]
  const missing = trimSummary(previous)
    .split(SECTIONS)
    .filter((section) => section.trim() && !lines.includes(section.split("\n", 1)[0]))
  return [lines.join("\n").trimEnd(), ...missing].join("\n\n")
}

// pi >= 1.4 ignores reserveTokens and caps the output at model.maxTokens, so the cap is set on the model.
// A normal summary is ~8k tokens; the cap only bounds how long a repeating reply runs (~3 min).
const MAX_SUMMARY_TOKENS = 16_384
// 120k characters measured ~30-40k tokens on this model, i.e. ~3-4 characters per token; 3 is the
// conservative side of that range.
const CHARS_PER_TOKEN = 3
// What has to fit in the context window next to the chunk: the previous summary plus pi's update prompt.
// pi's summary format has 9 sections, each trimmed to ~SECTION_CHARS, plus ~1k tokens for pi's prompt.
const SUMMARY_TOKENS = Math.ceil((9 * SECTION_CHARS) / CHARS_PER_TOKEN) + 1_024
// A context window small enough to leave nothing after the summary and prompt would give a zero or
// negative chunk; this is the floor it falls back to.
const MIN_CHUNK_CHARS = 8_000

// The estimate is rough, and a chunk that overflows costs a failed round trip plus the half-split
// retry below, so only half the remaining window is used. For a 100k-token window that is ~110k
// characters, close to the 120k that was measured safe on this model.
const MARGIN = 0.5

// Which model to summarise with. Unset means the first chat model the local Strata provider serves, not
// a model named strata; anyone whose model sits under another provider, or who has several configured
// under strata, sets STRATA_COMPACT_MODEL="provider/id" in the environment.
const MODEL_REF = process.env.STRATA_COMPACT_MODEL || ""

function chunkSize(model: { contextWindow: number }): number {
  // STRATA_COMPACT_CHUNK_CHARS wins over the computed size, but only as a positive number; NaN, 0 and
  // negatives fall back to it, and a small value is still held to the floor below.
  const override = Number(process.env.STRATA_COMPACT_CHUNK_CHARS)
  if (override > 0) return Math.max(override, MIN_CHUNK_CHARS)
  return Math.max(MIN_CHUNK_CHARS, Math.floor((model.contextWindow - MAX_SUMMARY_TOKENS - SUMMARY_TOKENS) * CHARS_PER_TOKEN * MARGIN))
}

type Messages = Parameters<typeof generateSummaryWithUsage>[0]

function chunk(messages: Messages, chunkChars: number): Messages[] {
  const chunks: Messages[] = []
  let current: Messages = []
  let size = 0
  for (const message of messages) {
    const length = serializeConversation(convertToLlm([message])).length
    if (current.length > 0 && size + length > chunkChars) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(message)
    size += length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal, customInstructions } = event
    // A model id may itself contain "/", so only the first one splits the reference.
    const [provider, ...idParts] = MODEL_REF.split("/")
    const model = MODEL_REF
      ? ctx.modelRegistry.find(provider, idParts.join("/"))
      : ctx.modelRegistry.getModelsOfType("chat", "strata")[0]
    if (!model) {
      const wanted = MODEL_REF ? `model "${MODEL_REF}"` : `chat model from the "strata" provider`
      ctx.ui.notify(`Strata compaction: no ${wanted} in the registry; using the default`, "warning")
      return
    }
    const strata = { ...model, maxTokens: MAX_SUMMARY_TOKENS }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
    if (!auth.ok) {
      ctx.ui.notify(`Strata compaction: no credentials for ${model.provider}/${model.id} (${auth.error}); using the default`, "warning")
      return
    }

    const summarise = async (messages: Messages, previous: string | undefined, split = false): Promise<string> => {
      // pi throws away a reply that hit the token cap, so its stream is kept here to read it afterwards.
      let reply: ReturnType<ReturnType<typeof ctx.modelRegistry.streamSimple>["result"]> | undefined
      try {
        // "minimal" maps to Strata's "none": no thinking, so the whole token cap goes to the summary.
        const result = await generateSummaryWithUsage(
          messages, strata, MAX_SUMMARY_TOKENS, auth.apiKey, auth.headers, signal, customInstructions,
          previous && trimSummary(previous),
          "minimal",
          // The compat streamSimple cannot see providers registered by extensions; the registry one can.
          (...args: Parameters<typeof ctx.modelRegistry.streamSimple>) => {
            const stream = ctx.modelRegistry.streamSimple(...args)
            reply = stream.result()
            return stream
          },
          auth.env,
        )
        // An empty summary would make the next fold use the fresh-summary prompt and silently drop all earlier history.
        if (!result.text.trim()) throw new Error("Strata returned an empty summary")
        return result.text
      } catch (error) {
        const cut = await reply
        if (cut?.stopReason === "length" && contentText(cut.content).trim()) {
          const kept = salvage(contentText(cut.content), previous)
          // An empty salvage would drop the history the next fold relies on, so retry the chunk instead.
          if (kept.trim()) {
            ctx.ui.notify("Strata compaction: the reply hit the token cap; kept it up to there", "warning")
            return kept
          }
        }
        // A chunk Strata could not finish is retried once as two halves; splitting further would repeat
        // the same failing full-length rewrite for hours.
        if (signal.aborted || messages.length < 2 || split) throw error
        const half = Math.ceil(messages.length / 2)
        return summarise(messages.slice(half), await summarise(messages.slice(0, half), previous, true), true)
      }
    }

    try {
      const chunks = chunk([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages], chunkSize(model))
      let summary = preparation.previousSummary
      for (const [index, messages] of chunks.entries()) {
        signal.throwIfAborted()
        ctx.ui.notify(`Strata compaction: part ${index + 1}/${chunks.length}`, "info")
        summary = await summarise(messages, summary)
      }
      if (!summary?.trim()) {
        ctx.ui.notify("Strata compaction: empty summary; using the default", "warning")
        return
      }

      const { fileOps } = preparation
      // pi leaves out the file lists of an extension's compaction (fromHook), so carry the last ones forward.
      // details is writable by any extension, so only an actual list is carried over.
      const last = event.branchEntries.findLast((entry) => entry.type === "compaction")?.details as
        { readFiles?: string[]; modifiedFiles?: string[] } | undefined
      const modifiedFiles = [
        ...new Set([...fileOps.edited, ...fileOps.written, ...(last && Array.isArray(last.modifiedFiles) ? last.modifiedFiles : [])]),
      ].sort()
      const readFiles = [...new Set([...fileOps.read, ...(last && Array.isArray(last.readFiles) ? last.readFiles : [])])]
        .filter((file) => !modifiedFiles.includes(file))
        .sort()
      const sections = [
        readFiles.length > 0 && `<read-files>\n${readFiles.join("\n")}\n</read-files>`,
        modifiedFiles.length > 0 && `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
      ].filter(Boolean)
      if (sections.length > 0) summary += `\n\n${sections.join("\n\n")}`

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      }
    } catch (error) {
      if (!signal.aborted) {
        ctx.ui.notify(`Strata compaction failed, using the default: ${error instanceof Error ? error.message : String(error)}`, "warning")
      }
    }
  })
}
