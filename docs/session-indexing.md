# Streaming session indexing

The search indexer reads JSONL in 64 KiB chunks with a streaming JSON tokenizer.
It never assembles a whole file or line. Image data, thinking, tool arguments,
and tool output are not materialized. Searchable text keeps both ends within
the existing 100 KiB per-message limit; tool-name lists are capped at 1,024.
Database batches are limited to 64 messages or 512 KiB of text.

Live, startup, manual, and shutdown indexing use the same scanner. Production
scans are serialized and yield to the event loop roughly every 8 ms, including
while scanning a large individual record. The synchronous APIs remain for
compatibility; production hooks use the asynchronous variants.

Each successful pass stores an index checkpoint in `extension_metadata` under
`session-index-v1:<file path>`. The checkpoint records the completed byte offset,
file identity, completed-prefix size, mtime, session header, and a hash sampling
up to 4 KiB each at the head, centered midpoint, and boundary of that prefix.
Normal appends only scan new bytes. Truncation, replacement, same-size rewrites
with changed mtime, missing indexed sessions, or changed fingerprint samples
cause a rescan. Older two-window fingerprints mismatch and rescan once.

This optimizes append-only histories; append-only behavior is not a guaranteed
Pi contract. These are **sampled fingerprints**, not full-prefix hashes: edits
outside the sampled windows can remain undetected when combined with growth or
preserved metadata. The midpoint window reduces, but does not eliminate, that
limitation. Filesystem reads/stat calls are not an atomic snapshot; transient
rewrites restored between checks are also outside this guarantee.

Partial trailing records are retried. Malformed newline-terminated records are
skipped. Each scan freezes its end at the starting file size and compares
head/midpoint/boundary samples of that same extent before and after scanning.
Checkpoints publish only after all batches commit, with unchanged identity,
nondecreasing size, matching samples, and either growth or unchanged mtime.
Thus an append during a scan retains progress only through the completed record
boundary; the next pass reads the new tail (and retries any partial record).
The start/end validation extent includes any incomplete trailing record, while
the saved checkpoint samples end at the completed boundary.

Detected mutation discards the session's derived message rows, checkpoint, and
file metadata so the next pass rebuilds without retaining stale committed rows.
Interrupted scans can safely replay already committed batches using message
IDs; there is no per-batch checkpoint. Session files and Markdown memories are
never rewritten by the indexer.

To reproduce a large-session memory test without changing the production index:

```sh
node --max-old-space-size=128 --import tsx scripts/benchmark-session-index.ts /path/to/session.jsonl
```

The script creates and removes its own temporary database and prints only
counts, timings, and process memory metrics, never message content.
