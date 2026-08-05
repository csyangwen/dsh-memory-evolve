/**
 * dsh-memory-evolve — transcript digest builder.
 *
 * Reconstructs a bounded read-only excerpt of a session from its
 * authoritative event log (the reconstruction boundary DSH guarantees), for
 * background memory review. The digest contains ONLY the dialogue — direct
 * human input and the assistant's text replies — with turn markers; tool
 * calls, tool results, reasoning blocks, and system-injected user-role
 * messages never enter it, so a review subagent sees a compact,
 * privacy-bounded transcript of what was actually said.
 *
 * The tail is measured in MESSAGES, not events: a streaming turn appends
 * hundreds of `assistant/chunk` events per assistant message, so an event
 * budget would cover barely the closing chunks of one reply and lose every
 * user message. Only message-level rows (user/assistant/steering) count
 * toward `maxEvents`.
 *
 * Zero runtime dependencies.
 *
 * @module dsh-memory-evolve/digest
 */

/** Default number of trailing MESSAGES to include (≈ 20 turns of dialogue). */
const EVENT_LIMIT_DEFAULT = 40
/** Default total digest length cap (chars). */
const CHARS_LIMIT_DEFAULT = 40_000
/** Per-message text cap before truncation. */
const MESSAGE_CAP = 2000
/** Share of the budget kept for the message tail when truncating. */
const TAIL_RATIO = 0.35

/** Extract the plain text of one message's content blocks (text only). */
function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Truncate long text keeping both its head and its tail: for programming
 * work the decisive content (errors, results, conclusions) often sits at
 * the end, so a head-only cut would drop exactly the information a review
 * needs.
 * @param {string} text - the text to truncate.
 * @param {number} max - the total length budget.
 * @returns {string} the truncated text.
 */
function truncate(text, max) {
  if (text.length <= max) return text
  const head = Math.floor(max * (1 - TAIL_RATIO))
  const tail = max - head - 12
  return `${text.slice(0, head)}…[中间省略 ${text.length - head - tail} 字符]…${text.slice(-tail)}`
}

/**
 * Build the review digest for one session.
 * @param {object} session - a live session (`session.events` must be the
 *   authoritative event log).
 * @param {object} [options] - digest bounds.
 * @param {number} [options.maxEvents=40] - trailing MESSAGES to include
 *   (user/assistant/steering rows).
 * @param {number} [options.maxChars=40000] - total digest cap (chars).
 * @returns {string} the digest; empty when the session has no message rows.
 */
export function buildDigest(session, options = {}) {
  const maxMessages = options.maxEvents ?? EVENT_LIMIT_DEFAULT
  const maxChars = options.maxChars ?? CHARS_LIMIT_DEFAULT
  const events = session?.events
  if (!Array.isArray(events)) return ''

  // One pass over the whole log: reduce to ordered message rows. Message
  // payloads differ per event type — user/message carries the message as
  // `data` itself while assistant/message wraps it in `data.message`.
  const rows = [] // { kind: 'msg', turn, text }
  let turn
  for (const event of events) {
    const data = event.data
    switch (event.type) {
      case 'turn/start':
        turn = data.turn
        break
      case 'user/message':
        // Only direct human input enters the digest: system-injected
        // user-role messages (runtime context, skill catalogs, AGENTS.md
        // instructions, …) are review noise and would drown real dialogue.
        if (data?.source?.kind !== 'user') break
        rows.push({ kind: 'msg', turn, text: `用户: ${truncate(textOf(data.message ?? data), MESSAGE_CAP)}` })
        break
      case 'assistant/message': {
        // Tool-only steps (reasoning + tool-call blocks, no text) produce no
        // dialogue row.
        const text = truncate(textOf(data.message), MESSAGE_CAP)
        if (text) rows.push({ kind: 'msg', turn, text: `助手: ${text}` })
        break
      }
      case 'steering/message':
        rows.push({ kind: 'msg', turn, text: `(steering) ${truncate(textOf(data.message ?? data), MESSAGE_CAP)}` })
        break
      default:
        break
    }
  }

  // Window: the last `maxMessages` message rows.
  const lastMsg = rows.findLastIndex((row) => row.kind === 'msg')
  if (lastMsg < 0) return ''
  let windowStart = 0
  let seen = 0
  for (let index = lastMsg; index >= 0; index -= 1) {
    if (rows[index].kind === 'msg') {
      seen += 1
      if (seen >= maxMessages) {
        windowStart = index
        break
      }
    }
  }
  const window = rows.slice(windowStart)

  const lines = []
  let lastTurn
  for (const row of window) {
    if (row.turn !== undefined && row.turn !== lastTurn) {
      lines.push(`=== turn ${row.turn} ===`)
      lastTurn = row.turn
    }
    lines.push(row.text)
  }
  let text = lines.join('\n')
  if (text.length > maxChars) {
    text = `…(前面部分已省略)…\n${text.slice(-maxChars)}`
  }
  return text
}
