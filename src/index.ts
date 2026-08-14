/**
 * Public library surface — mirror of `from corecoder import Agent, LLM`:
 *
 *   import { Agent, LLM } from 'corecoder-ts'
 *
 *   const llm = new LLM({ model: 'deepseek-chat', apiKey: 'sk-...', baseUrl: 'https://api.deepseek.com' })
 *   const agent = new Agent({ llm })
 *   for await (const event of agent.chat('list every TODO in this project')) { ... }
 */

export { Agent, type AgentEvent, type AgentOptions } from './agent.js'
export { ContextManager, estimateTokens } from './context.js'
export { configFromEnv, type Config } from './config.js'
export {
  LLM,
  LLMResponse,
  ScriptedLLM,
  drain,
  type ChatMessage,
  type LLMClient,
  type ToolCallReq,
  type ToolSchema,
} from './llm.js'
export { systemPrompt } from './prompt.js'
export { listSessions, loadSession, saveSession } from './session.js'
export { toSchema, missingArgs, type Tool } from './tools/base.js'
export { ALL_TOOLS, getTool } from './tools/index.js'
