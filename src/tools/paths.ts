/** Shared path helpers for tools. */

import os from 'node:os'
import path from 'node:path'

// The cd-tracked working directory, shared by ALL tools. bash updates it
// when a command chain cd's somewhere; every tool resolves relative paths
// against it via expandPath. Keeping it here (not in bash.ts) is what makes
// `cd src && ...` followed by read_file('utils.ts') land in src/ instead of
// the process cwd. Like the Python original, sub-agents share it — a
// documented simplification, not an accident.
let trackedCwd: string | null = null

/** The directory relative tool paths resolve against. */
export function getTrackedCwd(): string {
  return trackedCwd ?? process.cwd()
}

export function setTrackedCwd(dir: string | null): void {
  trackedCwd = dir
}

/** Expand a leading ~ and resolve to an absolute path (Python's expanduser().resolve()). */
export function expandPath(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    p = path.join(os.homedir(), p.slice(1))
  }
  return path.resolve(getTrackedCwd(), p)
}
