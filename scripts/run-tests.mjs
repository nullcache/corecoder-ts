#!/usr/bin/env node
/**
 * Cross-version test runner.
 *
 * `node --test <glob>` only expands glob patterns itself since Node 21, but
 * this package claims engines >= 18.17 — on Node 18/20, and on Windows cmd
 * where the shell never expands the pattern either, `dist/tests/*.test.js`
 * is passed through literally and the run fails. Resolve the compiled test
 * files here and hand node the explicit list instead, so `npm test` behaves
 * the same on every supported Node version and platform.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../dist/tests/', import.meta.url))
const files = readdirSync(dir)
  .filter(f => f.endsWith('.test.js'))
  .sort()
  .map(f => path.join(dir, f))

if (files.length === 0) {
  console.error('run-tests: no compiled test files found in dist/tests/')
  process.exit(1)
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(res.status ?? 1)
