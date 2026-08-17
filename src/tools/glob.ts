/**
 * File pattern matching.
 *
 * Python gets glob semantics from pathlib for free; Node has none built in
 * (fs.glob only landed in Node 22), so we compile the pattern to a RegExp
 * ourselves — which doubles as a tiny lesson in how globs actually work.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Tool } from './base.js'
import { expandPath } from './paths.js'

/** Compile a glob pattern to a RegExp over posix-style relative paths. */
export function globToRegExp(pattern: string): RegExp {
  // normalize Windows separators so `src\**\*.ts` behaves like `src/**/*.ts`
  // (the walk produces /-joined relative paths, so a literal \ can never match)
  pattern = pattern.replace(/\\/g, '/')
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more whole segments; bare `**` matches anything
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
      } else {
        re += '[^/]*'
        i += 1
      }
    } else if (ch === '?') {
      re += '[^/]'
      i += 1
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }
  return new RegExp(`^${re}$`)
}

// Unlike Python's pathlib.glob we skip dependency/VCS dirs: recursing into
// node_modules in a JS project makes ** patterns unusably slow.
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build'])
const MAX_WALK = 20_000

async function walk(
  root: string,
): Promise<{ files: Array<{ rel: string; abs: string; mtime: number }>; truncated: boolean }> {
  const files: Array<{ rel: string; abs: string; mtime: number }> = []
  const stack = ['']
  let truncated = false
  while (stack.length > 0) {
    if (files.length >= MAX_WALK) {
      // stop walking but tell the caller the result is incomplete — a silent
      // cap would look like the repo simply has no more matching files
      truncated = true
      break
    }
    const relDir = stack.pop()!
    const absDir = path.join(root, relDir)
    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(rel)
      } else if (entry.isFile()) {
        let mtime = 0
        try {
          mtime = (await fs.stat(path.join(root, rel))).mtimeMs
        } catch {
          // stat raced with deletion; keep the entry with mtime 0
        }
        files.push({ rel, abs: path.join(root, rel), mtime })
      }
    }
  }
  return { files, truncated }
}

export const globTool: Tool = {
  name: 'glob',
  description:
    "Find files matching a glob pattern. Supports ** for recursive matching (e.g. '**/*.py').",
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: "Glob pattern, e.g. '**/*.py' or 'src/**/*.ts'" },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
    },
    required: ['pattern'],
  },

  async execute(args) {
    const pattern = String(args.pattern ?? '')
    const searchPath = String(args.path ?? '.')

    try {
      const base = expandPath(searchPath)
      const stat = await fs.stat(base).catch(() => null)
      if (!stat?.isDirectory()) return `Error: ${searchPath} is not a directory`

      const regex = globToRegExp(pattern)
      const { files, truncated } = await walk(base)
      const hits = files.filter(f => regex.test(f.rel))

      // sort by mtime, newest first
      hits.sort((a, b) => b.mtime - a.mtime)

      const total = hits.length
      const shown = hits.slice(0, 100)
      let result = shown.map(h => h.abs).join('\n')
      if (truncated) result += `\n... (search capped at ${MAX_WALK} files, results truncated)`
      if (total > 100) result += `\n... (${total} matches, showing first 100)`
      return result || 'No files matched.'
    } catch (e) {
      return `Error: ${e}`
    }
  },
}
