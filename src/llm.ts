/**
 * LLM provider layer — a thin client over OpenAI-compatible APIs.
 *
 * Port of CoreCoder's llm.py with one deliberate upgrade: instead of an
 * `on_token` callback, `chat()` is an async generator that yields text
 * deltas and *returns* the final LLMResponse — the same yield/return
 * dual-channel that Claude Code's query loop is built on.
 *
 * The Python version leans on the `openai` SDK. Here we speak raw
 * fetch + SSE on purpose: re-stitching tool-call fragments from a stream
 * is the real work of this layer, and hiding it in an SDK would defeat
 * the point of a teaching codebase.
 *
 * The openai package appears only as a dev dependency for its types:
 * `import type` is erased at compile time, so the wire format we parse is
 * checked against the official SDK's contract while the runtime stays
 * dependency-free.
 */

import type { ChatCompletionChunk } from 'openai/resources/chat/completions'

// ---------------------------------------------------------------- messages

export type RawToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: RawToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export type ToolSchema = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ToolCallReq {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export class LLMResponse {
  constructor(
    public content: string = '',
    public toolCalls: ToolCallReq[] = [],
    public promptTokens: number = 0,
    public completionTokens: number = 0,
  ) {}

  /** Convert to OpenAI message format for appending to history. */
  toMessage(): ChatMessage {
    const msg: ChatMessage = { role: 'assistant', content: this.content || null }
    if (this.toolCalls.length > 0) {
      msg.tool_calls = this.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }))
    }
    return msg
  }
}

// ---------------------------------------------------------------- pricing

/** Pricing per million tokens: [input, output]. Same table as the Python version. */
const PRICING: Record<string, [number, number]> = {
  // OpenAI - current flagships
  'gpt-5.5': [5, 30],
  'gpt-5.4': [2.5, 15],
  'gpt-5.4-mini': [0.75, 4.5],
  'gpt-5.4-nano': [0.2, 1.25],
  'o4-mini': [1.1, 4.4],
  // OpenAI - previous gen (still widely used)
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  // DeepSeek
  'deepseek-chat': [0.27, 1.1],
  'deepseek-reasoner': [0.55, 2.19],
  // Anthropic Claude
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
  // Alibaba Qwen
  'qwen3-max': [0.78, 3.9],
  'qwen3-plus': [0.26, 0.78],
  'qwen-max': [0.78, 3.9],
  // Moonshot Kimi
  'kimi-k2.5': [0.6, 3],
}

// ---------------------------------------------------------------- interface

/**
 * What the Agent needs from a model client. LLM (real) and ScriptedLLM
 * (offline) both satisfy this, so tests and demos need no network.
 */
export interface LLMClient {
  model: string
  totalPromptTokens: number
  totalCompletionTokens: number
  readonly estimatedCost: number | null
  chat(
    messages: ChatMessage[],
    tools?: ToolSchema[],
    signal?: AbortSignal,
  ): AsyncGenerator<string, LLMResponse>
}

/** Drive a generator to completion, discarding yields, and return its return value. */
export async function drain<T, R>(gen: AsyncGenerator<T, R>): Promise<R> {
  let step = await gen.next()
  while (!step.done) step = await gen.next()
  return step.value
}

// ---------------------------------------------------------------- errors

/** 400 from the provider — used to detect unsupported params like stream_options. */
export class BadRequestError extends Error {
  constructor(message: string, public body: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

class TransientError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })

// ---------------------------------------------------------------- real client

export class LLM implements LLMClient {
  model: string
  totalPromptTokens = 0
  totalCompletionTokens = 0

  private apiKey: string
  private baseUrl: string
  private timeoutMs: number
  private extra: Record<string, unknown>

  constructor(opts: {
    model: string
    apiKey: string
    baseUrl?: string | null
    /** How long to wait for each request before giving up and retrying. */
    timeoutMs?: number
    /** temperature, max_tokens, etc. — forwarded verbatim to the API */
    [k: string]: unknown
  }) {
    const { model, apiKey, baseUrl, timeoutMs, ...extra } = opts
    this.model = model
    this.apiKey = apiKey
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.timeoutMs = timeoutMs ?? 300_000 // 5 minutes
    this.extra = extra
  }

  /** Rough cost estimate in USD. Null if the model isn't in the pricing table. */
  get estimatedCost(): number | null {
    const pricing = PRICING[this.model]
    if (!pricing) return null
    const [inputRate, outputRate] = pricing
    return (
      (this.totalPromptTokens * inputRate) / 1_000_000 +
      (this.totalCompletionTokens * outputRate) / 1_000_000
    )
  }

  /**
   * Send messages; yield text deltas as they stream in; return the full
   * response (content + restitched tool calls + usage) when done.
   */
  async *chat(
    messages: ChatMessage[],
    tools?: ToolSchema[],
    signal?: AbortSignal,
  ): AsyncGenerator<string, LLMResponse> {
    const params: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      ...this.extra,
    }
    if (tools && tools.length > 0) params.tools = tools

