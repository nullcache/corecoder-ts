/**
 * Shell command execution with safety checks.
 *
 * Claude Code's BashTool is 1,143 lines. This is the distilled version:
 * - Output capture with truncation (head+tail preserved)
 * - Timeout support
 * - Dangerous command detection (a regex blacklist — guards against slips,
 *   not a security sandbox)
 * - Working directory tracking (cd awareness)
 */

import { exec } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Tool } from './base.js'

// Track cwd across commands (Claude Code does this too). The Python version
// uses a thread-local because its tools run on a thread pool; in Node all
// tool executions share one event loop, so a module-level variable has no
// data race — concurrent bash calls just apply their cd updates in
// completion order.
let trackedCwd: string | null = null

/** Test seam: reset cwd tracking between test cases. */
export function resetCwdTracking(): void {
  trackedCwd = null
}

// patterns that could wreck the filesystem or leak secrets
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  // recursive delete aimed at root/home (force flag optional)
  [/\brm\s+(-\w*)?-r\w*\s+(\/|~|\$HOME)/, 'recursive delete on home/root'],
  // recursive (-r/-R) and force (-f) flags together, in any order or spacing
  [/\brm\b(?=(?:.*\s)?-\w*[rR])(?=(?:.*\s)?-\w*f)/, 'force recursive delete'],
  // the same, written with long-form flags
  [/\brm\b.*--recursive\b.*--force\b|\brm\b.*--force\b.*--recursive\b/, 'force recursive delete'],
  [/\bmkfs\b/, 'format filesystem'],
  [/\bdd\s+.*of=\/dev\//, 'raw disk write'],
  [/>\s*\/dev\/sd[a-z]/, 'overwrite block device'],
  [/\bchmod\s+(-R\s+)?777\s+\//, 'chmod 777 on root'],
  [/:\(\)\s*\{.*:\|:.*\}/, 'fork bomb'],
  [/\bcurl\b.*\|\s*(sudo\s+)?(ba)?sh\b/, 'pipe curl to shell'],
  [/\bwget\b.*\|\s*(sudo\s+)?(ba)?sh\b/, 'pipe wget to shell'],
]

function checkDangerous(cmd: string): string | null {
  for (const [pattern, reason] of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) return reason
  }
  return null
}

/**
 * Track directory changes from cd commands.
 *
 * Walk each cd in a && chain, resolving relative targets against the dir the
 * previous cd landed in (not the original cwd) so `cd a && cd b` ends in a/b.
 */
async function updateCwd(command: string, currentCwd: string): Promise<void> {
  let running = currentCwd
  let changed = false
  for (let part of command.split('&&')) {
    part = part.trim()
    if (!part.startsWith('cd ')) continue
    let target = part.slice(3).trim().replace(/^['"]|['"]$/g, '')
    if (!target) continue
    if (target === '~' || target.startsWith('~/')) {
      target = path.join(os.homedir(), target.slice(1))
    }
    const newDir = path.normalize(path.resolve(running, target))
    try {
      if ((await fs.stat(newDir)).isDirectory()) {
        running = newDir
        changed = true
      }
    } catch {
      // target doesn't exist — ignore, same as the Python version
    }
  }
  if (changed) trackedCwd = running
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise(resolve => {
    let timedOut = false
    const child = exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // exec's error covers both non-zero exit and kill-by-timeout
        if (error && (error as { killed?: boolean }).killed) timedOut = true
        resolve({ stdout, stderr, code: error ? (error.code as number | null) ?? null : 0, timedOut })
      },
    )
    child.on('error', () => {
      /* spawn failure surfaces through the exec callback's error */
    })
  })
}

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Execute a shell command. Returns stdout, stderr, and exit code. ' +
    'Use this for running tests, installing packages, git operations, etc.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
      timeout: { type: 'integer', description: 'Timeout in seconds (default 120)' },
    },
    required: ['command'],
  },

  async execute(args) {
    const command = String(args.command ?? '')
    const timeout = typeof args.timeout === 'number' ? args.timeout : 120

    // safety check
    const warning = checkDangerous(command)
    if (warning) {
      return `⚠ Blocked: ${warning}\nCommand: ${command}\nIf intentional, modify the command to be more specific.`
    }

    const cwd = trackedCwd ?? process.cwd()

    try {
      const { stdout, stderr, code, timedOut } = await runShell(command, cwd, timeout * 1000)
      if (timedOut) return `Error: timed out after ${timeout}s`

      // track cd commands so the next command runs in the right place
      if (code === 0) await updateCwd(command, cwd)

      let out = stdout
      if (stderr) out += `\n[stderr]\n${stderr}`
      if (code !== 0) out += `\n[exit code: ${code}]`
      // keep head + tail to preserve the most useful info
      if (out.length > 15_000) {
        out = out.slice(0, 6000) + `\n\n... truncated (${out.length} chars total) ...\n\n` + out.slice(-3000)
      }
      return out.trim() || '(no output)'
    } catch (e) {
      return `Error running command: ${e}`
    }
  },
}
