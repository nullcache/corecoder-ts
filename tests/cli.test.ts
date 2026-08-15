/** CLI contract tests: exit codes and version sync. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// importing cli.js is safe: isDirectRun guards against running main()
import { turnExitCode, VERSION } from '../src/cli.js'

test('turnExitCode: 0 success, 130 interrupt, 1 error', () => {
  assert.equal(turnExitCode({ text: 'done', aborted: false }), 0)
  assert.equal(turnExitCode({ text: 'done', aborted: true }), 0)
  assert.equal(turnExitCode({ text: null, aborted: true }), 130)
  assert.equal(turnExitCode({ text: null, aborted: false }), 1)
})

test('CLI version is read from package.json (single source of truth)', () => {
  // from dist/tests/ the package.json is two levels up
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
})
