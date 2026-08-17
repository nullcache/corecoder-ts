#!/usr/bin/env node
/**
 * Interactive REPL — the user-facing terminal interface.
 *
 * The Python version renders with rich + prompt_toolkit; here everything is
 * node builtins: util.parseArgs for flags, readline/promises for the REPL,
 * and a few raw ANSI escapes for color. Zero runtime dependencies.
 */

import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { parseArgs } from 'node:util'

import { Agent } from './agent.js'
import { estimateTokens } from './context.js'
import { configFromEnv, type Config } from './config.js'
import { LLM, LLMResponse, ScriptedLLM, type LLMClient } from './llm.js'
import { StreamRenderer } from './render.js'
import { listSessions, loadSession, saveSession } from './session.js'
import { changedFiles } from './tools/edit.js'

// Single source of truth: the version in package.json, so a release bump
// can never drift out of sync with --version / the REPL banner. createRequire
// resolves relative to this file (dist/src/cli.js -> ../../package.json),
// which is the same layout in a published npm tarball.
const require = createRequire(import.meta.url)
export const VERSION: string = require('../../package.json').version
const HIST_PATH = path.join(os.homedir(), '.corecoder_ts_history')

// ---------------------------------------------------------------- colors

const useColor = process.stdout.isTTY ?? false
const paint = (open: number, close: number) => (s: string) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s
const bold = paint(1, 22)
const dim = paint(2, 22)
const red = paint(31, 39)
const green = paint(32, 39)
const yellow = paint(33, 39)
const cyan = paint(36, 39)

// ---------------------------------------------------------------- args

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', short: 'm' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      prompt: { type: 'string', short: 'p' },
      demo: { type: 'boolean' },
      resume: { type: 'string', short: 'r' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  return values
}

const USAGE = `Usage: corecoder-ts [options]

Minimal AI coding agent. Works with any OpenAI-compatible LLM.

Options:
  -m, --model <name>   Model name (default: $CORECODER_MODEL or gpt-5.5)
  --base-url <url>     API base URL (default: $OPENAI_BASE_URL)
  --api-key <key>      API key (default: $CORECODER_API_KEY, $OPENAI_API_KEY, or $DEEPSEEK_API_KEY)
  -p, --prompt <text>  One-shot prompt (non-interactive mode)
  --demo               Run the offline scripted demo (no API key needed)
  -r, --resume <id>    Resume a saved session
  -v, --version        Show version
  -h, --help           Show this help`

// ---------------------------------------------------------------- entry

export async function main(): Promise<void> {
  const args = parseCliArgs()

  if (args.help) {
    console.log(USAGE)
    return
  }
  if (args.version) {
    console.log(`corecoder-ts ${VERSION}`)
    return
  }
  if (args.demo) {
    process.exitCode = await runDemo()
    return
  }

  const config = configFromEnv()

  // CLI args override env vars
  if (args.model) config.model = args.model
  if (args['base-url']) config.baseUrl = args['base-url']
  if (args['api-key']) config.apiKey = args['api-key']

  if (!config.apiKey) {
    console.error(red(bold('No API key found.')))
    console.error(
      'Set one of: OPENAI_API_KEY, DEEPSEEK_API_KEY, or CORECODER_API_KEY\n' +
        '\nExamples:\n' +
        '  # OpenAI\n' +
        '  export OPENAI_API_KEY=sk-...\n' +
        '\n' +
        '  # DeepSeek\n' +
        '  export OPENAI_API_KEY=sk-... OPENAI_BASE_URL=https://api.deepseek.com\n' +
        '\n' +
        '  # Ollama (local)\n' +
        '  export OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 CORECODER_MODEL=qwen2.5-coder\n',
    )
    process.exitCode = 1
    return
  }

  const llm = new LLM({
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  })
  const agent = new Agent({ llm, maxContextTokens: config.maxContextTokens })

  // resume a saved session
  if (args.resume) {
    const loaded = await loadSession(args.resume)
    if (!loaded) {
      console.error(red(`Session '${args.resume}' not found.`))
      process.exitCode = 1
      return
    }
    agent.messages = loaded.messages
    // restore the model from the saved session unless overridden by CLI
    if (!args.model) {
      agent.llm.model = loaded.model
      config.model = loaded.model
    }
    console.log(green(`Resumed session: ${args.resume} (model: ${agent.llm.model})`))
  }

  // one-shot mode
  if (args.prompt) {
    process.exitCode = await runOnce(agent, args.prompt)
    return
  }

  // interactive REPL
  await repl(agent, config)
}

// ---------------------------------------------------------------- running one turn

/**
 * Drive one agent turn, rendering events as they stream. Aborting `ac` cancels
 * just this turn (the Node idiom for Python's KeyboardInterrupt). The caller
 * owns Ctrl+C wiring: in the REPL readline's raw mode swallows ^C and emits a
 * 'SIGINT' *event*, while one-shot mode gets the real process signal — two
 * different hooks, one abort path.
 * Returns the final text, plus whether it was streamed and — when null —
 * whether the turn was cancelled (^C) or failed, so the caller can pick the
 * right process exit code: 130 for interrupt, 1 for error.
 */
