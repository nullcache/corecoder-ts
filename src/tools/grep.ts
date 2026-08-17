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

async function collectFiles(
  root: string,
  include?: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const includeRe = include ? globToRegExp(include.includes('/') ? include : `**/${include}`) : null
  const files: string[] = []
  const stack = ['']
  let truncated = false
  while (stack.length > 0) {
    if (files.length >= MAX_FILES) {
      // stop collecting but tell the caller — a silent cap would make a
      // huge tree look like it simply has nothing matching
      truncated = true
      break
    }
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
        if (!includeRe || includeRe.test(rel)) files.push(path.join(root, rel))
      }
    }
  }
  return { files, truncated }
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

  async execute(args) {
    const pattern = String(args.pattern ?? '')
    const searchPath = String(args.path ?? '.')
    const include = args.include ? String(args.include) : undefined

    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (e) {
      return `Invalid regex: ${e}`
    }

    const base = expandPath(searchPath)
    const stat = await fs.stat(base).catch(() => null)
    if (!stat) return `Error: ${searchPath} not found`

    const { files, truncated } = stat.isFile()
      ? { files: [base], truncated: false }
      : await collectFiles(base, include)

    const matches: string[] = []
    for (const fp of files) {
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
          // cap match line width (same 2000-char limit as read_file): a single
          // minified line would otherwise flood the context with one mega-match
          const capped =
            line.length > 2000 ? line.slice(0, 2000) + '… (line truncated)' : line
          matches.push(`${fp}:${lineno}: ${capped.trimEnd()}`)
          if (matches.length >= MAX_MATCHES) {
            matches.push(`... (${MAX_MATCHES} match limit reached)`)
            return matches.join('\n')
          }
        }
      }
    }

    if (truncated) {
      // say the search was capped even when nothing matched, so the model
      // doesn't conclude "no matches" from an incomplete search
      if (matches.length === 0) return `No matches found (search capped at ${MAX_FILES} files).`
      matches.push(`... (search capped at ${MAX_FILES} files, results truncated)`)
    }
    return matches.length > 0 ? matches.join('\n') : 'No matches found.'
  },
}
