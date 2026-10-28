/**
 * Cross-session overflow-episode state (#284).
 *
 * Policy-only memory never holds the Markdown export cap, so a store that is
 * over its goal is a budget question rather than a defect (#218/#221/#248).
 * The write path only records that the store crossed its goal — the LLM
 * consolidation itself runs at a lifecycle boundary (see
 * `MemoryStore.runOverflowSweep`), so a `memory_add` that already succeeded
 * never blocks on a `pi -p` child.
 *
 * The state has to be visible to other sessions, so it is a small JSON sidecar
 * next to the memory files, keyed by `getStorageIdentity(target)`:
 *
 *   { "<storage identity>": { "openAt": 1699999999999, "cooldownUntil": 0 } }
 *
 * `openAt` is the timestamp the store crossed over its goal while no episode
 * was open; `null` means no episode is open. `cooldownUntil` bounds how often
 * a new episode may arm once one has been acted on. Both are wall-clock ms.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { OVERFLOW_EPISODE_FILE } from "../constants.js";

export interface OverflowEpisode {
  /** When the store crossed over its goal with no episode open; null = closed. */
  openAt: number | null;
  /** A new episode may not arm before this wall-clock time. 0 = no cooldown. */
  cooldownUntil: number;
}

export type OverflowEpisodeState = Record<string, OverflowEpisode>;

function isOverflowEpisode(value: unknown): value is OverflowEpisode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OverflowEpisode>;
  const openAtOk = candidate.openAt === null
    || (typeof candidate.openAt === "number" && Number.isFinite(candidate.openAt));
  return openAtOk && typeof candidate.cooldownUntil === "number" && Number.isFinite(candidate.cooldownUntil);
}

/**
 * Read the sidecar for one store directory. A missing, unreadable or corrupt
 * file is an empty state — episode bookkeeping must never fail a memory write.
 */
export async function readOverflowEpisodes(memoryDir: string): Promise<OverflowEpisodeState> {
  try {
    const raw = await fs.readFile(path.join(memoryDir, OVERFLOW_EPISODE_FILE), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const state: OverflowEpisodeState = {};
    for (const [identity, episode] of Object.entries(parsed as Record<string, unknown>)) {
      if (isOverflowEpisode(episode)) state[identity] = episode;
    }
    return state;
  } catch {
    return {};
  }
}

/**
 * Atomically replace the sidecar (temp file + rename) so a concurrent session
 * never reads a half-written file. Drops entries that are neither open nor
 * cooling down, which keeps the file bounded at one row per live store.
 */
export async function writeOverflowEpisodes(memoryDir: string, state: OverflowEpisodeState): Promise<void> {
  const kept: OverflowEpisodeState = {};
  for (const [identity, episode] of Object.entries(state)) {
    if (episode.openAt !== null || episode.cooldownUntil > 0) kept[identity] = episode;
  }
  const target = path.join(memoryDir, OVERFLOW_EPISODE_FILE);
  await fs.mkdir(memoryDir, { recursive: true });
  const tmpPath = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(kept, null, 2)}\n`, "utf-8");
    await fs.rename(tmpPath, target);
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Best effort — the rename is what matters.
    }
    throw error;
  }
}
