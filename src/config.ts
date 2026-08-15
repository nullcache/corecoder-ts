/** Configuration — env vars and defaults. */

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Load .env from cwd, walking up to the home dir. Hand-rolled (~20 lines)
 * instead of a dependency: KEY=VALUE lines, # comments, optional quotes,
 * never overrides variables already set in the environment.
 */
function loadDotenv(): void {
  let envPath: string | null = null
  let cur = process.cwd()
  const home = os.homedir()
  while (true) {
    const candidate = path.join(cur, '.env')
    try {
      readFileSync(candidate)
      envPath = candidate
      break
    } catch {
      // keep walking up
    }
    const parent = path.dirname(cur)
    if (cur === home || parent === cur) break
    cur = parent
  }
  if (!envPath) return

  const text = readFileSync(envPath, 'utf8')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key && !(key in process.env)) process.env[key] = value
  }
}

export interface Config {
  model: string
  apiKey: string
  baseUrl: string | null
  maxTokens: number
  temperature: number
  maxContextTokens: number
  /** Per-request timeout for the LLM client, in ms. */
  timeoutMs: number
}

export function configFromEnv(): Config {
  // load .env if present (won't override existing env vars)
  loadDotenv()
  // pick up common env vars automatically
  const apiKey =
    process.env.CORECODER_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || ''

  return {
    model: process.env.CORECODER_MODEL || 'gpt-5.5',
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL || process.env.CORECODER_BASE_URL || null,
    maxTokens: parseInt(process.env.CORECODER_MAX_TOKENS || '4096', 10),
    temperature: parseFloat(process.env.CORECODER_TEMPERATURE || '0'),
    maxContextTokens: parseInt(process.env.CORECODER_MAX_CONTEXT || '128000', 10),
    timeoutMs: parseInt(process.env.CORECODER_TIMEOUT_MS || '300000', 10),
  }
}
