// Run with: node --max-old-space-size=128 --import tsx scripts/benchmark-session-index.ts /path/to/session.jsonl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../src/store/db.js';
import { indexLiveSessionAsync } from '../src/store/session-indexer.js';

const file = process.argv[2];
if (!file) throw new Error('Provide a session JSONL path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-index-benchmark-'));
const db = new DatabaseManager(dir);
const manager = { getSessionFile: () => file, getHeader: () => null, getEntries: () => [] };
let ticks = 0;
let maxDelay = 0;
let lastTick = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  maxDelay = Math.max(maxDelay, now - lastTick);
  lastTick = now;
  ticks++;
}, 10);
try {
  const start = performance.now();
  const first = await indexLiveSessionAsync(db, manager);
  const firstMs = performance.now() - start;
  const repeatStart = performance.now();
  const repeat = await indexLiveSessionAsync(db, manager);
  console.log(JSON.stringify({
    fileBytes: fs.statSync(file).size, firstMs, repeatMs: performance.now() - repeatStart,
    messagesIndexed: first?.messagesIndexed, repeatMessages: repeat?.messagesIndexed,
    timerTicks: ticks, maxTimerIntervalMs: maxDelay,
    maxRssMiB: process.resourceUsage().maxRSS / 1024,
    heapUsedMiB: process.memoryUsage().heapUsed / 1024 / 1024,
  }));
} finally {
  clearInterval(timer);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
