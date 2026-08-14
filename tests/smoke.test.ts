/**
 * Smoke tests: drive the real agent loop with a ScriptedLLM (no network),
 * executing real tools against the real filesystem. "It runs so the
 * walkthrough can't lie."
 *
 * Run with: npm test   (tsc build + node --test)
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { Agent, type AgentEvent } from '../src/agent.js'
import { ContextManager, estimateTokens } from '../src/context.js'
import { LLMResponse, ScriptedLLM, drain, type ChatMessage, type LLMClient } from '../src/llm.js'
import { saveSession, loadSession, SESSIONS_DIR } from '../src/session.js'
import { editFileTool, unifiedDiff } from '../src/tools/edit.js'
import { globToRegExp } from '../src/tools/glob.js'

// ---------------------------------------------------------------- agent loop

test('agent loop: tool call round-trip then final answer', async () => {
  const script = [
    new LLMResponse('Let me check.', [
      { id: 't1', name: 'bash', arguments: { command: 'echo smoke-ok' } },
    ]),
    new LLMResponse('all done'),
  ]
  const agent = new Agent({ llm: new ScriptedLLM(script) })

  const events: AgentEvent[] = []
  const gen = agent.chat('run echo for me')
  let step = await gen.next()
  while (!step.done) {
    events.push(step.value)
    step = await gen.next()
  }

  // the generator's return value is the final answer
  assert.equal(step.value, 'all done')

  // events carried both the streamed text and the tool lifecycle
  assert.ok(events.some(e => e.type === 'text' && e.delta.includes('Let me check')))
  assert.ok(events.some(e => e.type === 'tool_start' && e.name === 'bash'))
  assert.ok(events.some(e => e.type === 'tool_end' && e.result.includes('smoke-ok')))

  // the tool result was fed back into history in OpenAI format
  const toolMsg = agent.messages.find(m => m.role === 'tool')
  assert.ok(toolMsg && toolMsg.role === 'tool')
  assert.ok(toolMsg.content.includes('smoke-ok'))
  assert.equal(toolMsg.tool_call_id, 't1')

  // history shape: user -> assistant(tool_calls) -> tool -> assistant
  assert.deepEqual(
    agent.messages.map(m => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  )
})

test('unknown tool becomes an error result, not a crash', async () => {
  const script = [
    new LLMResponse('', [{ id: 't1', name: 'no_such_tool', arguments: {} }]),
    new LLMResponse('recovered'),
  ]
  const agent = new Agent({ llm: new ScriptedLLM(script) })
  const final = await drain(agent.chat('x'))
  assert.equal(final, 'recovered')
  const toolMsg = agent.messages.find(m => m.role === 'tool')
  assert.ok(toolMsg?.content.includes("unknown tool 'no_such_tool'"))
})

test('missing required args are caught before execution', async () => {
  const script = [
    new LLMResponse('', [{ id: 't1', name: 'bash', arguments: {} }]), // no `command`
    new LLMResponse('ok'),
  ]
  const agent = new Agent({ llm: new ScriptedLLM(script) })
  await drain(agent.chat('x'))
  const toolMsg = agent.messages.find(m => m.role === 'tool')
  assert.ok(toolMsg?.content.includes('bad arguments for bash'))
})

test('abort backfills [interrupted] replies for pending tool calls', async () => {
  const script = [
    new LLMResponse('', [{ id: 't1', name: 'bash', arguments: { command: 'echo hi' } }]),
  ]
  const agent = new Agent({ llm: new ScriptedLLM(script) })
  const ac = new AbortController()
  ac.abort() // already aborted: the tool executor must throw, then backfill

  await assert.rejects(drain(agent.chat('x', ac.signal)), (e: Error) => e.name === 'AbortError')

  // the assistant's tool_calls message must not be left unanswered
  const toolMsg = agent.messages.find(m => m.role === 'tool')
  assert.ok(toolMsg && toolMsg.role === 'tool')
  assert.equal(toolMsg.content, '[interrupted]')
  assert.equal(toolMsg.tool_call_id, 't1')
})

test('abort mid-stream marks the turn [interrupted by user]', async () => {
  // ^C while the model streams its reply: no assistant message exists yet.
  // Without a marker the next turn's model sees a bare unanswered request
  // and picks the dead task back up.
  const llm: LLMClient = {
    model: 'aborts-mid-stream',
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    estimatedCost: null,
    // eslint-disable-next-line require-yield
    async *chat(): AsyncGenerator<string, LLMResponse> {
      throw new DOMException('Aborted', 'AbortError')
    },
  }
  const agent = new Agent({ llm })
  const ac = new AbortController()
  ac.abort()

  await assert.rejects(drain(agent.chat('write a long poem', ac.signal)), (e: Error) => e.name === 'AbortError')

  assert.deepEqual(
    agent.messages.map(m => m.role),
    ['user', 'assistant'],
  )
  assert.equal(agent.messages.at(-1)!.content, '[interrupted by user]')
})

test('sub-agent runs with the agent tool withheld', async () => {
  // turn order: parent asks for sub-agent -> sub-agent's own turn -> parent wraps up
  const script = [
    new LLMResponse('', [{ id: 'a1', name: 'agent', arguments: { task: 'say hi' } }]),
    new LLMResponse('hi from the sub-agent'),
    new LLMResponse('parent done'),
  ]
  const agent = new Agent({ llm: new ScriptedLLM(script) })
  const final = await drain(agent.chat('delegate this'))

  assert.equal(final, 'parent done')
  const toolMsg = agent.messages.find(m => m.role === 'tool')
  assert.ok(toolMsg?.content.includes('[Sub-agent completed]'))
  assert.ok(toolMsg?.content.includes('hi from the sub-agent'))
})

test('round limit stops a tool-hungry model', async () => {
  const looping = Array.from({ length: 5 }, (_, i) =>
    new LLMResponse('', [{ id: `t${i}`, name: 'bash', arguments: { command: 'echo loop' } }]),
  )
  const agent = new Agent({ llm: new ScriptedLLM(looping), maxRounds: 3 })
  const final = await drain(agent.chat('never stop'))
  assert.equal(final, '(reached maximum tool-call rounds)')
})

// ---------------------------------------------------------------- edit tool

test('edit_file: unique match replaces and returns a diff', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ts-'))
  const file = path.join(dir, 'sample.ts')
  await fs.writeFile(file, 'const a = 1\nconst b = 2\nconst c = 3\n')

  const result = await editFileTool.execute({
    file_path: file,
    old_string: 'const b = 2',
    new_string: 'const b = 42',
  })

  assert.ok(result.startsWith('Edited'))
  assert.ok(result.includes('-const b = 2'))
  assert.ok(result.includes('+const b = 42'))
  assert.equal(await fs.readFile(file, 'utf8'), 'const a = 1\nconst b = 42\nconst c = 3\n')

  await fs.rm(dir, { recursive: true, force: true })
})

test('edit_file: zero and multiple matches are recoverable errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ts-'))
  const file = path.join(dir, 'dup.txt')
  await fs.writeFile(file, 'same\nsame\n')

  const none = await editFileTool.execute({
    file_path: file,
    old_string: 'missing',
    new_string: 'x',
  })
  assert.ok(none.includes('not found'))
  assert.ok(none.includes('File starts with')) // hands back context so the model can re-anchor

  const multi = await editFileTool.execute({
    file_path: file,
    old_string: 'same',
    new_string: 'x',
  })
  assert.ok(multi.includes('appears 2 times'))

  await fs.rm(dir, { recursive: true, force: true })
})

test('unifiedDiff marks the changed hunk with @@ and context', () => {
  const oldText = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n'
  const newText = 'l1\nl2\nl3\nCHANGED\nl5\nl6\nl7\n'
  const diff = unifiedDiff(oldText, newText, 'f.txt')
  assert.ok(diff.includes('--- a/f.txt'))
  assert.ok(diff.includes('+++ b/f.txt'))
  assert.ok(diff.includes('@@'))
  assert.ok(diff.includes('-l4'))
  assert.ok(diff.includes('+CHANGED'))
  assert.ok(diff.includes(' l3')) // context line
})

// ---------------------------------------------------------------- glob

test('globToRegExp handles *, ?, ** and **/ correctly', () => {
  assert.ok(globToRegExp('**/*.ts').test('a/b/c.ts'))
  assert.ok(globToRegExp('**/*.ts').test('c.ts')) // **/ matches zero segments
  assert.ok(!globToRegExp('*.ts').test('a/b.ts')) // * must not cross /
  assert.ok(globToRegExp('src/**/*.ts').test('src/x/y.ts'))
  assert.ok(!globToRegExp('src/**/*.ts').test('lib/x/y.ts'))
  assert.ok(globToRegExp('file.?s').test('file.ts'))
  assert.ok(!globToRegExp('file.?s').test('file.tsx'))
})

