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

import { spawn, type ChildProcess } from 'node:child_process'
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

// match exec's default maxBuffer so a chatty command can't balloon memory
const MAX_OUTPUT = 16 * 1024 * 1024

/**
 * Kill the whole process tree, not just the shell.
 *
 * `shell: true` spawns /bin/sh or cmd.exe, and the real command is its child
 * (grandchild on Windows). A plain kill() takes down only the shell; the
 * command keeps running and still holds the stdout pipe, so the close event —
 * and thus Ctrl+C — would wait for it to finish anyway. POSIX spawns detached
 * (process-group leader), so a negative pid kills the group; Windows has no
 * groups, so use taskkill /T to walk the tree.
 */
function killProcessTree(child: ChildProcess, escalateMs = 5000): NodeJS.Timeout | null {
  if (!child.pid) return null
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    return null // /F is already forceful
  }
  const pgid = child.pid
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {
    child.kill() // process group already gone — nothing left to kill
    return null
  }
  // SIGTERM is only a request — a `trap '' TERM` shell or a wedged process
  // ignores it, 'close' never fires, and the turn hangs forever. Escalate to
  // SIGKILL after a grace period; the caller clears the timer if the process
  // exits in time (so a reused pgid can never be killed by mistake).
  const timer = setTimeout(() => {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // already gone
    }
  }, escalateMs)
  timer.unref()
  return timer
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; truncated: boolean }> {
  return new Promise(resolve => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32', // process-group leader on POSIX
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    let killStarted = false

    // the TERM→KILL sequence runs at most once, no matter how many triggers
    // fire (abort then timeout, etc.) — a second call would orphan the first
    // escalation timer, which settle() could then never clear
    const beginKill = () => {
      if (killStarted) return
      killStarted = true
      killTimer = killProcessTree(child)
    }

    const settle = (result: {
      stdout: string
      stderr: string
      code: number | null
      timedOut: boolean
      truncated: boolean
    }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const onAbort = () => beginKill()
    if (signal?.aborted) {
      beginKill()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      timedOut = true
      beginKill()
    }, timeoutMs)

    // keep consuming even past the cap so the pipe drains and close can fire
    child.stdout.on('data', (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d
      else truncated = true
    })
    child.stderr.on('data', (d: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += d
      else truncated = true
    })
    child.on('error', () => {
      /* spawn failure surfaces through 'close' */
    })
    child.on('close', code => {
      settle({ stdout, stderr, code, timedOut, truncated })
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

  async execute(args, signal?: AbortSignal) {
    const command = String(args.command ?? '')
    const timeout = typeof args.timeout === 'number' ? args.timeout : 120

    // safety check
    const warning = checkDangerous(command)
    if (warning) {
      return `⚠ Blocked: ${warning}\nCommand: ${command}\nIf intentional, modify the command to be more specific.`
    }

    const cwd = trackedCwd ?? process.cwd()

    try {
      const { stdout, stderr, code, timedOut, truncated } = await runShell(
        command,
        cwd,
        timeout * 1000,
        signal,
      )
      // an abort that fired mid-command (the child was killed) is a
      // cancellation, not a tool result — throw so the agent treats it as
      // an interrupt instead of feeding a half-written output to the model
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (timedOut) return `Error: timed out after ${timeout}s`

      // track cd commands so the next command runs in the right place
      if (code === 0) await updateCwd(command, cwd)

      let out = stdout
      if (stderr) out += `\n[stderr]\n${stderr}`
      if (truncated) out += '\n[output truncated at 16MB cap]'
      if (code !== 0) out += `\n[exit code: ${code}]`
      // keep head + tail to preserve the most useful info
      if (out.length > 15_000) {
        out = out.slice(0, 6000) + `\n\n... truncated (${out.length} chars total) ...\n\n` + out.slice(-3000)
      }
      return out.trim() || '(no output)'
    } catch (e) {
      // cancellation must propagate as an interrupt, not become a tool result
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      return `Error running command: ${e}`
    }
  },
}
