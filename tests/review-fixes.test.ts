/**
 * Regression tests for the source-review fixes: replacement-pattern safety,
 * abandoned-generator backfill, junk tool arguments, stream cancellation and
 * stall detection, SIGKILL escalation, per-agent tool instances, glob pattern
 * gaps, cwd unification, and oversized-message truncation.
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { Agent } from '../src/agent.js'
import { LLM, LLMResponse, ScriptedLLM, drain } from '../src/llm.js'
import { SubAgentTool } from '../src/tools/agent.js'
import { bashTool } from '../src/tools/bash.js'
import { editFileTool } from '../src/tools/edit.js'
import { globTool, globToRegExp } from '../src/tools/glob.js'

// ---------------------------------------------------------------- edit: $ patterns

test('edit_file writes $-sequences in new_string literally', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fix-edit-'))
  const file = path.join(dir, 'Makefile')
  await fs.writeFile(file, 'run:\n\tPLACEHOLDER\n')
  try {
    await editFileTool.execute({
      file_path: file,
      old_string: 'PLACEHOLDER',
      new_string: "kill $$ && echo $& done $'",
    })
    const out = await fs.readFile(file, 'utf8')
    assert.ok(out.includes("kill $$ && echo $& done $'"), `corrupted write: ${out}`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- agent: abandoned generator

test('breaking out of chat() mid-turn still backfills tool replies', async () => {
  const script = [
    new LLMResponse('', [{ id: 'b1', name: 'bash', arguments: { command: 'echo hi' } }]),
  ]
  const agent = new Agent({ llm: new ScriptedLLM(script) })

  for await (const ev of agent.chat('do something')) {
    if (ev.type === 'tool_start') break // the documented library usage
  }

  const assistant = agent.messages.find(m => m.role === 'assistant' && m.tool_calls?.length)
  assert.ok(assistant && assistant.role === 'assistant', 'assistant tool_calls message present')
  for (const tc of assistant.tool_calls ?? []) {
    const reply = agent.messages.find(m => m.role === 'tool' && m.tool_call_id === tc.id)
    assert.ok(reply, `tool call ${tc.id} must have a reply after abandonment`)
  }
})

// ---------------------------------------------------------------- llm: junk arguments

function sseResponse(lines: string[]): Response {
  return new Response(lines.map(l => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}

test('tool-call arguments that parse to null/array/scalar coerce to {}', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    sseResponse([
      JSON.stringify({
        id: '1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 't1', function: { name: 'bash', arguments: 'null' } }],
            },
          },
        ],
      }),
    ])) as typeof fetch
  try {
    const llm = new LLM({ model: 'm', apiKey: 'k' })
    const resp = await drain(llm.chat([{ role: 'user', content: 'hi' }]))
    assert.deepEqual(resp.toolCalls[0]!.arguments, {})
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------- llm: stream abort + stall

function hangingBodyResponse(firstChunk?: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstChunk) controller.enqueue(new TextEncoder().encode(firstChunk))
      // then never close, never enqueue again
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

test('aborting mid-stream rejects promptly instead of being swallowed', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    hangingBodyResponse(
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"a"}}]}\n\n',
    )) as typeof fetch
  try {
    const llm = new LLM({ model: 'm', apiKey: 'k' })
    const ac = new AbortController()
    const turn = drain(llm.chat([{ role: 'user', content: 'hi' }], undefined, ac.signal))
    setTimeout(() => ac.abort(), 100)
    const t0 = Date.now()
    await assert.rejects(turn, (e: Error) => e.name === 'AbortError')
    assert.ok(Date.now() - t0 < 2000, 'abort must not wait for more data')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a stream that stops producing raises a stall error instead of hanging', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => hangingBodyResponse()) as typeof fetch
  try {
    const llm = new LLM({ model: 'm', apiKey: 'k', timeoutMs: 200 })
    await assert.rejects(
      drain(llm.chat([{ role: 'user', content: 'hi' }])),
      (e: Error) => /stalled/.test(e.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------- bash: SIGKILL escalation

test('kill goes straight to SIGKILL, so a TERM-trapping child cannot wedge the turn', { skip: process.platform === 'win32' }, async () => {
  const t0 = Date.now()
  const out = await bashTool.execute({
    command: `bash -c "trap '' TERM; sleep 30"`,
    timeout: 1,
  })
  assert.ok(String(out).includes('timed out'), `expected timeout result, got: ${out}`)
  assert.ok(Date.now() - t0 < 5000, 'must settle immediately after the timeout SIGKILL')
})

// ---------------------------------------------------------------- tools: per-agent instances

test('each Agent gets its own SubAgentTool bound to itself', () => {
  const a = new Agent({ llm: new ScriptedLLM([]) })
  const b = new Agent({ llm: new ScriptedLLM([]) })
  const toolA = a.tools.find(t => t.name === 'agent') as SubAgentTool
  const toolB = b.tools.find(t => t.name === 'agent') as SubAgentTool
  assert.notEqual(toolA, toolB, 'agents must not share a SubAgentTool instance')
  assert.equal(toolA.parentAgent, a)
  assert.equal(toolB.parentAgent, b)
})

// ---------------------------------------------------------------- glob: pattern gaps

test('globToRegExp handles ./ prefixes and character classes', () => {
  assert.ok(globToRegExp('./src/*.ts').test('src/a.ts'))
  assert.ok(globToRegExp('**/*.[ch]').test('lib/x.c'))
  assert.ok(globToRegExp('**/*.[ch]').test('x.h'))
  assert.ok(!globToRegExp('**/*.[ch]').test('x.ts'))
  assert.ok(globToRegExp('[!a]*.md').test('b.md'))
  assert.ok(!globToRegExp('[!a]*.md').test('a.md'))
})

