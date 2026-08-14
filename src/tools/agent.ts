/**
 * Sub-agent spawning (inspired by Claude Code's AgentTool, 1,397 lines).
 *
 * The idea: for complex sub-tasks, spawn an independent agent with its own
 * conversation history and tool access. This lets the main agent delegate
 * work like "go research this codebase and report back" without polluting
 * its own context window.
 *
 * The sub-agent is constrained by *withholding the tool*, not by rules: its
 * toolset is the parent's minus `agent` itself, so it can't recurse. It
 * reuses the parent's LLM client (spend folds into the same running total),
 * runs on a shorter round limit, and its output is truncated past 5,000
 * chars. The sub-agent runs to completion and returns a text summary.
 */

import { drain } from '../llm.js'
import type { Tool } from './base.js'
import type { Agent } from '../agent.js'

export class SubAgentTool implements Tool {
  name = 'agent'
  description =
    'Spawn a sub-agent to handle a complex sub-task independently. ' +
    'The sub-agent has its own context and tool access. Use this for: ' +
    'researching a codebase, implementing a multi-step change in isolation, ' +
    'or any task that would benefit from a fresh context window.'
  parameters = {
    type: 'object' as const,
    properties: {
      task: { type: 'string', description: 'What the sub-agent should accomplish' },
    },
    required: ['task'],
  }

  /** Set by Agent's constructor after construction. */
  parentAgent: Agent | null = null

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!this.parentAgent) return 'Error: agent tool not initialized (no parent agent)'

    // dynamic import to avoid a circular dependency at module load time
    // (the Python version does the same with a function-level import)
    const { Agent } = await import('../agent.js')

    const parent = this.parentAgent
    const sub = new Agent({
      llm: parent.llm,
      tools: parent.tools.filter(t => t.name !== 'agent'), // no recursive agents
      maxContextTokens: parent.context.maxTokens,
      maxRounds: 20,
    })

    try {
      // drain the sub-agent's event stream; only its final answer matters here
      let result = await drain(sub.chat(String(args.task ?? '')))
      // trim long results to avoid blowing up the parent's context
      if (result.length > 5000) {
        result = result.slice(0, 4500) + '\n... (sub-agent output truncated)'
      }
      return `[Sub-agent completed]\n${result}`
    } catch (e) {
      return `Sub-agent error: ${e}`
    }
  }
}
