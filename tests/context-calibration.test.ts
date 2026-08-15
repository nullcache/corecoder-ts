/**
 * Calibration tests: the fixed per-request overhead (system prompt + tool
 * schemas) must be counted explicitly, otherwise compression silently
 * distorts the estimate and pushes the compression thresholds too late.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Agent } from '../src/agent.js'
import { ContextManager, estimateTokens } from '../src/context.js'
import { ScriptedLLM, type ChatMessage } from '../src/llm.js'

const msg = (role: ChatMessage['role'], content: string): ChatMessage =>
  ({ role, content }) as ChatMessage

test('fixed overhead is counted in observe and measure', () => {
  const cm = new ContextManager(100_000)
  cm.setFixedOverhead('system ' + 'x'.repeat(600)) // ~202 tokens of fixed text

  const messages = [msg('user', 'hello')]
  // naive estimate: 5 chars / 3 ≈ 1 token; with overhead ≈ 203
  cm.observe(203, messages)

  assert.equal(cm.measure(messages), 203)
})

test('measure stays honest after the conversation shrinks', () => {
  const cm = new ContextManager(100_000)
  cm.setFixedOverhead('system ' + 'x'.repeat(600)) // ~202 tokens fixed

  // a long conversation: 20 messages × ~153 chars each ≈ 1000 estimate tokens
  const big: ChatMessage[] = Array.from({ length: 20 }, (_, i) =>
    msg('user', 'q' + i + ' ' + 'y'.repeat(150)),
  )
  const estBig = estimateTokens(big)
  assert.ok(estBig > 950 && estBig < 1100, 'sanity: big estimate ~1000, got ' + estBig)

  // the API bills ~1000 + 202 overhead; calibrate against that
  const realBig = estBig + 202
  cm.observe(realBig, big)

  // now the conversation got compressed to a tiny summary
  const small = [msg('user', '[Context compressed]\nshort summary here')]

  // with fixed overhead counted: estimate = ~10 + 202 = 212, measure ≈ 212
  // without it: ratio ≈ (1000+202)/1000 ≈ 1.2 applied to ~10 → ~12, a ~95% underestimate
  const measured = cm.measure(small)
  assert.ok(
    measured >= 190 && measured <= 230,
    'measure should reflect the fixed overhead, got ' + measured + ' (naive would be ~12)',
  )
})

test('without fixed overhead the estimator behaves as before', () => {
  const cm = new ContextManager(100_000)
  const messages = [msg('user', 'a'.repeat(300))] // ~100 estimate tokens
  cm.observe(150, messages) // real is 1.5× the estimate
  assert.equal(cm.measure(messages), 150)
})

test('agent registers system prompt and tool schemas as fixed overhead', () => {
  const agent = new Agent({ llm: new ScriptedLLM([]) })
  // empty history still measures the fixed overhead, not zero
  const measured = agent.context.measure(agent.messages)
  assert.ok(measured > 0, 'empty history should measure the fixed overhead, got ' + measured)
})
