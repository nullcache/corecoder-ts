/**
 * Static token-estimate tests: the UTF-8-byte heuristic (~3 bytes/token)
 * and the fixed-overhead addition. Deliberately nothing about calibration —
 * the estimate never learns from usage, so every expectation below is an
 * exact, deterministic number.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Agent } from '../src/agent.js'
import { ContextManager, estimateTokens } from '../src/context.js'
import { ScriptedLLM, type ChatMessage } from '../src/llm.js'

const msg = (role: ChatMessage['role'], content: string): ChatMessage =>
  ({ role, content }) as ChatMessage

test('the estimate is UTF-8 bytes over three — exact values, all scripts', () => {
  assert.equal(estimateTokens([msg('user', 'abc')]), 1) // 3 bytes
  assert.equal(estimateTokens([msg('user', 'abcd')]), 2) // ceil(4/3)
  assert.equal(estimateTokens([msg('user', '汉'.repeat(10))]), 10) // 30 bytes → ~1 token/char
  assert.equal(estimateTokens([msg('user', 'hi 汉字')]), 3) // 3 + 6 bytes
  assert.equal(estimateTokens([msg('user', '😀')]), 2) // 4 UTF-8 bytes, no UTF-16 pitfalls
})

test('measure adds the fixed overhead to the message estimate', () => {
  const cm = new ContextManager(100_000)
  cm.setFixedOverhead('x'.repeat(600)) // 600 bytes → 200 tokens
  assert.equal(cm.measure([]), 200) // an empty history still costs the overhead
  assert.equal(cm.measure([msg('user', '汉'.repeat(66))]), 266) // 66 + 200
})

test('agent registers system prompt and tool schemas as fixed overhead', () => {
  const agent = new Agent({ llm: new ScriptedLLM([]) })
  // empty history still measures the fixed overhead, not zero
  assert.ok(agent.context.measure(agent.messages) > 0)
})