async function runTurn(
  agent: Agent,
  input: string,
  ac: AbortController,
): Promise<{ text: string | null; streamed: boolean; aborted: boolean }> {
  // Streamed text renders as markdown line-by-line (see render.ts). The
  // renderer holds at most one partial line, flushed before tool banners.
  const renderer = new StreamRenderer(s => process.stdout.write(s), useColor)
  let streamed = false
  try {
    // drive the generator by hand: we need both the yielded events (progress)
    // and the return value (final answer) — .next() exposes both channels
    const gen = agent.chat(input, ac.signal)
    let step = await gen.next()
    while (!step.done) {
      const ev = step.value
      if (ev.type === 'text') {
        renderer.push(ev.delta)
        streamed = true
      } else if (ev.type === 'tool_start') {
        renderer.flush() // complete any half-line before the tool banner
        console.log(dim(`\n> ${ev.name}(${brief(ev.args)})`))
      }
      step = await gen.next()
    }
    renderer.flush()
    return { text: step.value, streamed, aborted: false }
  } catch (e) {
    renderer.flush()
    const aborted = e instanceof Error && e.name === 'AbortError'
    if (aborted) {
      console.log(yellow('\nInterrupted.'))
    } else {
      console.log(red(`\nError: ${e instanceof Error ? e.message : e}`))
    }
    return { text: null, streamed, aborted }
  }
}

/** Render a complete (non-streamed) reply as markdown. */
function renderMarkdown(text: string): void {
  new StreamRenderer(s => process.stdout.write(s), useColor).renderAll(text)
}

/** Exit code for a finished turn: 0 success, 130 interrupt (^C), 1 error. */
export function turnExitCode(result: { text: string | null; aborted: boolean }): number {
  if (result.text !== null) return 0
  return result.aborted ? 130 : 1
}

/** Non-interactive: run one prompt and exit. */
async function runOnce(agent: Agent, prompt: string): Promise<number> {
  // No readline here, so ^C arrives as a real process signal.
  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.once('SIGINT', onSigint)
  try {
    const { text, streamed, aborted } = await runTurn(agent, prompt, ac)
    const code = turnExitCode({ text, aborted })
    if (code === 0 && !streamed && text) renderMarkdown(text)
    return code
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

// ---------------------------------------------------------------- REPL

function loadHistory(): string[] {
  try {
    // readline expects newest-first
    return readFileSync(HIST_PATH, 'utf8').split('\n').filter(Boolean).reverse().slice(0, 500)
  } catch {
    return []
  }
}

async function repl(agent: Agent, config: Config): Promise<void> {
  console.log(
    `${bold('CoreCoder-TS')} v${VERSION}\n` +
      `Model: ${cyan(config.model)}` +
      (config.baseUrl ? `  Base: ${dim(config.baseUrl)}` : '') +
      `\nType ${bold('/help')} for commands, ${bold('Ctrl+C')} to cancel, ${bold('quit')} to exit.\n`,
  )

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: loadHistory(),
    historySize: 500,
  })
  // Readline's raw mode swallows ^C and emits 'SIGINT' as an event instead of
  // a process signal. Route it like the Python original routes
  // KeyboardInterrupt: mid-turn -> cancel just that turn; at the prompt -> exit.
  let activeTurn: AbortController | null = null
  rl.on('SIGINT', () => {
    if (activeTurn) {
      activeTurn.abort()
      return
    }
    console.log('\nBye!')
    rl.close()
    process.exit(0)
  })

  while (true) {
    let userInput: string
    try {
      userInput = (await rl.question(bold('You > '))).trim()
    } catch {
      console.log('\nBye!')
      break
    }

    if (!userInput) continue
    try {
      appendFileSync(HIST_PATH, userInput.replaceAll('\n', ' ') + '\n')
    } catch {
      // history is a convenience; never fail the REPL over it
    }

    // built-in commands
    if (['quit', 'exit', '/quit', '/exit'].includes(userInput.toLowerCase())) break
    if (userInput.startsWith('/')) {
      if (await handleCommand(userInput, agent, config)) continue
      console.log(yellow(`Unknown command: ${userInput.split(' ')[0]} (try /help)`))
      continue
    }

    // call the agent (^C during the turn aborts it — see the SIGINT handler)
    activeTurn = new AbortController()
    const { text, streamed } = await runTurn(agent, userInput, activeTurn)
    activeTurn = null
    if (text !== null) {
      if (streamed) console.log()
      else if (text) renderMarkdown(text) // response came after tool calls, not streamed
    }
  }

  rl.close()
}

