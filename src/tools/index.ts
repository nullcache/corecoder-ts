/** Tool registry. */

import type { Tool } from './base.js'
import { SubAgentTool } from './agent.js'
import { bashTool } from './bash.js'
import { editFileTool } from './edit.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { readFileTool } from './read.js'
import { writeFileTool } from './write.js'

export const ALL_TOOLS: Tool[] = [
  bashTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  new SubAgentTool(),
]

/** Look up a tool by name. */
export function getTool(name: string): Tool | null {
  return ALL_TOOLS.find(t => t.name === name) ?? null
}
