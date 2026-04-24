/**
 * MemoryStore — core persistent memory with file-backed storage.
 * Ported from hermes-agent/tools/memory_tool.py (MemoryStore class).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 *
 * Design:
 * - Two stores: MEMORY.md (agent notes) and USER.md (user profile)
 * - §-delimited entries with character limits
 * - Frozen snapshot at load time for system prompt (preserves Pi's prompt cache)
 * - Atomic writes via temp file + fs.rename()
 * - Content scanning before any write
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { scanContent } from "./content-scanner.js";
import {
  ENTRY_DELIMITER,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  MEMORY_FILE,
  USER_FILE,
} from "../constants.js";
import type { MemoryConfig, MemoryResult, MemorySnapshot } from "../types.js";

export class MemoryStore {
  private memoryEntries: string[] = [];
  private userEntries: string[] = [];
  private snapshot: MemorySnapshot = { memory: "", user: "" };

  constructor(private config: MemoryConfig) {}

  // ─── Path helpers ───

  private get memoryDir(): string {
    return this.config.memoryDir ?? path.join(os.homedir(), ".pi", "agent", "memory");
  }

  private pathFor(target: "memory" | "user"): string {
    return path.join(this.memoryDir, target === "user" ? USER_FILE : MEMORY_FILE);
  }

  private entriesFor(target: "memory" | "user"): string[] {
    return target === "user" ? this.userEntries : this.memoryEntries;
  }

  private setEntries(target: "memory" | "user", entries: string[]): void {
    if (target === "user") this.userEntries = entries;
    else this.memoryEntries = entries;
  }

  private charLimit(target: "memory" | "user"): number {
    return target === "user" ? this.config.userCharLimit : this.config.memoryCharLimit;
  }

  private charCount(target: "memory" | "user"): number {
    const entries = this.entriesFor(target);
    return entries.length ? entries.join(ENTRY_DELIMITER).length : 0;
  }

  // ─── Load from disk ───

  async loadFromDisk(): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    this.memoryEntries = await this.readFile(this.pathFor("memory"));
    this.userEntries = await this.readFile(this.pathFor("user"));

    // Deduplicate preserving order
    this.memoryEntries = [...new Set(this.memoryEntries)];
    this.userEntries = [...new Set(this.userEntries)];

    // Capture frozen snapshot for system prompt injection
    this.snapshot = {
      memory: this.renderBlock("memory", this.memoryEntries),
      user: this.renderBlock("user", this.userEntries),
    };
  }

  // ─── CRUD ───

  add(target: "memory" | "user", content: string): MemoryResult {
    content = content.trim();
    if (!content) return { success: false, error: "Content cannot be empty." };

    const scanError = scanContent(content);
    if (scanError) return { success: false, error: scanError };

    const entries = this.entriesFor(target);
    const limit = this.charLimit(target);

    if (entries.includes(content)) {
      return this.successResponse(target, "Entry already exists (no duplicate added).");
    }

    const newTotal = [...entries, content].join(ENTRY_DELIMITER).length;
    if (newTotal > limit) {
      const current = this.charCount(target);
      return {
        success: false,
        error: `Memory at ${current}/${limit} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first.`,
      };
    }

    entries.push(content);
    this.setEntries(target, entries);
    this.saveToDisk(target);

    return this.successResponse(target, "Entry added.");
  }

  replace(target: "memory" | "user", oldText: string, newContent: string): MemoryResult {
    oldText = oldText.trim();
    newContent = newContent.trim();
    if (!oldText) return { success: false, error: "old_text cannot be empty." };
    if (!newContent) return { success: false, error: "new_content cannot be empty. Use 'remove' to delete entries." };

    const scanError = scanContent(newContent);
    if (scanError) return { success: false, error: scanError };

    const entries = this.entriesFor(target);
    const matches = entries.filter((e) => e.includes(oldText));

    if (matches.length === 0) return { success: false, error: `No entry matched '${oldText}'.` };
    if (matches.length > 1 && new Set(matches).size > 1) {
      return {
        success: false,
        error: `Multiple entries matched '${oldText}'. Be more specific.`,
        matches: matches.map((e) => e.slice(0, 80) + (e.length > 80 ? "..." : "")),
      };
    }

    const idx = entries.indexOf(matches[0]);
    const testEntries = [...entries];
    testEntries[idx] = newContent;
    const newTotal = testEntries.join(ENTRY_DELIMITER).length;

    if (newTotal > this.charLimit(target)) {
      return {
        success: false,
        error: `Replacement would put memory at ${newTotal}/${this.charLimit(target)} chars. Shorten or remove other entries first.`,
      };
    }

    entries[idx] = newContent;
    this.setEntries(target, entries);
    this.saveToDisk(target);

    return this.successResponse(target, "Entry replaced.");
  }

  remove(target: "memory" | "user", oldText: string): MemoryResult {
    oldText = oldText.trim();
    if (!oldText) return { success: false, error: "old_text cannot be empty." };

    const entries = this.entriesFor(target);
    const matches = entries.filter((e) => e.includes(oldText));

    if (matches.length === 0) return { success: false, error: `No entry matched '${oldText}'.` };
    if (matches.length > 1 && new Set(matches).size > 1) {
      return {
        success: false,
        error: `Multiple entries matched '${oldText}'. Be more specific.`,
        matches: matches.map((e) => e.slice(0, 80) + (e.length > 80 ? "..." : "")),
      };
    }

    const idx = entries.indexOf(matches[0]);
    entries.splice(idx, 1);
    this.setEntries(target, entries);
    this.saveToDisk(target);

    return this.successResponse(target, "Entry removed.");
  }

  // ─── System prompt injection (frozen snapshot) ───

  formatForSystemPrompt(): string {
    const parts: string[] = [];
    if (this.snapshot.memory) parts.push(this.snapshot.memory);
    if (this.snapshot.user) parts.push(this.snapshot.user);
    return parts.join("\n\n");
  }

  getMemoryEntries(): string[] {
    return [...this.memoryEntries];
  }

  getUserEntries(): string[] {
    return [...this.userEntries];
  }

  // ─── Internal helpers ───

  private successResponse(target: "memory" | "user", message?: string): MemoryResult {
    const entries = this.entriesFor(target);
    const current = this.charCount(target);
    const limit = this.charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;

    const resp: MemoryResult = {
      success: true,
      target,
      entries,
      usage: `${pct}% — ${current}/${limit} chars`,
      entry_count: entries.length,
    };
    if (message) resp.message = message;
    return resp;
  }

  private renderBlock(target: "memory" | "user", entries: string[]): string {
    if (!entries.length) return "";
    const limit = this.charLimit(target);
    const content = entries.join(ENTRY_DELIMITER);
    const current = content.length;
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;

    const header = target === "user"
      ? `USER PROFILE (who the user is) [${pct}% — ${current}/${limit} chars]`
      : `MEMORY (your personal notes) [${pct}% — ${current}/${limit} chars]`;

    const separator = "═".repeat(46);
    return `${separator}\n${header}\n${separator}\n${content}`;
  }

  private async readFile(filePath: string): Promise<string[]> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      if (!raw.trim()) return [];
      return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Atomic write: temp file + fs.rename() — same crash-safety as Hermes. */
  private saveToDisk(target: "memory" | "user"): void {
    const filePath = this.pathFor(target);
    const entries = this.entriesFor(target);
    const content = entries.length ? entries.join(ENTRY_DELIMITER) : "";

    // Fire-and-forget atomic write
    fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-")).then((tmpDir) => {
      const tmpPath = path.join(tmpDir, "write.tmp");
      return fs
        .writeFile(tmpPath, content, "utf-8")
        .then(() => fs.rename(tmpPath, filePath))
        .catch(async () => {
          try { await fs.unlink(tmpPath); } catch { /* ignore */ }
        })
        .finally(async () => {
          try { await fs.rmdir(tmpDir); } catch { /* ignore */ }
        });
    });
  }
}
