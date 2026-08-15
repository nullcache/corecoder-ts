/** Content search with regex support. */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Tool } from './base.js'
import { globToRegExp } from './glob.js'
import { expandPath } from './paths.js'

// skip these dirs to avoid noise
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'dist',
  'build',
])
const MAX_FILES = 5000
const MAX_MATCHES = 200

async function collectFiles(root: string, include?: string, signal?: AbortSignal): Promise<string[]> {
  const includeRe = include ? globToRegExp(include.includes('/') ? include : `**/${include}`) : null
  const results: string[] = []
  const stack = ['']
  while (stack.length > 0 && results.length < MAX_FILES) {
    // walking up to 5000 files can take seconds; stop promptly on Ctrl+C
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const relDir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(rel)
      } else if (entry.isFile()) {
        if (!includeRe || includeRe.test(rel)) results.push(path.join(root, rel))
        if (results.length >= MAX_FILES) break
      }
    }
  }
  return results
}

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search file contents with regex. Returns matching lines with file path and line number.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search (default: cwd)' },
      include: { type: 'string', description: "Only search files matching this glob (e.g. '*.py')" },
    },
    required: ['pattern'],
  },

  async execute(args, signal?: AbortSignal) {
    const pattern = String(args.pattern ?? '')
    const searchPath = String(args.path ?? '.')
    const include = args.include ? String(args.include) : undefined

    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (e) {
      return `Invalid regex: ${e}`
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const base = expandPath(searchPath)
    const stat = await fs.stat(base).catch(() => null)
    if (!stat) return `Error: ${searchPath} not found`

    const files = stat.isFile() ? [base] : await collectFiles(base, include, signal)

    const matches: string[] = []
    for (const fp of files) {
      // grep reads each file fully; check so a large tree still aborts promptly
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      let text: string
      try {
        text = await fs.readFile(fp, 'utf8')
      } catch {
        continue
      }
      let lineno = 0
      for (const line of text.split('\n')) {
        lineno++
        if (regex.test(line)) {
          matches.push(`${fp}:${lineno}: ${line.trimEnd()}`)
          if (matches.length >= MAX_MATCHES) {
            matches.push(`... (${MAX_MATCHES} match limit reached)`)
            return matches.join('\n')
          }
        }
      }
    }

    return matches.length > 0 ? matches.join('\n') : 'No matches found.'
  },
}
