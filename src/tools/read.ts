/** File reading with line numbers. */

import { promises as fs } from 'node:fs'
import type { Tool } from './base.js'
import { expandPath } from './paths.js'

export const readFileTool: Tool = {
  name: 'read_file',
  description: "Read a file's contents with line numbers. Always read a file before editing it.",
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file' },
      offset: { type: 'integer', description: 'Start line (1-based). Default 1.' },
      limit: { type: 'integer', description: 'Max lines to read. Default 2000.' },
    },
    required: ['file_path'],
  },

  async execute(args) {
    const filePath = String(args.file_path ?? '')
    const offset = typeof args.offset === 'number' ? args.offset : 1
    const limit = typeof args.limit === 'number' ? args.limit : 2000

    try {
      const p = expandPath(filePath)
      const stat = await fs.stat(p).catch(() => null)
      if (!stat) return `Error: ${filePath} not found`
      if (stat.isDirectory()) return `Error: ${filePath} is a directory, not a file`

      const text = await fs.readFile(p, 'utf8')
      const lines = text.split('\n')
      // split('\n') on a trailing-newline file yields a phantom empty last element
      if (lines.at(-1) === '') lines.pop()
      const total = lines.length

      const start = Math.max(0, offset - 1)
      const chunk = lines.slice(start, start + limit)
      // Cap line width (matches Claude Code's 2000-char/line cap): a one-line
      // minified file would otherwise flood the context, and the compressor's
      // snip layer can't cut single-line tool outputs.
      const numbered = chunk.map((ln, i) => {
        const text = ln.length > 2000 ? ln.slice(0, 2000) + '… (line truncated)' : ln
        return `${start + i + 1}\t${text}`
      })
      let result = numbered.join('\n')

      if (total > start + limit) {
        result += `\n... (${total} lines total, showing ${start + 1}-${start + chunk.length})`
      }
      return result || '(empty file)'
    } catch (e) {
      return `Error: ${e}`
    }
  },
}
