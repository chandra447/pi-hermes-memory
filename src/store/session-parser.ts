import fs from 'node:fs';

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
 * Raw JSONL entry types.
 */
interface JsonlEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
  };
  customType?: string;
  [key: string]: unknown;
}

/**
 * Extract text content from a message's content array.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') parts.push(b.text);
        break;
      case 'thinking':
        // Skip thinking blocks — they're internal reasoning
        break;
      case 'tool_use':
        // Skip tool_use blocks — we track tool calls separately
        break;
      case 'tool_result':
        // Include tool result text if present
        if (typeof b.content === 'string') {
          parts.push(b.content);
        } else if (Array.isArray(b.content)) {
          for (const item of b.content) {
            if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') {
              parts.push((item as Record<string, unknown>).text as string);
            }
          }
        }
        break;
    }
  }
  return parts.join('\n').trim();
}

/**
 * Extract tool call names from a message's content array.
 */
function extractToolCalls(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;

  const toolNames: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      toolNames.push(b.name);
    }
  }
  return toolNames.length > 0 ? toolNames : undefined;
}

/**
 * Parse a Pi session JSONL file.
 *
 * @param filePath — Path to the .jsonl file
 * @returns Parsed session data, or null if the file is invalid
 */
export function parseSessionFile(filePath: string): ParsedSession | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  if (lines.length === 0) return null;

  let sessionId: string | null = null;
  let sessionCwd: string | null = null;
  let sessionTimestamp: string | null = null;
  const messages: ParsedMessage[] = [];

  for (const line of lines) {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Skip malformed lines
    }

    switch (entry.type) {
      case 'session':
        sessionId = entry.id ?? null;
        sessionCwd = entry.cwd ?? null;
        sessionTimestamp = entry.timestamp ?? null;
        break;

      case 'message': {
        if (!entry.message || !entry.id || !entry.timestamp) break;

        const role = entry.message.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'system') break;

        const textContent = extractTextContent(entry.message.content);
        if (!textContent) break; // Skip empty messages

        const toolCalls = role === 'assistant' ? extractToolCalls(entry.message.content) : undefined;

        messages.push({
          id: entry.id,
          role,
          content: textContent,
          timestamp: entry.timestamp,
          toolCalls,
        });
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

/**
 * Get all session JSONL files for a project (or all projects).
 *
 * @param sessionsDir — Path to ~/.pi/agent/sessions/
 * @param projectDir — Optional: specific project directory name (e.g., "--Users-...--")
 * @returns Array of file paths
 */
export function getSessionFiles(sessionsDir: string, projectDir?: string): string[] {
  if (projectDir) {
    const dir = `${sessionsDir}/${projectDir}`;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => `${dir}/${f}`);
  }

  // All projects
  if (!fs.existsSync(sessionsDir)) return [];
  const files: string[] = [];
  for (const dir of fs.readdirSync(sessionsDir)) {
    const dirPath = `${sessionsDir}/${dir}`;
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const f of fs.readdirSync(dirPath)) {
      if (f.endsWith('.jsonl')) {
        files.push(`${dirPath}/${f}`);
      }
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
