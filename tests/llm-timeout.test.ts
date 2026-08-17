/**
 * Request timeout tests: a provider that accepts the connection and never
 * answers must not hang the agent forever, and a user cancellation must
 * never be mistaken for a timeout.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LLM, drain } from '../src/llm.js'

/** fetch stub that hangs until its signal aborts (the timeout or the user). */
function hungFetch(): typeof fetch {
  return ((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      // real fetch rejects immediately when handed an already-aborted signal;
      // addEventListener alone would never fire and the stub would hang forever
      if (init?.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      )
    })) as typeof fetch
}

function sseResponse(content: string): Response {
  const body =
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"' +
    content +
    '"}}]}\n\n' +
    'data: [DONE]\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

test('a hung provider times out and the retry loop reports it', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = hungFetch()
  const llm = new LLM({ model: 'm', apiKey: 'k', timeoutMs: 50 })
  try {
    await assert.rejects(
      drain(llm.chat([{ role: 'user', content: 'hi' }])),
      (e: Error) => /timed out/.test(e.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a user cancellation is not masked by the timeout', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = hungFetch()
  const llm = new LLM({ model: 'm', apiKey: 'k', timeoutMs: 50 })
  const ac = new AbortController()
  ac.abort() // cancelled before the request even starts
  try {
    await assert.rejects(
      drain(llm.chat([{ role: 'user', content: 'hi' }], undefined, ac.signal)),
      (e: Error) => e.name === 'AbortError',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a timeout is retried and the next attempt succeeds', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = ((_url, init) => {
    calls++
    if (calls === 1) {
      // first attempt hangs until the timeout aborts it
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    }
    return Promise.resolve(sseResponse('ok'))
  }) as typeof fetch
  const llm = new LLM({ model: 'm', apiKey: 'k', timeoutMs: 50 })
  try {
    const parts: string[] = []
    const gen = llm.chat([{ role: 'user', content: 'hi' }])
    let step = await gen.next()
    while (!step.done) {
      parts.push(step.value)
      step = await gen.next()
    }
    assert.deepEqual(parts, ['ok'])
  } finally {
    globalThis.fetch = originalFetch
  }
})
