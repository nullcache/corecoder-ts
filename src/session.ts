/**
 * Session persistence — save and resume conversations.
 *
 * Claude Code maintains session state via QueryEngine (1,295 lines).
 * CoreCoder distills this to: a JSON dump of messages + model config,
 * with the session id sanitized so a malicious name can't traverse out
 * of the sessions directory.
 */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { ChatMessage } from './llm.js'

export const SESSIONS_DIR = path.join(os.homedir(), '.corecoder-ts', 'sessions')

const SAFE_SESSION_RE = /[^A-Za-z0-9._-]+/g
const MAX_SESSION_ID_LEN = 100 // keep filenames comfortably under the OS limit

function newSessionId(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `session_${stamp}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

function normalizeSessionId(sessionId?: string | null): string {
  if (!sessionId) return newSessionId()

  // strip any path components, then whitelist the remaining characters
  let name = sessionId.trim().replaceAll('\\', '/').split('/').at(-1) ?? ''
  name = name.replace(SAFE_SESSION_RE, '-').replace(/^[.\-_]+|[.\-_]+$/g, '')
  if (name.length > MAX_SESSION_ID_LEN) {
    name = name.slice(0, MAX_SESSION_ID_LEN).replace(/^[.\-_]+|[.\-_]+$/g, '')
  }
  return name || newSessionId()
}

function sessionPath(sessionId: string): string {
  const p = path.resolve(SESSIONS_DIR, `${normalizeSessionId(sessionId)}.json`)
  // belt and braces: the resolved file must sit directly inside SESSIONS_DIR
  if (path.dirname(p) !== path.resolve(SESSIONS_DIR)) throw new Error('Invalid session id')
  return p
}

interface SessionFile {
  id: string
  model: string
  saved_at: string
  messages: ChatMessage[]
}

/** Save a conversation to disk. Returns the session ID. */
export async function saveSession(
  messages: ChatMessage[],
  model: string,
  sessionId?: string,
): Promise<string> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true })

  const id = normalizeSessionId(sessionId)
  const data: SessionFile = {
    id,
    model,
    saved_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    messages,
  }

  await fs.writeFile(sessionPath(id), JSON.stringify(data, null, 2), 'utf8')
  return id
}

/** Load a saved session. Returns { messages, model } or null. */
export async function loadSession(
  sessionId: string,
): Promise<{ messages: ChatMessage[]; model: string } | null> {
  try {
    const raw = await fs.readFile(sessionPath(sessionId), 'utf8')
    const data = JSON.parse(raw) as SessionFile
    return { messages: data.messages, model: data.model }
  } catch {
    // a missing, corrupt or truncated session file shouldn't crash resume
    return null
  }
}

export interface SessionSummary {
  id: string
  model: string
  savedAt: string
  preview: string
}

/** List available sessions, newest first (capped at 20). */
export async function listSessions(): Promise<SessionSummary[]> {
  let files: string[]
  try {
    files = (await fs.readdir(SESSIONS_DIR)).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }

  const sessions: SessionSummary[] = []
  for (const f of files.sort().reverse()) {
    try {
      const raw = await fs.readFile(path.join(SESSIONS_DIR, f), 'utf8')
      const data = JSON.parse(raw) as Partial<SessionFile>
      // grab the first user message as a preview
      let preview = ''
      for (const m of data.messages ?? []) {
        if (m.role === 'user' && m.content) {
          preview = m.content.slice(0, 80)
          break
        }
      }
      sessions.push({
        id: data.id ?? f.replace(/\.json$/, ''),
        model: data.model ?? '?',
        savedAt: data.saved_at ?? '?',
        preview,
      })
    } catch {
      continue
    }
  }

  return sessions.slice(0, 20)
}
