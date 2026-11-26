/**
 * Text, key, and input helpers that used to come from @earendil-works/pi-tui.
 * omp 19 no longer provides that module, so the extension owns them locally.
 */

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/;
const SGR_PATTERN = /^\x1b\[[0-9;]*m$/;
const RESET_PATTERN = /^\x1b\[(?:0|22|27|39|49)m$/;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Segment {
  text: string;
  width: number;
  ansi: boolean;
}

function codeWidth(code: number): number {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) ? 2 : 1;
}

function graphemeWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 0x200d || code === 0xfe0f || code === 0xfe0e) continue;
    width = Math.max(width, codeWidth(code));
  }
  return width;
}

function tokenize(text: string): Segment[] {
  const tokens: Segment[] = [];
  let plain = "";
  const flush = (): void => {
    if (!plain) return;
    for (const { segment } of graphemes.segment(plain)) {
      tokens.push({ text: segment, width: graphemeWidth(segment), ansi: false });
    }
    plain = "";
  };

  for (let index = 0; index < text.length;) {
    const ansi = ANSI_PATTERN.exec(text.slice(index));
    if (ansi && ansi.index === 0) {
      flush();
      tokens.push({ text: ansi[0], width: 0, ansi: true });
      index += ansi[0].length;
      continue;
    }
    const character = String.fromCodePoint(text.codePointAt(index)!);
    index += character.length;
    if (character === "\t" || character === "\n" || character === "\r") {
      flush();
      tokens.push({ text: character, width: character === "\t" ? 3 : 0, ansi: false });
      continue;
    }
    plain += character;
  }
  flush();
  return tokens;
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (const token of tokenize(text)) width += token.width;
  return width;
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = "..."): string {
  if (maxWidth <= 0) return "";
  const target = Math.max(0, maxWidth - visibleWidth(ellipsis));
  let result = "";
  let width = 0;
  for (const token of tokenize(text)) {
    if (token.width === 0) {
      result += token.text;
      continue;
    }
    if (width + token.width > target) return `${result}${ellipsis}`;
    result += token.text;
    width += token.width;
  }
  return result;
}

export function sliceByColumn(line: string, startColumn: number, length: number, strict = false): string {
  if (length <= 0) return "";
  const end = startColumn + length;
  let column = 0;
  let result = "";
  for (const token of tokenize(line)) {
    if (token.ansi) {
      if (column >= startColumn && column < end) result += token.text;
      continue;
    }
    const inRange = column >= startColumn && column < end;
    if (inRange && (!strict || column + token.width <= end)) result += token.text;
    column += token.width;
    if (column >= end) break;
  }
  return result;
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
  const maximum = Math.max(1, Math.floor(width));
  if (!text) return [""];
  const lines: string[] = [];
  for (const inputLine of text.split("\n")) {
    let line = "";
    let lineWidth = 0;
    let active = "";
    for (const token of tokenize(inputLine)) {
      if (token.ansi) {
        line += token.text;
        if (SGR_PATTERN.test(token.text)) {
          active = RESET_PATTERN.test(token.text) ? "" : `${active}${token.text}`;
        }
        continue;
      }
      if (token.width === 0) {
        line += token.text;
        continue;
      }
      if (lineWidth + token.width > maximum && lineWidth > 0) {
        lines.push(line.trimEnd());
        line = active;
        lineWidth = 0;
      }
      line += token.text;
      lineWidth += token.width;
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

function matchScore(token: string, text: string): number | null {
  const needle = token.toLowerCase();
  const haystack = text.toLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return direct;
  let cursor = 0;
  let first = -1;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found < 0) return null;
    if (first < 0) first = found;
    cursor = found + 1;
  }
  return 100 + cursor - first;
}

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
  if (!query.trim()) return items;
  const tokens = query.trim().split(/[\s/]+/).filter(Boolean);
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const text = getText(item);
    let score = 0;
    let matches = true;
    for (const token of tokens) {
      const result = matchScore(token, text);
      if (result === null) {
        matches = false;
        break;
      }
      score += result;
    }
    if (matches) scored.push({ item, score });
  }
  scored.sort((left, right) => left.score - right.score);
  return scored.map(({ item }) => item);
}

const KEY_SEQUENCES: Record<string, readonly string[]> = {
  escape: ["\x1b"],
  enter: ["\r", "\n"],
  tab: ["\t"],
  space: [" ", "\x1b "],
  slash: ["/"],
  up: ["\x1b[A", "\x1bOA", "\x1b[a", "\x1bOa"],
  down: ["\x1b[B", "\x1bOB", "\x1b[b", "\x1bOb"],
  pageUp: ["\x1b[5~", "\x1b[[5~"],
  pageDown: ["\x1b[6~", "\x1b[[6~"],
  home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
  end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
};

export const Key = {
  escape: "escape",
  enter: "enter",
  tab: "tab",
  space: "space",
  slash: "/",
  up: "up",
  down: "down",
  pageUp: "pageUp",
  pageDown: "pageDown",
  home: "home",
  end: "end",
} as const;

export function matchesKey(data: string, key: string): boolean {
  return KEY_SEQUENCES[key]?.includes(data) ?? data === key;
}

/** Single-line search input with the subset of the old Input API this extension uses. */
export class Input {
  value = "";
  cursor = 0;
  focused = false;

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
    this.cursor = Math.min(this.cursor, value.length);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (data === "\x7f" || data === "\b") {
      if (this.cursor > 0) {
        this.value = `${this.value.slice(0, this.cursor - 1)}${this.value.slice(this.cursor)}`;
        this.cursor -= 1;
      }
      return;
    }
    if (matchesKey(data, "home") || data === "\x1b[1~") {
      this.cursor = 0;
      return;
    }
    if (matchesKey(data, "end") || data === "\x1b[4~") {
      this.cursor = this.value.length;
      return;
    }
    if (KEY_SEQUENCES.up.includes(data) || KEY_SEQUENCES.down.includes(data)) return;
    if (data === "\x1b[D" || data === "\x1bOD") {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (data === "\x1b[C" || data === "\x1bOC") {
      this.cursor = Math.min(this.value.length, this.cursor + 1);
      return;
    }
    if (data.startsWith("\x1b") || /[\x00-\x1f\x7f]/.test(data)) return;
    this.value = `${this.value.slice(0, this.cursor)}${data}${this.value.slice(this.cursor)}`;
    this.cursor += data.length;
  }

  render(width: number): string[] {
    const prompt = "> ";
    const before = this.value.slice(0, this.cursor);
    const at = this.value.slice(this.cursor, this.cursor + 1) || " ";
    const after = this.value.slice(this.cursor + 1);
    return [truncateToWidth(`${prompt}${before}\x1b[7m${at}\x1b[27m${after}`, Math.max(1, width), "")];
  }
}

/** The expand hint text is derived locally because omp 19 dropped keyHint from the host root. */
export function keyHint(_action: string, description: string): string {
  return `ctrl+o ${description}`;
}

/** Rows renderer accepted by omp 19 and by the older component-based TUI. */
export interface RowsView {
  render(width: number): string[];
  invalidate(): void;
}
