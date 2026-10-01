import fs from 'node:fs';
import path from 'node:path';
import { readSessionRecords, type SearchEntry } from './session-stream.js';

/**
 * Parsed session data from a JSONL file.
 */
export interface ParsedSession {
  id: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  messages: ParsedMessage[];
}

/**
 * A single parsed message from a session.
 */
export interface ParsedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  toolCalls?: string[];
}

/**
 * Parse a Pi session JSONL file.
 *
 * @param filePath — Path to the .jsonl file
 * @returns Parsed session data, or null if the file is invalid
 */
export function parseSessionFile(filePath: string): ParsedSession | null {
  let sessionId: string | null = null;
  let sessionCwd: string | null = null;
  let sessionTimestamp: string | null = null;
  const messages: ParsedMessage[] = [];

  for (const record of readSessionRecords(filePath)) {
    const entry = record?.entry;
    if (!entry) continue;

    switch (entry.type) {
      case 'session':
        sessionId = entry.id ?? null;
        sessionCwd = entry.cwd ?? null;
        sessionTimestamp = entry.timestamp ?? null;
        break;

      case 'message': {
        const message = searchEntryMessage(entry);
        if (message) messages.push(message);
        break;
      }
      // Skip other entry types (model_change, thinking_level_change, custom, etc.)
    }
  }

  if (!sessionId || !sessionCwd || !sessionTimestamp) return null;

  // Decode project name from cwd-encoded directory name
  // The directory is named like "--Users-chandrateja-Documents-pi-hermes-memory--"
  // We extract the last segment as the project name
  const project = sessionCwd.split('/').pop() ?? sessionCwd;

  return {
    id: sessionId,
    project,
    cwd: sessionCwd,
    startedAt: sessionTimestamp,
    endedAt: null, // We don't know when it ended from the JSONL
    messages,
  };
}

export function searchEntryMessage(entry: SearchEntry): ParsedMessage | null {
  const { id, timestamp, role, content } = entry;
  if (entry.type !== 'message' || !id || !timestamp || !content) return null;
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;
  return { id, timestamp, role, content, toolCalls: role === 'assistant' ? entry.toolCalls : undefined };
}

/**
 * Get all session JSONL files for a project (or all projects).
 *
 * @param sessionsDir — Path to ~/.pi/agent/sessions/
 * @param projectDir — Optional: specific project directory name (e.g., "--Users-...--")
 * @returns Array of file paths
 */
export function getSessionFiles(sessionsDir: string, projectDir?: string): string[] {
  if (projectDir) {
    const dir = path.join(sessionsDir, projectDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dir, f));
  }

  // All projects
  if (!fs.existsSync(sessionsDir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(sessionsDir)) {
    const entryPath = path.join(sessionsDir, entry);
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      // Scan .jsonl files inside project subdirectories
      for (const f of fs.readdirSync(entryPath)) {
        if (f.endsWith('.jsonl')) {
          files.push(path.join(entryPath, f));
        }
      }
    } else if (stat.isFile() && entry.endsWith('.jsonl')) {
      // Also pick up root-level .jsonl files
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Decode a project directory name to a human-readable project name.
 * "--Users-chandrateja-Documents-pi-hermes-memory--" → "pi-hermes-memory"
 */
export function decodeProjectDir(dirName: string): string {
  // Remove leading/trailing dashes
  const cleaned = dirName.replace(/^-+|-+$/g, '');
  // Split by dash and take the last segment (project name)
  const segments = cleaned.split('-');
  return segments[segments.length - 1] ?? cleaned;
}
