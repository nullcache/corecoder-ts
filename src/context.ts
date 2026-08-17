/**
 * Multi-layer context compression.
 *
 * Claude Code uses a 4-layer strategy (HISTORY_SNIP, Microcompact,
 * CONTEXT_COLLAPSE, Autocompact). CoreCoder distills the same idea to 3:
 *
 *   Layer 1 (snipToolOutputs) — truncate verbose tool results in place
 *   Layer 2 (summarizeOld)    — LLM-powered summary of old turns
 *   Layer 3 (hardCollapse)    — last resort: drop everything except summary + recent
 *
 * Cheapest first: layer 1 costs no model call, layer 2 keeps the recent
 * tail verbatim, layer 3 only fires near the hard limit.
 */

import type { ChatMessage, LLMClient } from './llm.js'
import { drain } from './llm.js'

/** Rough token count — ~3 chars per token for mixed en/zh content. */
function approxTokens(text: string): number {
  return Math.floor(text.length / 3)
}

export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    if (m.content) total += approxTokens(m.content)
    if (m.role === 'assistant' && m.tool_calls) {
      total += approxTokens(JSON.stringify(m.tool_calls))
    }
  }
  return total
}

export class ContextManager {
  readonly maxTokens: number
  private snipAt: number
  private summarizeAt: number
  private collapseAt: number

  /**
   * Calibration factor: estimate × ratio ≈ real tokens. Starts at 1 (pure
   * char-based estimate, the Python original's behavior) and is updated
   * from the API's reported prompt_tokens via observe().
   */
  private ratio = 1

  /**
   * Fixed per-request token overhead: the system prompt plus the tool
   * schemas. The API bills for these on every call, but they're not part of
   * `messages`, so a naive estimate can't see them. Counting them explicitly
   * keeps `ratio` a pure chars-per-token rate. Without this, compression
   * would silently distort the calibration: after layer 2/3 shrink the
   * message list, the fixed overhead makes up a larger share of the real
   * usage, the ratio (calibrated on an unshrunk conversation) overcounts it,
   * and `measure()` underestimates — pushing the compression thresholds
   * later than intended, close to or past the provider's real limit.
   */
  private fixedTokens = 0

  constructor(maxTokens = 128_000) {
    this.maxTokens = maxTokens
    // layer thresholds (fraction of maxTokens)
    this.snipAt = Math.floor(maxTokens * 0.5) // 50% -> snip tool outputs
    this.summarizeAt = Math.floor(maxTokens * 0.7) // 70% -> LLM summarize
    this.collapseAt = Math.floor(maxTokens * 0.9) // 90% -> hard collapse
  }

  /** Register the fixed per-request text (system prompt + tool schemas). */
  setFixedOverhead(text: string): void {
    this.fixedTokens = approxTokens(text)
  }

  /**
   * Calibrate the estimator against the real prompt_tokens the API just
   * reported for `messages`. The char/3 guess is systematically off — CJK
   * text runs ~1 token per char. The fixed overhead is counted explicitly
   * (see setFixedOverhead), so the ratio stays a pure chars-per-token rate
   * and survives compression: shrinking the messages doesn't change what
   * the ratio means.
   */
  observe(realPromptTokens: number, messages: ChatMessage[]): void {
    if (realPromptTokens <= 0) return
    const est = estimateTokens(messages) + this.fixedTokens
    if (est > 0) this.ratio = realPromptTokens / est
  }

  /** Best-available token count: char estimate scaled by observed reality. */
  measure(messages: ChatMessage[]): number {
    return Math.round((estimateTokens(messages) + this.fixedTokens) * this.ratio)
  }


  /** Apply compression layers as needed (mutates `messages` in place). */
  async maybeCompress(
    messages: ChatMessage[],
    llm?: LLMClient,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let current = this.measure(messages)
    let compressed = false

    // Layer 0: a single message so large it alone busts the window can't be
    // helped by any layer below — layer 1 only snips tool replies, layers
    // 2/3 are gated on message *count*. Without this, a huge one-shot prompt
    // 413s on every turn (and /compact can't fix it either).
    if (current > this.collapseAt && this.truncateOversized(messages)) {
      compressed = true
      current = this.measure(messages)
    }

    // Layer 1: snip verbose tool outputs
    if (current > this.snipAt) {
      if (this.snipToolOutputs(messages)) {
        compressed = true
        current = this.measure(messages)
      }
    }

    // Layer 2: LLM-powered summarization of old turns
    if (current > this.summarizeAt && messages.length > 10) {
      if (await this.summarizeOld(messages, llm, 8, signal)) {
        compressed = true
        current = this.measure(messages)
      }
    }

    // Layer 3: hard collapse — last resort
    if (current > this.collapseAt && messages.length > 4) {
      await this.hardCollapse(messages, llm, signal)
      compressed = true
    }

    return compressed
  }

