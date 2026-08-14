/**
 * Search-and-replace file editing (Claude Code's key innovation).
 *
 * The core idea: instead of sending whole-file rewrites or line-number
 * patches, the LLM specifies an *exact* substring to find and its
 * replacement. The substring must appear exactly once in the file, which
 * eliminates ambiguity and makes edits safe and reviewable.
 */

import { promises as fs } from 'node:fs'
import type { Tool } from './base.js'
import { expandPath } from './paths.js'

/** Files changed this session, for the /diff command. */
export const changedFiles = new Set<string>()

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

/**
 * Generate a compact unified diff between old and new content.
 *
 * Python gets this from difflib; Node has no built-in, so we exploit the
 * shape of the problem: a unique-match replacement changes exactly one
 * contiguous region, so common-prefix/common-suffix line trimming finds
 * the hunk without a general diff algorithm.
 */
export function unifiedDiff(oldText: string, newText: string, filename: string, context = 3): string {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  // common prefix / suffix (suffix must not overlap the prefix)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix)
  const newChanged = newLines.slice(prefix, newLines.length - suffix)
  if (oldChanged.length === 0 && newChanged.length === 0) return '(no changes)'

  const ctxBefore = Math.min(context, prefix)
  const ctxAfter = Math.min(context, suffix)
  const oldStart = prefix - ctxBefore + 1 // 1-based
  const oldCount = oldChanged.length + ctxBefore + ctxAfter
  const newStart = oldStart
  const newCount = newChanged.length + ctxBefore + ctxAfter

  const lines: string[] = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
  ]
  for (const ln of oldLines.slice(prefix - ctxBefore, prefix)) lines.push(` ${ln}`)
  for (const ln of oldChanged) lines.push(`-${ln}`)
  for (const ln of newChanged) lines.push(`+${ln}`)
  for (const ln of oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + ctxAfter)) {
    lines.push(` ${ln}`)
  }

  let result = lines.join('\n') + '\n'
  // truncate enormous diffs
  if (result.length > 3000) result = result.slice(0, 2500) + '\n... (diff truncated)\n'
  return result
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Edit a file by replacing an exact string match. ' +
    'old_string must appear exactly once in the file for safety. ' +
    'Include enough surrounding context to ensure uniqueness.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file to edit' },
      old_string: { type: 'string', description: 'Exact text to find (must be unique in file)' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },

  async execute(args) {
    const filePath = String(args.file_path ?? '')
    const oldString = String(args.old_string ?? '')
    const newString = String(args.new_string ?? '')

    try {
      const p = expandPath(filePath)
      const exists = await fs.stat(p).catch(() => null)
      if (!exists) return `Error: ${filePath} not found`

      const buf = await fs.readFile(p)
      // reject binary content the way Python's strict utf-8 decode does:
      // a real text file round-trips through utf8 losslessly
      const content = buf.toString('utf8')
      if (Buffer.compare(Buffer.from(content, 'utf8'), buf) !== 0) {
        return `Error: ${filePath} is not a UTF-8 text file (edit_file only edits text files)`
      }

      const occurrences = countOccurrences(content, oldString)
      if (occurrences === 0) {
        const preview = content.slice(0, 500) + (content.length > 500 ? '...' : '')
        return `Error: old_string not found in ${filePath}.\nFile starts with:\n${preview}`
      }
      if (occurrences > 1) {
        return (
          `Error: old_string appears ${occurrences} times in ${filePath}. ` +
          'Include more surrounding lines to make it unique.'
        )
      }

      const newContent = content.replace(oldString, newString)
      await fs.writeFile(p, newContent, 'utf8')
      changedFiles.add(p)

      // return a diff so the user/LLM can see exactly what changed
      const diff = unifiedDiff(content, newContent, p)
      return `Edited ${filePath}\n${diff}`
    } catch (e) {
      return `Error: ${e}`
    }
  },
}
