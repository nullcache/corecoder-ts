/**
 * Cancellation tests: AbortSignal flows through tool boundaries so Ctrl+C
 * actually stops a running bash command, a sub-agent, or a directory walk —
 * instead of leaving the agent waiting for the tool to finish.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Agent } from '../src/agent.js'
import { LLMResponse, ScriptedLLM, drain, type LLMClient } from '../src/llm.js'
import { bashTool } from '../src/tools/bash.js'
import { globTool } from '../src/tools/glob.js'
import { grepTool } from '../src/tools/grep.js'

const isAbort = (e: Error) => e.name === 'AbortError'
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

test('bash tool kills a running child when the signal aborts', async () => {
  const ac = new AbortController()
  const running = bashTool.execute(
    { command: 'node -e "setTimeout(()=>{}, 10000)"' }, // runs for 10s unless killed
    ac.signal,
  )

  await pause(300)
  const t0 = Date.now()
  ac.abort()

  await assert.rejects(running, isAbort)
  assert.ok(Date.now() - t0 < 5000, 'abort must not wait for the child to finish on its own')
})

test('agent aborts a running tool and backfills [interrupted] replies', async () => {
  const script = [
    new LLMResponse('', [{ id: 't1', name: 'bash', arguments: { command: 'node -e "setTimeout(()=>{}, 10000)"' } }]),
  ]
  const agent = new Agent({ llm: new ScriptedLLM(script) })
  const ac = new AbortController()

  const turn = drain(agent.chat('run a long command', ac.signal))
  await pause(300)
  ac.abort()

  await assert.rejects(turn, isAbort)
  const toolMsg = agent.messages.find(m => m.role === 'tool')
  assert.ok(toolMsg, 'pending tool call must be answered after abort')
  assert.equal(toolMsg!.tool_call_id, 't1')
  assert.equal(toolMsg!.content, '[interrupted]')
})

test('abort propagates through the sub-agent tool to the sub-agent\'s LLM call', async () => {
  let calls = 0
  const llm: LLMClient = {
    model: 'slow',
    totalPromptTokens: 0,
    usageSeen: true,
    totalCompletionTokens: 0,
    estimatedCost: null,
    async *chat(_messages, _tools, signal) {
      calls++
      if (calls === 1) {
        // parent\'s first turn: ask for a sub-agent
        return new LLMResponse('', [{ id: 'a1', name: 'agent', arguments: { task: 'do work' } }])
      }
      // the sub-agent\'s turn: hang until the parent\'s signal reaches it
      await new Promise<void>((_, reject) => {
        const t = setTimeout(() => reject(new Error('unreachable: sub-agent not aborted')), 15000)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            reject(new DOMException('Aborted', 'AbortError'))
          },
          { once: true },
        )
      })
      return new LLMResponse('done')
    },
  }
  const agent = new Agent({ llm })
  const ac = new AbortController()

  const turn = drain(agent.chat('delegate this', ac.signal))
  await pause(300)
  ac.abort()

  await assert.rejects(turn, isAbort)
  const toolMsg = agent.messages.find(m => m.role === 'tool')
  assert.ok(toolMsg, 'sub-agent tool call must be answered after abort')
  assert.equal(toolMsg!.content, '[interrupted]')
})

test('pre-aborted signals make glob and grep reject immediately', async () => {
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(globTool.execute({ pattern: '**', path: '.' }, ac.signal), isAbort)
  await assert.rejects(grepTool.execute({ pattern: 'x', path: '.' }, ac.signal), isAbort)
})