  /**
   * Layer 0: head+tail truncate any single message whose content alone
   * exceeds the hard-collapse threshold. Rare, but the only exit from an
   * otherwise-permanent 413 loop.
   */
  private truncateOversized(messages: ChatMessage[]): boolean {
    // budget in chars: the collapse threshold un-scaled back to chars, split
    // across head and tail. Conservative on purpose.
    const maxChars = Math.max(2000, Math.floor((this.collapseAt / this.ratio) * 3))
    let changed = false
    for (const m of messages) {
      const content = m.content ?? ''
      if (typeof content !== 'string' || content.length <= maxChars) continue
      const half = Math.floor(maxChars / 2)
      m.content =
        content.slice(0, half) +
        `\n... (${content.length} chars, middle truncated to fit the context window) ...\n` +
        content.slice(-half)
      changed = true
    }
    return changed
  }

  /**
   * Layer 1: truncate tool results over 1500 chars to their first/last lines.
   * Mirrors Claude Code's HISTORY_SNIP.
   */
  private snipToolOutputs(messages: ChatMessage[]): boolean {
    let changed = false
    for (const m of messages) {
      if (m.role !== 'tool') continue
      const content = m.content ?? ''
      if (content.length <= 1500) continue
      const lines = content.split('\n')
      if (lines.length <= 6) continue
      // keep first 3 + last 3 lines
      m.content =
        lines.slice(0, 3).join('\n') +
        `\n... (${lines.length} lines, snipped to save context) ...\n` +
        lines.slice(-3).join('\n')
      changed = true
    }
    return changed
  }

  /**
   * Index where the kept tail should start.
   *
   * Walk the boundary back so a 'tool' result is never separated from the
   * assistant message whose tool_calls produced it — an orphaned tool
   * message has no preceding tool_calls and OpenAI-compatible APIs reject it.
   */
  private safeSplit(messages: ChatMessage[], keepRecent: number): number {
    let split = Math.max(0, messages.length - keepRecent)
    while (split > 0 && messages[split]!.role === 'tool') split--
    return split
  }

  /** Layer 2: summarize old conversation, keep recent messages intact. */
  private async summarizeOld(
    messages: ChatMessage[],
    llm: LLMClient | undefined,
    keepRecent = 8,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (messages.length <= keepRecent) return false

    const split = this.safeSplit(messages, keepRecent)
    const old = messages.slice(0, split)
    const tail = messages.slice(split)

    const summary = await this.getSummary(old, llm, signal)

    messages.length = 0
    messages.push({
      role: 'user',
      content: `[Context compressed - conversation summary]\n${summary}`,
    })
    messages.push({
      role: 'assistant',
      content: 'Got it, I have the context from our earlier conversation.',
    })
    messages.push(...tail)
    return true
  }

  /** Layer 3: emergency compression. Keep only last 4 messages + summary. */
  private async hardCollapse(
    messages: ChatMessage[],
    llm?: LLMClient,
    signal?: AbortSignal,
  ): Promise<void> {
    const split = this.safeSplit(messages, messages.length > 4 ? 4 : 2)
    const tail = messages.slice(split)
    const summary = await this.getSummary(messages.slice(0, split), llm, signal)

    messages.length = 0
    messages.push({ role: 'user', content: `[Hard context reset]\n${summary}` })
    messages.push({
      role: 'assistant',
      content: 'Context restored. Continuing from where we left off.',
    })
    messages.push(...tail)
  }

  /** Generate a summary via the LLM, falling back to plain extraction. */
  private async getSummary(
    messages: ChatMessage[],
    llm?: LLMClient,
    signal?: AbortSignal,
  ): Promise<string> {
    const flat = this.flatten(messages)

    if (llm) {
      try {
        // the signal makes the summarization call — and its retry backoffs —
        // cancellable; without it a ^C is dead for the whole compression
        const resp = await drain(
          llm.chat([
            {
              role: 'system',
              content:
                'Compress this conversation into a brief summary. ' +
                'Preserve: file paths edited, key decisions made, ' +
                'errors encountered, current task state. ' +
                'Drop: verbose command output, code listings, ' +
                'redundant back-and-forth.',
            },
            { role: 'user', content: flat.slice(0, 15_000) },
          ], undefined, signal),
        )
        return resp.content
      } catch (e) {
        // cancellation is control flow, not a summarization failure
        if (e instanceof Error && e.name === 'AbortError') throw e
        // anything else: fall through to extraction
      }
    }

    return this.extractKeyInfo(messages)
  }

  private flatten(messages: ChatMessage[]): string {
    const parts: string[] = []
    for (const m of messages) {
      const text = m.content ?? ''
      if (text) parts.push(`[${m.role}] ${text.slice(0, 400)}`)
    }
    return parts.join('\n')
  }

  /** Fallback: extract file paths and error lines without an LLM. */
  private extractKeyInfo(messages: ChatMessage[]): string {
    const filesSeen = new Set<string>()
    const errors: string[] = []

    for (const m of messages) {
      const text = m.content ?? ''
      for (const match of text.matchAll(/[\w./\-]+\.\w{1,5}/g)) {
        filesSeen.add(match[0])
      }
      for (const line of text.split('\n')) {
        if (line.toLowerCase().includes('error')) {
          errors.push(line.trim().slice(0, 150))
        }
      }
    }

    const parts: string[] = []
    if (filesSeen.size > 0) {
      parts.push(`Files touched: ${[...filesSeen].sort().slice(0, 20).join(', ')}`)
    }
    if (errors.length > 0) {
      parts.push(`Errors seen: ${errors.slice(0, 5).join('; ')}`)
    }
    return parts.join('\n') || '(no extractable context)'
  }
}