// ---------------------------------------------------------------- context

test('layer 1 snips verbose tool outputs, head and tail preserved', async () => {
  // must exceed the 1500-char snip threshold (same threshold as the Python version)
  const bigOutput = Array.from({ length: 100 }, (_, i) => `line-${i} ${'x'.repeat(30)}`).join('\n')
  const messages: ChatMessage[] = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'tool', tool_call_id: 't1', content: bigOutput },
  ]
  // tiny budget so the snip threshold (50%) is definitely crossed
  const ctx = new ContextManager(200)
  const compressed = await ctx.maybeCompress(messages)

  assert.ok(compressed)
  const tool = messages.find(m => m.role === 'tool')!
  assert.ok(tool.content.includes('line-0')) // head kept
  assert.ok(tool.content.includes('line-99')) // tail kept
  assert.ok(tool.content.includes('snipped to save context'))
  assert.ok(tool.content.length < bigOutput.length)
})

test('compression never orphans a tool message at the tail boundary', async () => {
  // 12 messages ending in assistant(tool_calls) -> tool, sized to trigger layer 2
  const filler = 'x'.repeat(600)
  const messages: ChatMessage[] = []
  for (let i = 0; i < 5; i++) {
    messages.push({ role: 'user', content: `q${i} ${filler}` })
    messages.push({ role: 'assistant', content: `a${i} ${filler}` })
  }
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'tc', type: 'function', function: { name: 'bash', arguments: '{}' } }],
  })
  messages.push({ role: 'tool', tool_call_id: 'tc', content: `result ${filler}` })

  const ctx = new ContextManager(1000) // 70% threshold well below our ~2.4k tokens
  await ctx.maybeCompress(messages) // no LLM -> extraction fallback summary

  // wherever the cut landed, no 'tool' message may directly follow the
  // injected summary pair without its assistant(tool_calls) partner
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role !== 'tool') continue
    const prev = messages
      .slice(0, i)
      .reverse()
      .find(x => x.role === 'assistant')
    assert.ok(
      prev && prev.role === 'assistant' && (prev.tool_calls?.length ?? 0) > 0,
      `tool message at index ${i} lost its tool_calls partner`,
    )
  }
})

