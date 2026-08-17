/**
 * Core agent loop.
 *
 * This is the heart of CoreCoder-TS. The pattern is simple:
 *
 *     user message -> LLM (with tools) -> tool calls? -> execute -> loop
 *                                       -> text reply? -> return to user
 *
 * It keeps looping until the LLM responds with plain text (no tool calls),
 * which means it's done working and ready to report back.
 *
 * One deliberate departure from the Python original: instead of on_token /
 * on_tool callbacks, chat() is an async generator of AgentEvents that
 * *returns* the final answer — the exact yield/return dual-channel shape
 * of Claude Code's own query loop (see query.ts in the recovered source):
 *
 *     AsyncGenerator<AgentEvent, string>
 *                    ^ live progress  ^ final answer
 *
 * Consumers `for await` the events for rendering; cancellation flows in
 * through an AbortSignal (the idiomatic stand-in for Python's
 * KeyboardInterrupt).
 */

import { ContextManager } from './context.js'
import type { ChatMessage, LLMClient, LLMResponse, ToolCallReq, ToolSchema } from './llm.js'
import { missingArgs, toSchema, type Tool } from './tools/base.js'
import { SubAgentTool } from './tools/agent.js'
import { makeAllTools } from './tools/index.js'
import { systemPrompt } from './prompt.js'

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; name: string; result: string }

export interface AgentOptions {
  llm: LLMClient
  tools?: Tool[]
  maxContextTokens?: number
  maxRounds?: number
}

export class Agent {
  llm: LLMClient
  tools: Tool[]
  messages: ChatMessage[] = []
  context: ContextManager
  maxRounds: number

  private toolByName: Map<string, Tool>
  private system: string

  constructor(opts: AgentOptions) {
    this.llm = opts.llm
    // fresh instances by default — see makeAllTools() on why sharing breaks
    this.tools = opts.tools ?? makeAllTools()
    this.toolByName = new Map(this.tools.map(t => [t.name, t]))
    this.context = new ContextManager(opts.maxContextTokens ?? 128_000)
    this.maxRounds = opts.maxRounds ?? 50
    this.system = systemPrompt(this.tools)

    // wire up sub-agent capability
    for (const t of this.tools) {
      if (t instanceof SubAgentTool) t.parentAgent = this
    }

    // the API bills for the system prompt and tool schemas on every call;
    // count them as fixed overhead so the compressor's calibration doesn't
    // underestimate once the conversation gets shrunk (see context.ts)
    this.context.setFixedOverhead(this.system + '\n' + JSON.stringify(this.toolSchemas()))
  }

  private fullMessages(): ChatMessage[] {
    return [{ role: 'system', content: this.system }, ...this.messages]
  }

  private toolSchemas(): ToolSchema[] {
    return this.tools.map(toSchema)
  }

  /**
   * Process one user message. May involve multiple LLM/tool rounds.
   * Yields progress events; returns the model's final text answer.
   */
  async *chat(userInput: string, signal?: AbortSignal): AsyncGenerator<AgentEvent, string> {
    // A single message larger than the whole context window can never be
    // sent — no compression layer can shrink *one* message, so it would just
    // 413 on every turn. Refuse up front and keep it out of the history.
    // measure() includes the fixed system-prompt/tool-schema overhead.
    const inputTokens = this.context.measure([{ role: 'user', content: userInput }])
    if (inputTokens > this.context.maxTokens) {
      return (
        `Error: this message is ~${inputTokens} tokens, larger than the ` +
        `${this.context.maxTokens}-token context window. Shorten the input or raise CORECODER_MAX_CONTEXT.`
      )
    }

    this.messages.push({ role: 'user', content: userInput })
    await this.context.maybeCompress(this.messages, this.llm, signal)

    try {
      // yield* forwards every event and evaluates to rounds()'s return value
      return yield* this.rounds(signal)
    } catch (e) {
      // Ctrl+C while the model was mid-reply leaves the user message with no
      // assistant answer at all. Mark it cancelled — a bare unanswered request
      // makes the next turn's model pick the dead task back up. (Tool-phase
      // aborts already leave '[interrupted]' tool replies, see below.)
      if (signal?.aborted && this.messages.at(-1)?.role === 'user') {
        this.messages.push({ role: 'assistant', content: '[interrupted by user]' })
      }
      throw e
    } finally {
      // A consumer can abandon the generator between yields (for-await break,
      // .return(), an exception in its own loop body). None of those unwind
      // through the catch above, but this finally still runs — backfill any
      // tool_calls the abandoned turn left unanswered, or the history is
      // permanently rejected by the API. No-op on a normal return.
      this.answerAbandonedToolCalls()
    }
  }

  /** Backfill replies for a trailing assistant tool_calls message (see chat's finally). */
  private answerAbandonedToolCalls(): void {
    // skip tool replies already recorded after the assistant message — the
    // consumer may have abandoned the turn after some, but not all, replies
    let i = this.messages.length - 1
    while (i >= 0 && this.messages[i]!.role === 'tool') i--
    const m = i >= 0 ? this.messages[i] : undefined
    if (!m || m.role !== 'assistant' || !m.tool_calls?.length) return
    // answerPendingToolCalls skips ids that already have replies, so this is
    // a no-op for completed turns and fills exactly the gaps otherwise
    this.answerPendingToolCalls(
      m.tool_calls.map(tc => ({ id: tc.id, name: tc.function.name, arguments: {} })),
    )
  }

