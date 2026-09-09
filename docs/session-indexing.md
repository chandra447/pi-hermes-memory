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
file identity, size, mtime, session header, and hashes of the first and boundary
4 KiB. Normal appends only scan new bytes. Truncation, replacement, same-size
rewrites, missing indexed sessions, or changed fingerprint samples cause a
rescan. This assumes Pi's append-only JSONL contract; an arbitrary in-place edit
outside the fingerprint samples combined with an append is not detectable.

Partial trailing records are retried. Malformed newline-terminated records are
skipped. Checkpoints are published only after batch writes complete and only
if the file has not changed during the pass. Interrupted scans can safely
replay already committed batches using message IDs. Session files and Markdown
memories are never rewritten by the indexer.

To reproduce a large-session memory test without changing the production index:

```sh
node --max-old-space-size=128 --import tsx scripts/benchmark-session-index.ts /path/to/session.jsonl
```

The script creates and removes its own temporary database and prints only
counts, timings, and process memory metrics, never message content.