    // stream_options is an OpenAI extension; fall back only when the provider
    // rejects the param (400), not on transient errors that the retry loop
    // already exhausted — otherwise we'd double the retries.
    params.stream_options = { include_usage: true }
    let res: Response
    try {
      res = await this.callWithRetry(params, signal)
    } catch (e) {
      if (!(e instanceof BadRequestError)) throw e
      delete params.stream_options
      res = await this.callWithRetry(params, signal)
    }

    const contentParts: string[] = []
    // index -> partial tool call; a streamed tool call arrives as fragments
    // (id first, then the JSON arguments split across many chunks) that must
    // be reassembled per index before parsing.
    const tcMap = new Map<number, { id: string; name: string; args: string }>()
    let promptTok = 0
    let completionTok = 0

    for await (const data of sseEvents(res, signal)) {
      // Typed against the official SDK's wire contract (type-only import).
      const chunk = JSON.parse(data) as ChatCompletionChunk

      // usage info comes in the final chunk; some providers send usage with
      // null fields, so coerce to 0 to keep the running totals numeric
      if (chunk.usage) {
        promptTok = chunk.usage.prompt_tokens ?? 0
        completionTok = chunk.usage.completion_tokens ?? 0
      }

      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue

      if (delta.content) {
        contentParts.push(delta.content)
        yield delta.content
      }

      if (delta.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          let entry = tcMap.get(tcDelta.index)
          if (!entry) {
            entry = { id: '', name: '', args: '' }
            tcMap.set(tcDelta.index, entry)
          }
          if (tcDelta.id) entry.id = tcDelta.id
          if (tcDelta.function?.name) entry.name = tcDelta.function.name
          if (tcDelta.function?.arguments) entry.args += tcDelta.function.arguments
        }
      }
    }

    // parse accumulated tool calls, in index order
    const parsed: ToolCallReq[] = []
    for (const idx of [...tcMap.keys()].sort((a, b) => a - b)) {
      const raw = tcMap.get(idx)!
      let args: Record<string, unknown>
      try {
        args = JSON.parse(raw.args) as Record<string, unknown>
      } catch {
        args = {}
      }
      parsed.push({ id: raw.id, name: raw.name, arguments: args })
    }

    this.totalPromptTokens += promptTok
    this.totalCompletionTokens += completionTok

    return new LLMResponse(contentParts.join(''), parsed, promptTok, completionTok)
  }

  /** POST with exponential backoff on transient errors (429, timeouts, 5xx). */
  private async callWithRetry(
    params: Record<string, unknown>,
    signal?: AbortSignal,
    maxRetries = 3,
  ): Promise<Response> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.callOnce(params, signal)
      } catch (e) {
        const lastAttempt = attempt === maxRetries - 1
        if (e instanceof TransientError && !lastAttempt) {
          await sleep(2 ** attempt * 1000, signal)
          continue
        }
        throw e
      }
    }
    throw new Error('unreachable')
  }

  private async callOnce(params: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    // Node's fetch has no timeout option (RequestInit.timeout is silently
    // ignored), so a provider that accepts the connection and then never
    // answers would hang the agent forever. Race the request against a timer:
    // the timer aborts the fetch and we translate that into a retryable
    // transient error. A user cancellation must pass through untouched — the
    // controller is aborted by the user's signal first, before the timer can
    // claim it.
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    if (signal?.aborted) {
      controller.abort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      })
    } catch (e) {
      // user cancellation must not be retried
      if (e instanceof Error && e.name === 'AbortError') {
        if (timedOut) {
          throw new TransientError(`request timed out after ${this.timeoutMs}ms`)
        }
        throw e
      }
      throw new TransientError(`connection error: ${e}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    if (res.ok) return res

    const body = await res.text().catch(() => '')
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    if (res.status === 400) {
      throw new BadRequestError(`HTTP 400: ${body.slice(0, 500)}`, body)
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`)
  }
}

/**
 * Parse a Server-Sent-Events response body into `data:` payload strings,
 * stopping at [DONE]. Handles payloads split across network chunks by
 * buffering the trailing partial line.
 */
async function* sseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) throw new Error('response has no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // process complete lines; keep the trailing partial line in the buffer
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        if (data) yield data
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------- scripted client

/**
 * Deterministic offline LLM for demos and smoke tests.
 *
 * Plays back a list of LLMResponse turns, one per chat() call, streaming
 * each turn's content as a single yield. Running out of turns is an error,
 * not a silent hang, so a broken loop shows up immediately.
 */
export class ScriptedLLM implements LLMClient {
  totalPromptTokens = 0
  totalCompletionTokens = 0

  private turns: LLMResponse[]

  constructor(script: LLMResponse[], public model: string = 'scripted-demo') {
    this.turns = [...script]
  }

  get estimatedCost(): number | null {
    return null
  }

  async *chat(
    _messages: ChatMessage[],
    _tools?: ToolSchema[],
    _signal?: AbortSignal,
  ): AsyncGenerator<string, LLMResponse> {
    const resp = this.turns.shift()
    if (!resp) throw new Error('ScriptedLLM ran out of turns')
    if (resp.content) yield resp.content
    this.totalCompletionTokens += resp.content.split(/\s+/).filter(Boolean).length
    return resp
  }
}
