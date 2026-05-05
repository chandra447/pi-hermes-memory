# v0.6.6 Changelog

## Bug Fixes

### Fix legacy SQLite upgrade error: `no such column: category`

Some users upgrading from older versions had an existing `sessions.db` with a legacy
`memories` table that did not include v0.6 failure-memory columns. During schema init,
creating `idx_memories_category` failed and `/memory-index-sessions` crashed with:

`❌ Session indexing failed: no such column: category`

Fix:

- Added automatic legacy schema migration in `DatabaseManager`
- Detects missing `memories` columns and adds them idempotently:
  - `category`
  - `failure_reason`
  - `tool_state`
  - `corrected_to`
- Retries schema initialization after migration
- Added regression test: `should migrate legacy memories table without category column`

---

# v0.6.5 Changelog

## Bug Fixes

### Auto-review no longer blocks interactive chat (#10)

The background auto-review was `await`ing `pi.exec()` inside the `turn_end` handler, which
blocked the chat from responding while the review subprocess ran. Fixed by making the
review subprocess fire-and-forget — the turn_end handler returns immediately, and the
subprocess completes asynchronously.

- `pi.exec()` is no longer awaited — handler returns immediately
- `reviewInProgress` guard resets in `.then()` / `.catch()` callbacks
- Overlapping reviews are still prevented by the guard
- Notifications are delivered via `.then()` callback once the subprocess completes

### Auto-review failures on Windows no longer show errors (#9)

On Windows git-bash, `pi exec` subprocesses could exit with code 1 producing
`[hermes] auto-review failed (exit=1): unknown error` messages every few turns. Fixed by
making auto-review truly best-effort — non-zero exit codes and spawn errors are silently
ignored.

- Suppressed error notifications for non-zero exit codes
- Suppressed error notifications for subprocess failures (timeout, signal, spawn)
- The next review cycle will retry automatically

### Crash safety

- Snapshot-building code (`getBranch()`, message parsing) is wrapped in a minimal try/catch
  to handle expired sessions gracefully
- Early return resets `reviewInProgress` guard to unblock future reviews
