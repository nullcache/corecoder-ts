/** Base interface for all tools. Implement this to add new capabilities. */

import type { ToolSchema } from '../llm.js'

export interface Tool {
  name: string
  description: string
  /** JSON Schema for the function args. */
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
  /** Run the tool and return a text result. Never throws — errors become strings. */
  execute(args: Record<string, unknown>): Promise<string>
}

/** OpenAI function-calling schema. */
export function toSchema(tool: Tool): ToolSchema {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/**
 * Check required args before execution, so a TypeError raised *inside* the
 * tool isn't mislabelled as a bad-arguments error from the caller. The
 * TypeScript stand-in for Python's inspect.signature().bind().
 */
export function missingArgs(tool: Tool, args: Record<string, unknown>): string[] {
  return (tool.parameters.required ?? []).filter(key => !(key in args))
}
