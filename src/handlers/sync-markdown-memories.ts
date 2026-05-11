/**
 * Markdown memory sync command — /memory-sync-markdown imports existing
 * Markdown-backed memories into the SQLite search store.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DatabaseManager } from '../store/db.js';
import {
  parseMarkdownMemoryEntry,
  syncMemoryEntry,
} from '../store/sqlite-memory-store.js';
import { ENTRY_DELIMITER, MEMORY_FILE, USER_FILE } from '../constants.js';

export interface BackfillCounters {
  filesScanned: number;
  entriesScanned: number;
  imported: number;
  skipped: number;
  warnings: string[];
}

function readEntries(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
}

function importEntries(
  dbManager: DatabaseManager,
  counters: BackfillCounters,
  entries: string[],
  target: 'memory' | 'user' | 'failure',
  project: string | null = null,
): void {
  for (const rawEntry of entries) {
    counters.entriesScanned++;
    try {
      const parsed = parseMarkdownMemoryEntry(rawEntry, target, project);
      const result = syncMemoryEntry(dbManager, parsed);
      if (result.action === 'inserted') counters.imported++;
      else counters.skipped++;
    } catch (err) {
      counters.warnings.push(
        `${path.basename(project ?? 'global')}/${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function scanProjectDirs(agentRoot: string, globalDir: string, projectsMemoryDir = "projects-memory"): Array<{ name: string; memoryFile: string }> {
  const projectsRoot = path.join(agentRoot, projectsMemoryDir);
  const projects = new Map<string, string>();

  if (fs.existsSync(projectsRoot)) {
    for (const name of fs.readdirSync(projectsRoot)) {
      const dir = path.join(projectsRoot, name);
      const memoryFile = path.join(dir, MEMORY_FILE);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.existsSync(memoryFile)) {
        projects.set(name, memoryFile);
      }
    }
  }

  const globalDirName = path.basename(globalDir);
  if (fs.existsSync(agentRoot)) {
    for (const name of fs.readdirSync(agentRoot)) {
      if (name === globalDirName || name === projectsMemoryDir || name === 'skills' || name.startsWith('.')) continue;
      if (projects.has(name)) continue;
      const dir = path.join(agentRoot, name);
      const memoryFile = path.join(dir, MEMORY_FILE);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.existsSync(memoryFile)) {
        projects.set(name, memoryFile);
      }
    }
  }

  return [...projects.entries()]
    .map(([name, memoryFile]) => ({ name, memoryFile }))
    .filter(({ memoryFile }) => fs.existsSync(memoryFile));
}

export function syncMarkdownMemoriesToSqlite(
  dbManager: DatabaseManager,
  globalDir: string,
  projectsMemoryDir?: string,
): BackfillCounters & { projectCount: number } {
  const counters: BackfillCounters = {
    filesScanned: 0,
    entriesScanned: 0,
    imported: 0,
    skipped: 0,
    warnings: [],
  };

  const globalMemoryFile = path.join(globalDir, MEMORY_FILE);
  const globalUserFile = path.join(globalDir, USER_FILE);
  const globalFailureFile = path.join(globalDir, 'failures.md');

  const importFile = (
    filePath: string,
    target: 'memory' | 'user' | 'failure',
    project: string | null = null,
  ) => {
    if (!fs.existsSync(filePath)) return;
    counters.filesScanned++;
    const entries = readEntries(filePath);
    importEntries(dbManager, counters, entries, target, project);
  };

  importFile(globalMemoryFile, 'memory');
  importFile(globalUserFile, 'user');
  importFile(globalFailureFile, 'failure');

  const agentRoot = path.dirname(globalDir);
  const projects = scanProjectDirs(agentRoot, globalDir, projectsMemoryDir);
  for (const project of projects) {
    importFile(project.memoryFile, 'memory', project.name);
  }

  return { ...counters, projectCount: projects.length };
}

export function registerSyncMarkdownMemoriesCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  globalDir: string,
  projectsMemoryDir?: string,
): void {
  pi.registerCommand('memory-sync-markdown', {
    description: 'Backfill Markdown memories into the SQLite search store',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify('🔄 Scanning Markdown memory files for SQLite backfill...', 'info');

      try {
        const counters = syncMarkdownMemoriesToSqlite(dbManager, globalDir, projectsMemoryDir);

        let output = `\n✅ Markdown → SQLite sync complete!\n\n`;
        output += `📊 Results:\n`;
        output += `├─ Files scanned: ${counters.filesScanned}\n`;
        output += `├─ Entries scanned: ${counters.entriesScanned}\n`;
        output += `├─ Imported into SQLite: ${counters.imported}\n`;
        output += `└─ Skipped as duplicates: ${counters.skipped}\n`;

        if (counters.projectCount > 0) {
          output += `\n📁 Project memories scanned: ${counters.projectCount}\n`;
        }

        if (counters.warnings.length > 0) {
          output += `\n⚠️ Warnings (${counters.warnings.length}):\n`;
          for (const warning of counters.warnings.slice(0, 5)) {
            output += `├─ ${warning}\n`;
          }
          if (counters.warnings.length > 5) {
            output += `└─ ... and ${counters.warnings.length - 5} more\n`;
          }
        }

        output += `\n💡 Re-running this command is safe — existing SQLite rows are de-duplicated.`;
        ctx.ui.notify(output, 'info');
      } catch (err) {
        ctx.ui.notify(`❌ Markdown sync failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });
}
