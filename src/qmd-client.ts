/**
 * qmd-client.ts — optional semantic search via the qmd CLI (@tobilu/qmd).
 *
 * qmd is a local, on-device search engine for markdown files (BM25 keyword +
 * vector semantic + LLM rerank). When the user installs `qmd` and enables
 * `qmdSearch` in the extension config, memory_search can fall back to qmd
 * for meaning-based recall that FTS5 keyword matching misses.
 *
 * Everything here is best-effort: if qmd is missing, the binary fails, or a
 * call times out, the caller falls back to the existing SQLite FTS5 path.
 * A failed qmd call must never break a memory_search invocation.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const QMD_DETECT_TIMEOUT_MS = 3000;
const QMD_SEARCH_TIMEOUT_MS = 15000;
const QMD_REINDEX_TIMEOUT_MS = 30000;

let qmdAvailable: boolean | null = null;

export interface QmdSearchHit {
  /** Document path as reported by qmd (relative to the collection root). */
  path: string;
  /** Snippet text when qmd returns one. */
  snippet?: string;
  /** qmd relevance score when present. */
  score?: number;
}

export interface QmdSearchResult {
  ok: boolean;
  hits: QmdSearchHit[];
  error?: string;
}

function runQmd(args: string[], timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile("qmd", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}

/**
 * Detect whether the qmd binary is on PATH. Cached per process; a failed
 * detection is cached as unavailable so we don't shell out on every search.
 */
export async function isQmdAvailable(): Promise<boolean> {
  if (qmdAvailable !== null) return qmdAvailable;
  const result = await runQmd(["--version"], QMD_DETECT_TIMEOUT_MS);
  qmdAvailable = result.ok;
  return qmdAvailable;
}

/** Reset the cached detection (test hook). */
export function _resetQmdDetection(): void {
  qmdAvailable = null;
}

/**
 * Ensure a qmd collection exists for the given directory. Idempotent and
 * best-effort: collection add fails silently if the collection already
 * exists (qmd returns non-zero), which is fine.
 */
export async function ensureQmdCollection(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return;
  await runQmd(["collection", "add", dir, "--name", "pi-hermes-memory"], QMD_DETECT_TIMEOUT_MS);
}

/**
 * Reindex the memory directory into the qmd collection. Fire-and-forget from
 * the caller's perspective: a failed reindex is logged and ignored.
 */
export async function reindexQmd(dir: string): Promise<void> {
  if (!(await isQmdAvailable())) return;
  await ensureQmdCollection(dir);
  await runQmd(["embed", "--collection", "pi-hermes-memory"], QMD_REINDEX_TIMEOUT_MS);
}

/**
 * Semantic search over the memory directory via qmd. Returns parsed hits on
 * success; on any failure returns { ok: false } so the caller can fall back.
 */
export async function qmdSearch(query: string, dir: string, limit = 10): Promise<QmdSearchResult> {
  if (!(await isQmdAvailable())) {
    return { ok: false, hits: [], error: "qmd not available" };
  }
  await ensureQmdCollection(dir);

  const result = await runQmd(
    ["query", query, "--collection", "pi-hermes-memory", "--json", "-n", String(limit)],
    QMD_SEARCH_TIMEOUT_MS,
  );
  if (!result.ok) {
    return { ok: false, hits: [], error: result.error };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const hits: QmdSearchHit[] = Array.isArray(parsed)
      ? parsed.map((item: Record<string, unknown>) => ({
          path: typeof item.path === "string" ? item.path : String(item.docid ?? ""),
          snippet: typeof item.snippet === "string" ? item.snippet : undefined,
          score: typeof item.score === "number" ? item.score : undefined,
        }))
      : [];
    return { ok: true, hits };
  } catch {
    return { ok: false, hits: [], error: "qmd returned unparseable output" };
  }
}
