/**
 * Regression tests for robustness fixes: retry-abort behavior, SSE tolerance,
 * glob separators, argument clamping, env parsing, and grep output caps.
 *
 * Run with: npm test   (tsc build + node --test)
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { configFromEnv } from '../src/config.js'
import { LLM, drain, type LLMResponse } from '../src/llm.js'
import { globToRegExp } from '../src/tools/glob.js'

/** Drive a generator, collecting yields, and return { parts, resp }. */
async function collect(
  gen: AsyncGenerator<string, LLMResponse>,
): Promise<{ parts: string[]; resp: LLMResponse }> {
  const parts: string[] = []
  let step = await gen.next()
  while (!step.done) {
    parts.push(step.value)
    step = await gen.next()
  }
  return { parts, resp: step.value }
}

// ---------------------------------------------------------------- llm: retry + abort

test('retry backoff rejects immediately when the signal is already aborted', async () => {
  const originalFetch = globalThis.fetch
  // a provider that keeps answering 429, ignoring the abort signal: the abort
  // lands *between* the transient failure and the backoff sleep, which used to
  // hang the retry loop for the full delay before aborting the next request
  globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch
  const llm = new LLM({ model: 'm', apiKey: 'k' })
  const ac = new AbortController()
  ac.abort()

  try {
    const t0 = Date.now()
    await assert.rejects(
      drain(llm.chat([{ role: 'user', content: 'hi' }], undefined, ac.signal)),
      (e: Error) => e.name === 'AbortError',
    )
    assert.ok(Date.now() - t0 < 500, 'must reject immediately, not wait out the backoff')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream survives non-JSON data lines from the provider', async () => {
  const originalFetch = globalThis.fetch
  // garbage heartbeat line first, then one valid chunk, then [DONE]
  const body =
    'data: this is not json at all\n\n' +
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n' +
    'data: [DONE]\n\n'
  globalThis.fetch = (async () =>
    new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const llm = new LLM({ model: 'm', apiKey: 'k' })

  try {
    const { parts, resp } = await collect(llm.chat([{ role: 'user', content: 'hi' }]))
    assert.deepEqual(parts, ['ok'])
    assert.equal(resp.content, 'ok')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------- glob separators

test('globToRegExp treats Windows backslashes as separators', () => {
  assert.ok(globToRegExp('src\\**\\*.ts').test('src/a/b.ts'))
  assert.ok(globToRegExp('src\\**\\*.ts').test('src/c.ts')) // **/ matches zero segments
  assert.ok(!globToRegExp('src\\**\\*.ts').test('lib/a.ts'))
})

// ---------------------------------------------------------------- tool args

test('read_file clamps junk offset/limit instead of slicing backwards', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-read-'))
  const file = path.join(dir, 'lines.txt')
  await fs.writeFile(file, 'a\nb\nc\n')
  const { readFileTool } = await import('../src/tools/read.js')

  const zero = await readFileTool.execute({ file_path: file, limit: 0 })
  assert.ok(zero.includes('a'), 'limit 0 still reads at least one line')

  const neg = await readFileTool.execute({ file_path: file, offset: 1, limit: -5 })
  assert.ok(neg.includes('a'), 'negative limit reads at least one line')

  const negOff = await readFileTool.execute({ file_path: file, offset: -3 })
  assert.ok(negOff.includes('a'), 'negative offset clamps to line 1')

  await fs.rm(dir, { recursive: true, force: true })
})

test('grep caps match line width so one-line giants cannot flood the context', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-grep-'))
  const file = path.join(dir, 'big.js')
  await fs.writeFile(file, 'x'.repeat(5000) + '\nshort\n')
  const { grepTool } = await import('../src/tools/grep.js')

  const out = await grepTool.execute({ pattern: 'x', path: dir })
  assert.ok(out.includes('line truncated'))
  assert.ok(out.length < 2500, `output should be capped, got ${out.length} chars`)

  await fs.rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- config env

test('configFromEnv falls back on garbage numeric env vars', () => {
  process.env.CORECODER_MAX_TOKENS = 'abc'
  process.env.CORECODER_TEMPERATURE = 'hot'
  process.env.CORECODER_MAX_CONTEXT = '1e999' // overflows to Infinity
  try {
    const cfg = configFromEnv()
    assert.equal(cfg.maxTokens, 4096)
    assert.equal(cfg.temperature, 0)
    assert.equal(cfg.maxContextTokens, 128000)
  } finally {
    delete process.env.CORECODER_MAX_TOKENS
    delete process.env.CORECODER_TEMPERATURE
    delete process.env.CORECODER_MAX_CONTEXT
  }
})