// ---------------------------------------------------------------- session

test('session ids are sanitized against path traversal, and round-trip', async () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'remember me' }]
  const id = await saveSession(messages, 'test-model', '../../evil/../name')

  // the id must have been flattened to a safe filename
  assert.ok(!id.includes('/') && !id.includes('..'))

  const loaded = await loadSession(id)
  assert.ok(loaded)
  assert.equal(loaded.model, 'test-model')
  assert.deepEqual(loaded.messages, messages)

  // cleanup
  await fs.rm(path.join(SESSIONS_DIR, `${id}.json`), { force: true })
})

// ---------------------------------------------------------------- tokens

test('estimateTokens counts content and tool_calls', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'abcdef' }, // 2 tokens at ~3 chars/token
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'x', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    },
  ]
  assert.ok(estimateTokens(messages) > 2)
})

test('read_file caps line width so one-line giants cannot flood the context', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-read-'))
  const file = path.join(dir, 'minified.js')
  await fs.writeFile(file, 'x'.repeat(50_000), 'utf8')
  const { readFileTool } = await import('../src/tools/read.js')
  const out = await readFileTool.execute({ file_path: file })
  assert.ok(out.length < 3000, `output should be capped, got ${out.length} chars`)
  assert.ok(out.includes('line truncated'))
  await fs.rm(dir, { recursive: true, force: true })
})

test('context: observed real usage calibrates the estimate and changes decisions', async () => {
  // snipAt = 1000. Build messages whose char estimate (~690) sits below the
  // threshold, but whose "real" usage (as a CJK-heavy conversation would
  // report) is 3x the estimate — above it.
  const cm = new ContextManager(2000)
  const bigToolOutput = Array.from({ length: 8 }, (_, i) => `line ${i} ` + 'y'.repeat(212)).join('\n')
  const messages: ChatMessage[] = [
    { role: 'user', content: 'x'.repeat(300) },
    { role: 'tool', tool_call_id: 't1', content: bigToolOutput },
  ]
  const est = estimateTokens(messages)
  assert.ok(est < 1000, `estimate ${est} should start below the snip threshold`)

  // uncalibrated: below threshold, nothing happens
  assert.equal(await cm.maybeCompress([...messages]), false)

  // the API reports 3x the estimate (CJK reality); now the same messages
  // measure above the threshold and layer 1 fires
  cm.observe(est * 3, messages)
  assert.equal(cm.measure(messages), est * 3)
  const compressed = await cm.maybeCompress(messages)
  assert.equal(compressed, true)
  const tool = messages.find(m => m.role === 'tool')!
  assert.ok(tool.content.includes('snipped'), 'verbose tool output was snipped')
})
