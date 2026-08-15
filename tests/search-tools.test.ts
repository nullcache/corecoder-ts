/**
 * Search tool behavior: normal-path regression tests for glob/grep after
 * the truncation-visibility change. (The truncation branches themselves need
 * >20k files to trigger, so they're covered by code review, not tests.)
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { globTool } from '../src/tools/glob.js'
import { grepTool } from '../src/tools/grep.js'

test('glob tool matches a small tree without truncation noise', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-glob-'))
  await fs.writeFile(path.join(dir, 'a.ts'), 'x')
  await fs.writeFile(path.join(dir, 'b.js'), 'y')
  await fs.mkdir(path.join(dir, 'sub'))
  await fs.writeFile(path.join(dir, 'sub', 'c.ts'), 'z')
  try {
    const out = await globTool.execute({ pattern: '**/*.ts', path: dir })
    assert.ok(out.includes('a.ts'), 'top-level match found')
    assert.ok(out.includes(path.join('sub', 'c.ts')), 'nested match found')
    assert.ok(!out.includes('b.js'), 'non-matching extension excluded')
    assert.ok(!out.includes('truncated'), 'no truncation note on a small tree')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('grep tool searches a small tree and reports the match', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-grep-'))
  await fs.writeFile(path.join(dir, 'f.txt'), 'hello world\nnothing here\n')
  try {
    const out = await grepTool.execute({ pattern: 'hello', path: dir })
    assert.ok(out.includes('f.txt:1'), 'match reports path and line number')
    assert.ok(out.includes('hello world'), 'match line content present')
    assert.ok(!out.includes('truncated'), 'no truncation note on a small tree')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
