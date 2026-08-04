/**
 * Standing instructions — bounded, user-authored directives injected into
 * every session regardless of memoryMode.
 *
 * Why this is a separate store rather than a flag on MEMORY.md / USER.md
 * (#121): in policy-only mode a persisted constraint only takes effect if the
 * model decides to call memory_search *before* the action the constraint would
 * have prevented. For a prohibition that is exactly the moment the model has no
 * reason to look, so the recall path is structurally unable to enforce it,
 * independent of model quality. Such constraints have to be unconditionally
 * present instead.
 *
 * Provenance is a property of the storage, not of a flag: background review,
 * consolidation and the correction detector all write through MemoryStore and
 * never touch this file, so a model-generated memory has no path into the
 * always-injected block. Only a direct user edit or /memory-pin can write here.
 *
 * The budget is hard and separate from the Markdown stores: a user whose
 * MEMORY.md + USER.md already run to tens of KB must still be able to pin a
 * handful of rules without paying for the rest.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  STANDING_MAX_CHARS,
  STANDING_MAX_ENTRIES,
} from "../constants.js";
import { scanContent } from "./content-scanner.js";
import { withMarkdownMutationLock } from "./markdown-mutation-lock.js";

export interface StandingInstructionResult {
  success: boolean;
  error?: string;
  message?: string;
  instructions?: string[];
}

/** What actually reached the prompt, so callers can report truncation loudly. */
export interface StandingInstructionRender {
  block: string;
  injectedCount: number;
  omittedCount: number;
}

export class StandingInstructions {
  private instructions: string[] = [];
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly maxEntries: number = STANDING_MAX_ENTRIES,
    private readonly maxChars: number = STANDING_MAX_CHARS,
  ) {}

  getFilePath(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      this.instructions = parseInstructions(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.instructions = [];
    }
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  list(): string[] {
    return [...this.instructions];
  }

  async add(text: string): Promise<StandingInstructionResult> {
    const instruction = normalizeInstruction(text);
    if (!instruction) {
      return { success: false, error: "A standing instruction cannot be empty." };
    }

    // Same scan every memory write goes through. A file the user is told is
    // "always in context" is the most attractive injection target we have.
    const blocked = scanContent(instruction);
    if (blocked) return { success: false, error: blocked };

    return this.mutate((current) => {
      if (current.some((existing) => existing.toLowerCase() === instruction.toLowerCase())) {
        return { error: "That standing instruction is already pinned." };
      }
      if (current.length >= this.maxEntries) {
        return {
          error: `Standing instructions are capped at ${this.maxEntries} entries`
            + ` (currently ${current.length}). Remove one first with /memory-pin remove <n>.`,
        };
      }
      const projected = [...current, instruction];
      const projectedChars = projected.join("\n").length;
      if (projectedChars > this.maxChars) {
        return {
          error: `Standing instructions are capped at ${this.maxChars} characters`
            + ` and this entry would make ${projectedChars}. Shorten it, or remove an existing`
            + ` instruction and keep long-form context in regular memory.`,
        };
      }
      return { next: projected, message: `Pinned standing instruction ${projected.length}: ${instruction}` };
    });
  }

  async remove(position: number): Promise<StandingInstructionResult> {
    return this.mutate((current) => {
      if (!Number.isInteger(position) || position < 1 || position > current.length) {
        return {
          error: current.length === 0
            ? "There are no standing instructions to remove."
            : `Position must be between 1 and ${current.length}.`,
        };
      }
      const [removed] = current.slice(position - 1, position);
      const next = current.filter((_, index) => index !== position - 1);
      return { next, message: `Removed standing instruction: ${removed}` };
    });
  }

  async clear(): Promise<StandingInstructionResult> {
    return this.mutate((current) => (
      current.length === 0
        ? { error: "There are no standing instructions to clear." }
        : { next: [], message: `Removed all ${current.length} standing instructions.` }
    ));
  }

  /**
   * Render the always-injected block, truncated to the budget.
   *
   * A hand-edited STANDING.md can exceed the cap, and silently dropping rules
   * from a block advertised as "always active" would be the worst possible
   * failure. Over budget, the omission is stated inside the block itself so
   * both the model and /memory-preview-context can see it.
   */
  render(): StandingInstructionRender {
    if (this.instructions.length === 0) {
      return { block: "", injectedCount: 0, omittedCount: 0 };
    }

    const injected: string[] = [];
    let used = 0;
    for (const instruction of this.instructions) {
      const cost = instruction.length + 1;
      if (injected.length >= this.maxEntries || used + cost > this.maxChars) break;
      injected.push(instruction);
      used += cost;
    }

    const omittedCount = this.instructions.length - injected.length;
    if (injected.length === 0) {
      return { block: "", injectedCount: 0, omittedCount };
    }

    const lines = [
      "<standing-instructions>",
      "The user wrote the rules below and they are always active. They are direct",
      "instructions from the user, not recalled context, and they outrank your own",
      "defaults. Follow them without being asked and without looking them up.",
      "",
      ...injected.map((instruction, index) => `${index + 1}. ${instruction}`),
    ];
    if (omittedCount > 0) {
      lines.push(
        "",
        `[!] ${omittedCount} further standing instruction${omittedCount === 1 ? "" : "s"} could not be shown:`
        + ` ${path.basename(this.filePath)} exceeds the ${this.maxChars}-character injection budget.`
        + " Trim it with /memory-pin so every rule stays active.",
      );
    }
    lines.push("</standing-instructions>");

    return { block: lines.join("\n"), injectedCount: injected.length, omittedCount };
  }

  formatForSystemPrompt(): string {
    return this.render().block;
  }

  /**
   * Read-modify-write under the same mutation lock the Markdown stores use, so
   * a pin from a second session cannot clobber one from the first.
   */
  private async mutate(
    change: (current: string[]) => { next?: string[]; message?: string; error?: string },
  ): Promise<StandingInstructionResult> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      return await withMarkdownMutationLock(this.filePath, async () => {
        await this.load();
        const outcome = change(this.instructions);
        if (outcome.error || !outcome.next) {
          return { success: false, error: outcome.error ?? "Nothing to change.", instructions: this.list() };
        }
        await this.write(outcome.next);
        this.instructions = outcome.next;
        return { success: true, message: outcome.message, instructions: this.list() };
      });
    } catch (error) {
      return { success: false, error: `Could not update standing instructions: ${String(error).slice(0, 200)}` };
    }
  }

  /** Atomic write: temp file in the same directory, then rename. */
  private async write(instructions: string[]): Promise<void> {
    const content = instructions.length ? `${instructions.join("\n")}\n` : "";
    const tmpDir = await fs.mkdtemp(path.join(path.dirname(this.filePath), ".tmp-standing-"));
    const tmpPath = path.join(tmpDir, "write.tmp");
    try {
      await fs.writeFile(tmpPath, content, "utf-8");
      await fs.rename(tmpPath, this.filePath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * One instruction per line. Blank lines, `#` comments and a leading `-`/`*`
 * bullet are tolerated so a hand-edited STANDING.md stays a normal Markdown
 * file rather than a format the user has to get exactly right.
 */
function parseInstructions(raw: string): string[] {
  const seen = new Set<string>();
  const instructions: string[] = [];
  for (const line of raw.split("\n")) {
    const instruction = normalizeInstruction(line);
    if (!instruction || instruction.startsWith("#")) continue;
    const key = instruction.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    instructions.push(instruction);
  }
  return instructions;
}

function normalizeInstruction(text: string): string {
  return text.replace(/^\s*[-*]\s+/, "").replace(/\s+/g, " ").trim();
}