  /** The LLM/tool loop behind chat(); split out so chat() can wrap it in one try. */
  private async *rounds(signal?: AbortSignal): AsyncGenerator<AgentEvent, string> {
    for (let round = 0; round < this.maxRounds; round++) {
      // Stream the model's reply, re-wrapping each text delta as an event.
      // Driven by hand (not yield*) because the inner generator yields bare
      // strings while we yield typed events — the .done/.value dance below
      // is exactly what yield* does under the hood.
      const stream = this.llm.chat(this.fullMessages(), this.toolSchemas(), signal)
      let step: IteratorResult<string, LLMResponse> | undefined
      try {
        step = await stream.next()
        while (!step.done) {
          yield { type: 'text', delta: step.value }
          step = await stream.next()
        }
      } finally {
        // The consumer can abandon us at the text yield above, and hand-driven
        // .next() gets none of yield*'s auto-close propagation — close the
        // inner generator so its own finally runs (the SSE reader is cancelled
        // and the connection released). Awaited: for-await's break waits on
        // our return(), so teardown must complete inside it — fire-and-forget
        // would leak the cleanup past the break (and turn a throwing inner
        // finally into an unhandled rejection). No-op after normal completion.
        if (!step?.done) await stream.return(undefined as unknown as LLMResponse)
      }
      const resp = step!.value as LLMResponse

      // Calibrate the compressor's char-based estimate against the real
      // prompt_tokens the API just billed for. Must happen before pushing
      // the reply: `messages` still equals what the request was built from,
      // so the real count and the estimate describe the same snapshot.
      this.context.observe(resp.promptTokens, this.messages)

      this.messages.push(resp.toMessage())

      // no tool calls -> LLM is done, return text
      if (resp.toolCalls.length === 0) return resp.content

      // tool calls -> execute (Promise.all when multiple, like Claude Code's
      // StreamingToolExecutor which runs independent tools concurrently;
      // Python needs a thread pool for this, JS gets it from the event loop)
      try {
        for (const tc of resp.toolCalls) {
          yield { type: 'tool_start', name: tc.name, args: tc.arguments }
        }
        const results =
          resp.toolCalls.length === 1
            ? [await this.execTool(resp.toolCalls[0]!, signal)]
            : await Promise.all(resp.toolCalls.map(tc => this.execTool(tc, signal)))

        for (let i = 0; i < resp.toolCalls.length; i++) {
          const tc = resp.toolCalls[i]!
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: results[i]! })
          yield { type: 'tool_end', name: tc.name, result: results[i]! }
        }

        // a signal that fired during execution (e.g. a long bash command that
        // just got killed) must end the turn now — no point paying for another
        // LLM round that will abort the instant it starts. History is already
        // consistent: every tool call above got its reply.
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      } catch (e) {
        // An abort mid-execution would leave the assistant tool_calls message
        // without replies, poisoning the next request; backfill before
        // re-throwing (the Python version does this on KeyboardInterrupt).
        this.answerPendingToolCalls(resp.toolCalls)
        throw e
      }

      // compress if tool outputs are big
      await this.context.maybeCompress(this.messages, this.llm, signal)
    }

    return '(reached maximum tool-call rounds)'
  }

  /** Execute a single tool call, returning the result string. Never throws except on abort. */
  private async execTool(tc: ToolCallReq, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const tool = this.toolByName.get(tc.name)
    if (!tool) return `Error: unknown tool '${tc.name}'`

    // validate arguments first so an error raised *inside* the tool isn't
    // mislabelled as a bad-arguments error from the caller
    const missing = missingArgs(tool, tc.arguments)
    if (missing.length > 0) {
      return `Error: bad arguments for ${tc.name}: missing required ${missing.join(', ')}`
    }
    try {
      return await tool.execute(tc.arguments, signal)
    } catch (e) {
      // cancellation is a control flow, not a tool failure: a tool that throws
      // AbortError (killed bash child, aborted sub-agent, aborted walk) must
      // propagate so the turn unwinds and pending replies get backfilled —
      // stringifying it would feed "Error executing bash: AbortError" back to
      // the model and the turn would limp on.
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      return `Error executing ${tc.name}: ${e}`
    }
  }

  /**
   * Backfill a tool reply for every call that didn't get one.
   *
   * OpenAI-compatible APIs reject a request where an assistant message has
   * tool_calls without a matching tool reply for each id, so this keeps the
   * history valid when execution is interrupted partway through.
   * (The production-scale twin of this is yieldMissingToolResultBlocks in
   * Claude Code's query.ts.)
   */
  private answerPendingToolCalls(toolCalls: ToolCallReq[]): void {
    const answered = new Set<string>()
    for (const m of this.messages) {
      if (m.role === 'tool') answered.add(m.tool_call_id)
    }
    for (const tc of toolCalls) {
      if (!answered.has(tc.id)) {
        this.messages.push({ role: 'tool', tool_call_id: tc.id, content: '[interrupted]' })
      }
    }
  }

  /** Clear conversation history. */
  reset(): void {
    this.messages.length = 0
  }
}