test('character classes follow Python fnmatch semantics on the edge cases', () => {
  // ^ is a literal member — only ! negates
  assert.ok(globToRegExp('[^a].md').test('^.md'))
  assert.ok(globToRegExp('[^a].md').test('a.md'))
  assert.ok(!globToRegExp('[^a].md').test('b.md'))
  // ] right after [ is a literal member
  assert.ok(globToRegExp('[]].md').test('].md'))
  assert.ok(!globToRegExp('[]].md').test('a.md'))
  // [!]] means "not ]"
  assert.ok(globToRegExp('[!]].md').test('a.md'))
  assert.ok(!globToRegExp('[!]].md').test('].md'))
  // an invalid range matches nothing instead of throwing
  assert.doesNotThrow(() => globToRegExp('[z-a].md'))
  assert.ok(!globToRegExp('[z-a].md').test('m.md'))
})

test('glob tool matches ./-prefixed and class patterns against a real tree', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fix-glob-'))
  await fs.writeFile(path.join(dir, 'a.c'), '')
  await fs.writeFile(path.join(dir, 'b.ts'), '')
  try {
    const out = await globTool.execute({ pattern: './*.[ch]', path: dir })
    assert.ok(out.includes('a.c'))
    assert.ok(!out.includes('b.ts'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- llm: usage honesty

test('usageSeen flips only when the provider actually reports usage', async () => {
  const originalFetch = globalThis.fetch
  const chunk = (extra: string) =>
    `{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"a"}}]${extra}}`
  try {
    globalThis.fetch = (async () => sseResponse([chunk('')])) as typeof fetch
    const noUsage = new LLM({ model: 'm', apiKey: 'k' })
    await drain(noUsage.chat([{ role: 'user', content: 'hi' }]))
    assert.equal(noUsage.usageSeen, false, 'no usage chunk → stays unknown')
    assert.equal(noUsage.usageMissed, true, 'a usage-less response marks the totals incomplete')

    // a usage OBJECT with null fields is not data either
    globalThis.fetch = (async () =>
      sseResponse([chunk(',"usage":{"prompt_tokens":null,"completion_tokens":null}')])) as typeof fetch
    const nullUsage = new LLM({ model: 'm', apiKey: 'k' })
    await drain(nullUsage.chat([{ role: 'user', content: 'hi' }]))
    assert.equal(nullUsage.usageSeen, false, 'null-field usage must not dress unknown up as 0')

    globalThis.fetch = (async () =>
      sseResponse([chunk(',"usage":{"prompt_tokens":5,"completion_tokens":2}')])) as typeof fetch
    const withUsage = new LLM({ model: 'm', apiKey: 'k' })
    await drain(withUsage.chat([{ role: 'user', content: 'hi' }]))
    assert.equal(withUsage.usageSeen, true)
    assert.equal(withUsage.usageMissed, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------- agent: abandoning during TEXT streaming

test('abandoning chat() during text streaming closes the SSE connection', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
        ),
      )
      // never close — a live stream mid-generation
    },
    cancel() {
      cancelled = true
    },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  try {
    const llm = new LLM({ model: 'm', apiKey: 'k' })
    const agent = new Agent({ llm, tools: [] })
    for await (const ev of agent.chat('hi')) {
      if (ev.type === 'text') break // abandon mid-stream
    }
    // break awaits the generator chain's return(), so teardown must have
    // fully completed by this line — no sleep allowed
    assert.equal(cancelled, true, 'the SSE body must be cancelled by the time break returns')
  } finally {
    globalThis.fetch = originalFetch
  }
})
