/** Tests for the streaming markdown renderer. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { StreamRenderer } from '../src/render.js'

function capture(color = true) {
  const out: string[] = []
  const r = new StreamRenderer(s => out.push(s), color)
  return { r, out }
}

test('render: heading assembles across split deltas, renders bold', () => {
  const { r, out } = capture()
  r.push('# He')
  assert.equal(out.length, 0) // incomplete line — nothing printed yet
  r.push('llo\nplain\n')
  assert.equal(out.length, 2)
  assert.ok(out[0]!.includes('\x1b[1m'), 'heading is bold')
  assert.ok(out[0]!.includes('Hello'))
  assert.equal(out[1], 'plain\n')
})

test('render: code fence state machine colors the block', () => {
  const { r, out } = capture()
  r.push('```js\nconst x = 1\n```\nafter\n')
  assert.ok(out[0]!.includes('\x1b[2m'), 'opening fence dim')
  assert.ok(out[1]!.includes('\x1b[33m'), 'code line colored')
  assert.ok(out[1]!.includes('const x = 1'))
  assert.ok(out[2]!.includes('\x1b[2m'), 'closing fence dim')
  assert.equal(out[3], 'after\n')
})

test('render: inline code protects its content from bold rewriting', () => {
  const { r, out } = capture()
  r.push('use `a ** b` and **bold**\n')
  const line = out[0]!
  assert.ok(line.includes('a ** b'), 'stars inside code span intact')
  assert.ok(line.includes('\x1b[1mbold\x1b[22m'), 'bold outside code span applied')
})

test('render: list bullets and links', () => {
  const { r, out } = capture()
  r.push('- see [docs](https://x.dev)\n')
  const line = out[0]!
  assert.ok(line.includes('\x1b[36m-\x1b[39m'), 'bullet colored')
  assert.ok(line.includes('docs'))
  assert.ok(line.includes('(https://x.dev)'))
})

test('render: bold and link on the same line do not interfere', () => {
  // regression: bold emits \x1b[1m whose literal '[' used to be misread as
  // a link opener when bold ran before the link rewrite
  const { r, out } = capture()
  r.push('**bold** then [docs](https://x.dev)\n')
  const line = out[0]!
  assert.ok(line.includes('\x1b[1mbold\x1b[22m'), 'bold intact')
  assert.ok(line.includes('docs'))
  assert.ok(line.includes('\x1b[2m(https://x.dev)\x1b[22m'), 'url dim and parenthesized')
  // the bug left a half-eaten bold code behind: a bare ESC directly followed
  // by the link's ESC sequence
  assert.ok(!line.includes('\x1b\x1b'), 'no orphaned ESC from a half-eaten ANSI code')
})

test('render: color=false passes text through verbatim', () => {
  const { r, out } = capture(false)
  r.push('# Hello **world**\n')
  assert.equal(out[0], '# Hello **world**\n')
})

test('render: flush prints the trailing partial line and resets fence state', () => {
  const { r, out } = capture()
  r.push('```\ncode without closing fence')
  r.flush()
  assert.equal(out.length, 2)
  // after flush, fence state is reset: new lines render as prose again
  r.push('**back to prose**\n')
  assert.ok(out[2]!.includes('\x1b[1mback to prose\x1b[22m'))
})
