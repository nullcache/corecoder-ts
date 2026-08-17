# corecoder-ts

A TypeScript port of [CoreCoder](https://github.com/he-yufeng/CoreCoder) — a minimal AI coding agent
that runs in your terminal. Roughly 2,600 lines of source (plus ~850 lines of tests), zero runtime
dependencies, and the whole thing is
meant to be read: each module is a distilled version of the same idea from Claude Code, with the
commentary on *why* it's shaped that way.

> Built for people who want to understand how an agent actually works, not for people who want a
> feature-complete product. If you need the latter, go use Claude Code or Cline.

## Branches

- **`min`** (default) — the minimal viable version: the core behavior, kept as small as possible.
- **`dev`** — the enhanced branch: functional enhancements on top of `min`, no longer bound by
  the minimal bar.

`min` is merged into `dev` regularly; nothing flows the other way.

## Features

- **Agent loop as an async generator** — `chat()` yields streamed events and *returns* the final
  answer, so rendering and cancellation are built into the core (`AsyncGenerator<AgentEvent, string>`).
- **Real tools, real filesystem** — bash, read/write/edit, glob, grep, and a sub-agent tool, with
  Claude Code-style unique-match file editing and cwd tracking across commands.
- **Context compression** — a 3-layer strategy (snip verbose tool output → LLM summary → hard
  collapse) calibrated against the API's reported `prompt_tokens`, so the char-based estimate
  stays honest.
- **Session persistence** — save and resume conversations from disk.
- **No dependencies at runtime** — the OpenAI SDK appears only as a type-only dev dependency.
- **Works with any OpenAI-compatible API** — OpenAI, DeepSeek, Ollama, LM Studio, etc.

## Install

Run from source:

```bash
git clone https://github.com/nullcache/corecoder-ts.git
cd corecoder-ts
npm install
npm run build
npm start
```

Requires Node.js >= 18.17.

## Quick start

```bash
export OPENAI_API_KEY=sk-...
corecoder-ts
```

DeepSeek (or any OpenAI-compatible provider):

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.deepseek.com
export CORECODER_MODEL=deepseek-chat
corecoder-ts
```

Ollama (local, dummy API key):

```bash
export OPENAI_API_KEY=ollama
export OPENAI_BASE_URL=http://localhost:11434/v1
export CORECODER_MODEL=qwen2.5-coder
corecoder-ts
```

No API key handy? Watch the agent loop run end-to-end with a scripted model:

```bash
corecoder-ts --demo
```

## CLI

```
corecoder-ts [options]

  -m, --model <name>   Model name (default: $CORECODER_MODEL or gpt-5.5)
      --base-url <url> API base URL (default: $OPENAI_BASE_URL)
      --api-key <key>  API key (default: $OPENAI_API_KEY)
  -p, --prompt <text>  One-shot prompt (non-interactive mode)
      --demo           Run the offline scripted demo (no API key needed)
  -r, --resume <id>    Resume a saved session
  -v, --version        Show version
  -h, --help           Show this help
```

Configuration is read from environment variables (a `.env` file in the working directory or any
parent directory up to your home directory works too, without overriding variables already set):

| Variable | Default | Purpose |
| --- | --- | --- |
| `CORECODER_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` | — | API key (first one set wins) |
| `OPENAI_BASE_URL` / `CORECODER_BASE_URL` | OpenAI | API base URL |
| `CORECODER_MODEL` | `gpt-5.5` | Model name |
| `CORECODER_MAX_TOKENS` | `4096` | `max_tokens` sent to the API |
| `CORECODER_TEMPERATURE` | `0` | Sampling temperature |
| `CORECODER_MAX_CONTEXT` | `128000` | Context budget that triggers compression |
| `CORECODER_TIMEOUT_MS` | `300000` | Per-request timeout for LLM calls, in ms (timeouts retry as transient errors) |

## REPL commands

| Command | What it does |
| --- | --- |
| `/help` | Show all commands |
| `/reset` | Clear conversation history |
| `/model` / `/model <name>` | Show or switch the model mid-conversation |
| `/tokens` | Show token usage and estimated cost |
| `/compact` | Manually compress the conversation context |
| `/diff` | List files modified this session |
| `/save` | Save the session to disk |
| `/sessions` | List saved sessions |
| `quit` / `exit` | Leave the REPL |

`Ctrl+C` cancels the current turn; `Ctrl+C` at the prompt exits.

## Tools

The agent gets these tools, declared as JSON schemas and executed against your machine:

| Tool | What it does |
| --- | --- |
| `bash` | Run a shell command with a timeout, output truncation, and a safety blacklist for destructive commands |
| `read_file` | Read a file with line numbers, offset/limit, and a line-width cap |
| `write_file` | Create or overwrite a file |
| `edit_file` | Replace an exact unique string match — Claude Code's key editing primitive |
| `glob` | Find files by pattern (`**` supported), skipping `node_modules` and VCS dirs |
| `grep` | Regex search over file contents |
| `agent` | Spawn a sub-agent with its own context for complex sub-tasks (no recursive agents) |

## How it works

```
user message -> LLM (with tools) -> tool calls? -> execute -> loop
                                -> text reply? -> return to user
```

### The agent loop (`src/agent.ts`)

`Agent.chat()` is an async generator: it yields `AgentEvent`s (`text` deltas, `tool_start`/`tool_end`)
for live rendering, and *returns* the model's final text answer. Tool calls are executed — in
parallel when there are several — and their results are fed back as `tool` messages until the model
replies with plain text. Cancellation flows through an `AbortSignal`, so a ^C stops the current turn
without leaving a half-answered message behind.

### The LLM layer (`src/llm.ts`)

Speaks raw fetch + SSE against any OpenAI-compatible `/chat/completions` endpoint. Streamed tool-call
fragments are re-stitched per index, usage is read from the final chunk, and transient errors retry
with exponential backoff. `ScriptedLLM` plays back canned responses offline for tests and demos.

### Context compression (`src/context.ts`)

Three layers, cheapest first:

1. **Snip** verbose tool outputs in place (head + tail preserved)
2. **Summarize** old turns with the LLM, keeping the recent tail verbatim
3. **Hard collapse** near the hard limit — summary + last few messages only

The char-based token estimate is calibrated against the API's reported `prompt_tokens` after each
round, which absorbs CJK text density. The fixed system-prompt/tool-schema overhead is counted as a
separate additive term, so the calibration ratio stays a pure chars-to-tokens rate and survives
compression.

### Sessions (`src/session.ts`)

Conversations save to `~/.corecoder-ts/sessions/` as JSON. Session ids are sanitized against path
traversal; resume with `corecoder-ts -r <id>`.

## Using it as a library

```ts
import { Agent, LLM } from 'corecoder-ts'

const llm = new LLM({
  model: 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY!,
  baseUrl: 'https://api.deepseek.com',
})

const agent = new Agent({ llm })
for await (const event of agent.chat('list every TODO in this project')) {
  if (event.type === 'text') process.stdout.write(event.delta)
}
```

## Development

```bash
npm install
npm test        # tsc build + run the test suite
npm run demo    # offline demo with a scripted model
```

Layout:

```
src/
  agent.ts      the agent loop
  llm.ts        fetch + SSE client and the scripted offline client
  context.ts    multi-layer context compression
  cli.ts        the REPL and one-shot mode
  session.ts    conversation persistence
  render.ts     streaming markdown renderer for the terminal
  tools/        bash, read/write/edit, glob, grep, sub-agent
tests/          node:test suites (no network required)
scripts/        cross-version test runner (node --test glob expansion is Node 21+)
```

## Relationship to CoreCoder

This is a faithful port of the Python [CoreCoder](https://github.com/he-yufeng/CoreCoder), with a
few deliberate upgrades — most notably the async-generator event stream (the Python version uses
`on_token`/`on_tool` callbacks), a streaming markdown renderer, and real `prompt_tokens` calibration
for context compression. The design commentary throughout references the Claude Code mechanisms
being distilled and the Python original being ported.

## License

MIT
