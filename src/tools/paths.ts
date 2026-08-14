/** Shared path helpers for tools. */

import os from 'node:os'
import path from 'node:path'

/** Expand a leading ~ and resolve to an absolute path (Python's expanduser().resolve()). */
export function expandPath(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    p = path.join(os.homedir(), p.slice(1))
  }
  return path.resolve(p)
}
