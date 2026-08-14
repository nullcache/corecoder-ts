/** File creation / overwrite. */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Tool } from './base.js'
import { changedFiles } from './edit.js'
import { expandPath } from './paths.js'

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Create a new file or completely overwrite an existing one. ' +
    'For small edits to existing files, prefer edit_file instead.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path for the file' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['file_path', 'content'],
  },

  async execute(args) {
    const filePath = String(args.file_path ?? '')
    const content = String(args.content ?? '')

    try {
      const p = expandPath(filePath)
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, content, 'utf8')
      changedFiles.add(p)
      const nLines = (content.match(/\n/g)?.length ?? 0) + (content && !content.endsWith('\n') ? 1 : 0)
      return `Wrote ${nLines} lines to ${filePath}`
    } catch (e) {
      return `Error: ${e}`
    }
  },
}