/** Handle a slash command. Returns false if the command is unknown. */
async function handleCommand(input: string, agent: Agent, config: Config): Promise<boolean> {
  if (input === '/help') {
    showHelp()
    return true
  }
  if (input === '/reset') {
    agent.reset()
    console.log(yellow('Conversation reset.'))
    return true
  }
  if (input === '/tokens') {
    // three states, never dressing unknown up as a number:
    //   no usage ever      → unknown
    //   some responses had none → reported totals, flagged incomplete
    //   all responses had usage → reported totals
    if (!agent.llm.usageSeen) {
      console.log(dim('Tokens: unknown — this provider has not reported usage.'))
      return true
    }
    const p = agent.llm.totalPromptTokens
    const c = agent.llm.totalCompletionTokens
    const note = agent.llm.usageMissed
      ? dim(' (incomplete: some responses carried no usage)')
      : ''
    console.log(`Reported tokens: ${cyan(String(p))} prompt + ${cyan(String(c))} completion${note}`)
    return true
  }
  if (input === '/model' || input.startsWith('/model ')) {
    const newModel = input.startsWith('/model ') ? input.slice(7).trim() : ''
    if (newModel) {
      agent.llm.model = newModel
      config.model = newModel
      console.log(`Switched to ${cyan(newModel)}`)
    } else {
      console.log(`Current model: ${cyan(config.model)}`)
    }
    return true
  }
  if (input === '/compact') {
    const before = estimateTokens(agent.messages)
    const compressed = await agent.context.maybeCompress(agent.messages, agent.llm)
    const after = estimateTokens(agent.messages)
    if (compressed) {
      console.log(green(`Compressed: ${before} → ${after} tokens (${agent.messages.length} messages)`))
    } else {
      console.log(dim(`Nothing to compress (${before} tokens, ${agent.messages.length} messages)`))
    }
    return true
  }
  if (input === '/save') {
    const sid = await saveSession(agent.messages, config.model)
    console.log(green(`Session saved: ${sid}`))
    console.log(`Resume with: corecoder-ts -r ${sid}`)
    return true
  }
  if (input === '/diff') {
    if (changedFiles.size === 0) {
      console.log(dim('No files modified this session.'))
    } else {
      console.log(bold(`Files modified this session (${changedFiles.size}):`))
      for (const f of [...changedFiles].sort()) console.log(`  ${cyan(f)}`)
    }
    return true
  }
  if (input === '/sessions') {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      console.log(dim('No saved sessions.'))
    } else {
      for (const s of sessions) {
        console.log(`  ${cyan(s.id)} (${s.model}, ${s.savedAt}) ${s.preview}`)
      }
    }
    return true
  }
  return false
}

function showHelp(): void {
  console.log(
    `${bold('Commands:')}\n` +
      '  /help          Show this help\n' +
      '  /reset         Clear conversation history\n' +
      '  /model         Show current model\n' +
      '  /model <name>  Switch model mid-conversation\n' +
      '  /tokens        Show token usage\n' +
      '  /compact       Compress conversation context\n' +
      '  /diff          Show files modified this session\n' +
      '  /save          Save session to disk\n' +
      '  /sessions      List saved sessions\n' +
      '  quit           Exit CoreCoder-TS\n',
  )
}

// The Python original truncates repr(v) at 40 chars with no marker, which
// makes long paths look mysteriously cut off; add an ellipsis so truncation
// is visible.
function brief(args: Record<string, unknown>, maxlen = 80): string {
  const s = Object.entries(args)
    .map(([k, v]) => {
      const j = JSON.stringify(v) ?? '?'
      return `${k}=${j.length > 40 ? j.slice(0, 40) + '…' : j}`
    })
    .join(', ')
  return s.length > maxlen ? s.slice(0, maxlen) + '…' : s
}

// ---------------------------------------------------------------- demo

/**
 * Offline demo: a ScriptedLLM plays back a fixed two-turn script — one tool
 * call, one summary — so you can watch the full agent loop with no API key.
 */
async function runDemo(): Promise<number> {
  console.log(bold('CoreCoder-TS offline demo') + dim(' (ScriptedLLM, no API key needed)\n'))

  const script = [
    new LLMResponse('Let me run a command to look around.', [
      { id: 'demo-1', name: 'bash', arguments: { command: "echo 'Hello from the CoreCoder-TS demo!'" } },
    ]),
    new LLMResponse(
      'Demo complete. The loop you just watched — model asks for a tool, ' +
        'the harness runs it, the result feeds back in — is the whole agent.',
    ),
  ]
  const llm: LLMClient = new ScriptedLLM(script)
  const agent = new Agent({ llm })

  const code = await runOnce(agent, 'Run a quick demo command and explain what happened.')
  console.log(dim(`\n(messages in history: ${agent.messages.length})`))
  return code
}

// __main__ equivalent: run only when executed directly, not when imported.
// argv[1] must be realpath'd: npm bin installs invoke the CLI through a
// symlink, while import.meta.url is the resolved target — a raw string
// compare would fail and the installed command would silently do nothing.
let isDirectRun = false
if (process.argv[1]) {
  try {
    isDirectRun = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    // realpath can fail in exotic embeddings — fall back to the plain compare
    // rather than silently refusing to start
    isDirectRun = import.meta.url === pathToFileURL(process.argv[1]).href
  }
}
if (isDirectRun) {
  main().catch(e => {
    console.error(e)
    process.exitCode = 1
  })
}
