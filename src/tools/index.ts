/** Tool registry. */

import type { Tool } from './base.js'
import { SubAgentTool } from './agent.js'
import { bashTool } from './bash.js'
import { editFileTool } from './edit.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { readFileTool } from './read.js'
import { writeFileTool } from './write.js'

/**
 * Fresh default toolset. A factory, not a constant: SubAgentTool carries a
 * per-Agent `parentAgent` reference, so a shared instance would be silently
 * re-pointed by every Agent constructed — the first agent's sub-agents would
 * run with the second agent's LLM client and context.
 */
export function makeAllTools(): Tool[] {
  return [
    bashTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    globTool,
    grepTool,
    new SubAgentTool(),
  ]
}

/** A shared instance list, kept for lookups and schema listings. */
export const ALL_TOOLS: Tool[] = makeAllTools()

/** Look up a tool by name. */
export function getTool(name: string): Tool | null {
  return ALL_TOOLS.find(t => t.name === name) ?? null
}
