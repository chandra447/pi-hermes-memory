import fs from 'node:fs';
import Parser from 'stream-json/Parser.js';
import { DEFAULT_MAX_MESSAGE_CONTENT_LENGTH } from '../constants.js';

// Keep both ends of searchable text, without ever assembling media, tool output,
// or an unbounded JSON string. The tokenizer itself emits small string chunks.
class BoundedText {
  length = 0;
  private head = '';
  private tail = '';
  constructor(private limit = DEFAULT_MAX_MESSAGE_CONTENT_LENGTH) {}
  append(value: string): void {
    this.length += value.length;
    if (this.head.length < this.limit) this.head += value.slice(0, this.limit - this.head.length);
    this.tail = (this.tail + value).slice(-this.limit);
  }
  value(): string {
    if (this.length <= this.limit) return this.head;
    const notice = `\n... (truncated, ${this.length} chars total)\n`;
    const available = Math.max(0, this.limit - notice.length);
    return this.head.slice(0, Math.ceil(available / 2)) + notice + this.tail.slice(-Math.floor(available / 2));
  }
}

export interface SearchEntry {
  type?: string;
  id?: string;
  cwd?: string;
  timestamp?: string;
  role?: string;
  content: string;
  toolCalls?: string[];
}

type Frame = { path: string; array: boolean; key: string };

function entryParser() {
  const parser = new Parser({ packValues: false, packKeys: false });
  const frames: Frame[] = [];
  const fields: Record<string, string> = {};
  const text = new BoundedText();
  const tools: string[] = [];
  let block: Record<string, string> = {};
  let key = false;
  let value = new BoundedText(256);
  let selected = '';
  let complete = false;
  let invalid = false;
  const valuePath = () => {
    const parent = frames.at(-1);
    return parent ? `${parent.path}/${parent.array ? '*' : parent.key}` : '';
  };
  parser.on('error', () => { invalid = true; });
  parser.on('data', (token: { name: string; value?: string }) => {
    switch (token.name) {
      case 'startObject':
      case 'startArray': {
        const path = valuePath();
        if (path === '/message/content/*') block = {};
        frames.push({ path, array: token.name === 'startArray', key: '' });
        break;
      }
      case 'endObject':
      case 'endArray': {
        const frame = frames.pop();
        if (frame?.path === '/message/content/*') {
          if (block.type === 'text' && block.text) {
            if (text.length) text.append('\n');
            text.append(block.text);
          }
          if ((block.type === 'toolCall' || block.type === 'tool_use') && block.name && tools.length < 1024) tools.push(block.name);
          block = {};
        }
        if (!frames.length) complete = true;
        break;
      }
      case 'startKey':
        key = true;
        value = new BoundedText(256);
        break;
      case 'endKey':
        if (frames.length) frames[frames.length - 1].key = value.value();
        key = false;
        break;
      case 'startString':
        selected = valuePath();
        if (!/^\/(type|id|cwd|timestamp|message\/role|message\/content|message\/content\/\*\/(type|text|name))$/.test(selected)) selected = '';
        value = new BoundedText(selected.endsWith('/text') || selected === '/message/content' ? DEFAULT_MAX_MESSAGE_CONTENT_LENGTH : 4096);
        break;
      case 'stringChunk':
        if (key || selected) value.append(token.value ?? '');
        break;
      case 'endString':
        if (selected.startsWith('/message/content/*/')) block[selected.split('/').at(-1)!] = value.value();
        else if (selected === '/message/content') text.append(value.value());
        else if (selected) fields[selected] = value.value();
        selected = '';
        break;
    }
  });
  return {
    write(chunk: Buffer) { if (!invalid && !parser.destroyed) parser.write(chunk); },
    finish(): SearchEntry | null {
      // A complete top-level object is required. A partially appended JSONL
      // record is retried on the next pass rather than checkpointed away.
      if (!complete || invalid || parser.destroyed) return null;
      return {
        type: fields['/type'], id: fields['/id'], cwd: fields['/cwd'],
        timestamp: fields['/timestamp'], role: fields['/message/role'],
        content: text.value().trim(), toolCalls: tools.length ? tools : undefined,
      };
    },
    destroy() { parser.destroy(); },
  };
}

export interface SessionRecord {
  entry: SearchEntry | null;
  offset: number;
}

/** Progress yields let asynchronous callers relinquish the event loop even
 * inside a multi-gigabyte line. Memory does not depend on the file/line size. */
export function* readSessionRecords(filePath: string, start = 0): Generator<SessionRecord | undefined> {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = start;
  let record = entryParser();
  try {
    const end = fs.fstatSync(fd).size;
    while (position < end) {
      const size = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
      if (!size) break;
      let from = 0;
      for (let i = 0; i < size; i++) {
        if (buffer[i] !== 10) continue;
        record.write(buffer.subarray(from, i + 1));
        yield { entry: record.finish(), offset: position + i + 1 };
        record.destroy();
        record = entryParser();
        from = i + 1;
      }
      if (from < size) record.write(buffer.subarray(from, size));
      position += size;
      yield undefined;
    }
    // A complete object without a trailing newline is valid; an incomplete
    // object is not checkpointed and will be retried on the next scan.
    const entry = record.finish();
    if (entry) yield { entry, offset: position };
  } finally {
    record.destroy();
    fs.closeSync(fd);
  }
}
