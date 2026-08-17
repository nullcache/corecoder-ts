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
 * Fresh default toolset. A factory on purpose — and the only export:
 * SubAgentTool carries a per-Agent `parentAgent` reference, so any shared
 * instance list (the old ALL_TOOLS) would be silently re-pointed by every
 * Agent constructed, sending the first agent's sub-agents off with the
 * second agent's LLM client and context.
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
