/**
 * Streaming Markdown renderer for the terminal.
 *
 * Full-document renderers (rich.Markdown, marked-terminal) need the whole
 * text before they can lay anything out, so wiring one into a token stream
 * means buffering the entire reply — killing the streaming feel that makes
 * a CLI agent pleasant. This renderer works line by line instead: deltas
 * accumulate in a buffer, every completed line renders immediately, and a
 * tiny state machine tracks ``` fences across lines. Headings, lists,
 * quotes and code blocks are line-shaped, so line-at-a-time rendering gets
 * them right; bold, inline code and links are handled within each line.
 *
 * (The Python original only pipes *non-streamed* replies through
 * rich.Markdown — and since tokens stream in the common case, that branch
 * almost never runs. Rendering the live stream is strictly an upgrade.)
 */

const wrap = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`
const bold = wrap(1, 22)
const dim = wrap(2, 22)
const yellow = wrap(33, 39)
const blue = wrap(34, 39)
const cyan = wrap(36, 39)
const underline = wrap(4, 24)

export class StreamRenderer {
  private buffer = ''
  private inCode = false

  constructor(
    private write: (s: string) => void,
    private color: boolean,
  ) {}

  /** Feed a streamed delta; every completed line renders immediately. */
  push(delta: string): void {
    this.buffer += delta
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      this.write(this.renderLine(line) + '\n')
    }
  }

  /** Render any trailing partial line and reset fence state (end of turn). */
  flush(): void {
    if (this.buffer) {
      this.write(this.renderLine(this.buffer) + '\n')
      this.buffer = ''
    }
    this.inCode = false
  }

  /** Render a complete text in one go (for non-streamed replies). */
  renderAll(text: string): void {
    this.push(text.endsWith('\n') ? text : text + '\n')
    this.flush()
  }

  private renderLine(raw: string): string {
    if (!this.color) return raw

    // code fence: toggle state, show the fence line (with info string) dim
    if (/^\s*(```|~~~)/.test(raw)) {
      this.inCode = !this.inCode
      return dim(raw)
    }
    if (this.inCode) return yellow(raw)

    // heading — keep the # prefix for markdown feel, brighten the text
    const h = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (h) {
      const text = h[1]!.length <= 2 ? cyan(h[2]!) : h[2]!
      return dim(h[1]!) + ' ' + bold(text)
    }

    // horizontal rule
    if (/^\s*([-*_])( *\1){2,}\s*$/.test(raw)) return dim('─'.repeat(40))

    // blockquote
    const q = /^(\s*)> ?(.*)$/.exec(raw)
    if (q) return q[1]! + dim('│ ' + this.inline(q[2]!))

    // list bullet (unordered or ordered)
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw)
    if (li) return li[1]! + cyan(li[2]!) + ' ' + this.inline(li[3]!)

    return this.inline(raw)
  }

  /**
   * Inline marks. Split on `code` spans first so bold/link rewriting can
   * never mangle code content; the odd segments of the split are the spans.
   *
   * Order matters: links must be rewritten before bold. Bold produces
   * ANSI codes containing a literal `[` (e.g. \x1b[1m), which the link
   * regex would misread as a link opener; link output contains no `*`,
   * so running bold second is safe.
   */
  private inline(text: string): string {
    return text
      .split(/(`[^`]+`)/)
      .map(seg => {
        if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 1) {
          return yellow(seg.slice(1, -1))
        }
        return seg
          .replace(
            /\[([^\]]+)\]\(([^)]+)\)/g,
            (_, t: string, u: string) => underline(blue(t)) + dim(`(${u})`),
          )
          .replace(/\*\*([^*]+)\*\*/g, (_, s: string) => bold(s))
      })
      .join('')
  }
}
