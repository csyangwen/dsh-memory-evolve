/**
 * dsh-memory-evolve — transcript digest builder.
 *
 * Reconstructs a bounded read-only excerpt of a session from its
 * authoritative event log (the reconstruction boundary DSH guarantees), for
 * background memory review. The digest only contains the tail of the log,
 * tool outputs are hidden unless explicitly enabled, and total length is
 * capped — so a review subagent sees a compact, privacy-bounded transcript.
 *
 * Zero runtime dependencies.
 *
 * @module dsh-memory-evolve/digest
 */

/** Default number of trailing events to include. */
const EVENT_LIMIT_DEFAULT = 24
/** Default total digest length cap (chars). */
const CHARS_LIMIT_DEFAULT = 12_000
/** Per-message text cap before truncation. */
const MESSAGE_CAP = 600
/** Tool-argument cap in the call line. */
const ARGUMENT_CAP = 200
/** Tool-output cap when outputs are included. */
const OUTPUT_CAP = 300

/** Extract the plain text of one message's content blocks. */
function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool-call') return `[工具调用: ${block.name}]`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Truncate long text with an ellipsis. */
function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/**
 * Build the review digest for one session.
 * @param {object} session - a live session (`session.events` must be the
 *   authoritative event log).
 * @param {object} [options] - digest bounds.
 * @param {number} [options.maxEvents=24] - trailing events to include.
 * @param {number} [options.maxChars=12000] - total digest cap (chars).
 * @param {boolean} [options.includeToolOutput=false] - include tool result
 *   content (off by default for privacy).
 * @returns {string} the digest; empty when the session has no events.
 */
export function buildDigest(session, options = {}) {
  const maxEvents = options.maxEvents ?? EVENT_LIMIT_DEFAULT
  const maxChars = options.maxChars ?? CHARS_LIMIT_DEFAULT
  const includeToolOutput = options.includeToolOutput ?? false
  const events = session?.events
  if (!Array.isArray(events)) return ''
  const tail = events.slice(-maxEvents)
  const lines = []
  for (const event of tail) {
    const data = event.data
    switch (event.type) {
      case 'turn/start':
        lines.push(`=== turn ${data.turn} (${data.trigger.kind}) ===`)
        break
      case 'user/message':
        lines.push(`用户: ${truncate(textOf(data.message), MESSAGE_CAP)}`)
        break
      case 'assistant/message':
        lines.push(`助手: ${truncate(textOf(data.message), MESSAGE_CAP)}`)
        break
      case 'steering/message':
        lines.push(`(steering) ${truncate(textOf(data.message), MESSAGE_CAP)}`)
        break
      case 'tool/call':
        lines.push(`工具调用: ${data.name}(${truncate(String(data.arguments), ARGUMENT_CAP)})`)
        break
      case 'tool/result': {
        const failure = data.error ? ` 失败(${data.error.code ?? 'error'})` : ' 成功'
        const output = includeToolOutput ? truncate(textOf(data.message), OUTPUT_CAP) : ''
        lines.push(`工具结果:${failure}${output ? ` ${output}` : ''}`)
        break
      }
      default:
        break
    }
  }
  let text = lines.join('\n')
  if (text.length > maxChars) {
    text = `…(前面部分已省略)…\n${text.slice(-maxChars)}`
  }
  return text
}
