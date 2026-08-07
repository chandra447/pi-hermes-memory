# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.3] - 2026-08-04

### Added

- **Standing instructions: user-authored rules that are always in context** ([#121](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/121), designed with [@jagaliano](https://github.com/jagaliano)): in `policy-only` mode a persisted constraint only takes effect if the model chooses to call `memory_search` **before** the action the constraint would have prevented. For a prohibition that is exactly the moment the model has no reason to look, so the recall path is structurally unable to enforce prohibitions, independent of model quality. It works fine for preferences, where a wrong guess is cheap. `/memory-pin <rule>` writes to a new `~/.pi/agent/pi-hermes-memory/STANDING.md` that is injected into **every** session, in every memory mode, in its own `<standing-instructions>` block after the memory policy. Background review, consolidation and the correction detector all write through `MemoryStore` and never touch this file, so a model-generated memory has no path into the trusted block — provenance is a property of the storage rather than of a flag. Hard cap of 20 entries / 2000 characters, independent of `memoryCharLimit` and `userCharLimit`; a hand-edited file over the cap is truncated at injection and the omission is stated inside the block rather than dropped silently. Every pin goes through the same `scanContent()` scan as any memory write. `/memory-pin` also takes `list`, `remove <n>` and `clear`; `/memory-preview-context` shows the block and flags over-budget entries. Set `standingInstructionsEnabled: false` to drop the store and the command.

### Fixed

- **Consolidation lock contention no longer hard-fails memory writes** ([#144](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/144), reported by [@Frank-Opus](https://github.com/Frank-Opus)): while any session held a consolidation lock, **every** capacity-exceeding memory write in **every** session failed with `Consolidation already in progress ... Skipping duplicate subprocess`, for the full `staleMs` window. Three defects: the lock gave up on the first collision while `acquireMarkdownMutationLock` already polled with a deadline; `staleMs` was `timeoutMs + 30s` (210s) against a worst-case hold of `2 x timeoutMs` (360s), so a *healthy* consolidator could be robbed mid-run and two children could write the same store; and contention was reported as a failure. Acquisition now polls with a bounded 5s window, the holder heartbeats its lease every 10s (`AtomicLockCoordinator.renew()`, token-fenced) so `staleMs` drops to a fixed 45s — a wedged holder is reclaimed 4.5x faster while a slow-but-healthy one cannot lose its lease at all — and contention returns `deferred` with *"retry in a moment"* rather than a broken-consolidation error. After waiting out contention the target is re-read from disk, and if the session ahead already freed space the redundant LLM pass is skipped. Lock rows whose holder process is gone are now garbage-collected; previously a storage identity that never returned leaked its row forever.
- **Provider auth is resolved against fresh credentials on every direct call** ([#139](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/139), reported by [@avinashkanaujiya](https://github.com/avinashkanaujiya)): Pi's `AuthStorage` parses `auth.json` once in its constructor and only reloads it when an OAuth refresh fails, and `ExtensionRunner` hands every event the same `ModelRegistry` singleton — so an `api_key` credential was frozen for the process lifetime. A key rotated on disk mid-session (for example by `@lnilluv/pi-opencode-go-rotation` after a weekly limit) stayed invisible, and every direct memory completion kept presenting the revoked key while everything else in the user's setup had already picked up the new one. Credentials are now re-read before each direct completion, and a provider auth rejection mid-request triggers one retry with a refreshed key — but only when the key actually changed, so a genuine auth failure still falls through to the subprocess transport. A malformed `auth.json` degrades to the already-loaded credentials instead of taking the review path down. Known gap: `!command`-backed keys remain cached in the SDK's own `commandResultCache`, which an extension has no supported way to clear.
- **Documented git install commands actually work** ([#140](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/140), fixed by [@xz-dev](https://github.com/xz-dev)): `pi install git:github:<owner>/<repo>` parses but resolves to `https://github:<owner>/<repo>`, taking `github` as the hostname and the owner as the port, and fails at `git clone`. `AGENTS.md` and `docs/PUBLISHING.md` additionally used a bare `github:` shorthand that Pi's `parseGitUrl` rejects outright.

### Changed

- **Minimum supported Pi corrected to 0.80.1, and now verified in CI**: `peerDependencies` declared `>=0.74.0`, but `src/handlers/review-memory-ops.ts` imports `@earendil-works/pi-ai/compat`, a subpath that does not exist before 0.80.1 — so every user on 0.74 through 0.79.x got `ERR_PACKAGE_PATH_NOT_EXPORTED` and no extension at all, while `package.json` told them they were supported. The floor is corrected, and a new `min-sdk` CI job installs exactly the declared minimum and type-checks against it, so the advertised range can no longer drift from reality. The regular `check` job could never catch this: it installs whatever the devDependency range resolves to, which is always new enough.

### Upgrading

- **Nothing changes until you pin something.** With no `STANDING.md` on disk — every existing install — the injected system prompt is byte-identical to 0.9.2. `policy-only` still means stored Markdown memories stay out of the prompt; what it no longer means is "nothing but policy", since anything you explicitly pin is now always present. That is a change to a previously documented guarantee, so it is stated here rather than left to be discovered.
- **The peer floor bump cannot block an install.** Pi's package manager never reads `peerDependencies`; the range is advisory metadata. Users below 0.80.1 were already unable to load the extension at all.
- **During the upgrade window only**, a 0.9.2 session and an upgraded session consolidating the *same* target concurrently can overlap: the old build does not heartbeat, so the new one may reclaim its lease after 45s. Markdown writes stay serialized by the mutation lock, so the worst case is that one redundant consolidation's result is superseded — no entry loss or corruption. It resolves as soon as every session is on the new build.

## [0.9.2] - 2026-07-30

### Fixed

- **Auto-consolidation no longer dies on a timeout the manual path never had** ([#136](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/136), reported by [@jasonrr](https://github.com/jasonrr)): `consolidationTimeoutMs` defaulted to 60s, but `/memory-consolidate` quietly floored itself at 180s while the over-capacity auto path passed the raw 60s straight to a `pi -p` child. A consolidation pays child-process boot plus a full LLM turn, so on stock defaults the auto path was killed mid-run every time — 100% failure on slower models or near-full memory, while manual runs of the same memory succeeded. The default is now **180000** and both paths use the configured value verbatim; the manual floor that hid the mismatch is gone. A configured value below the default is still honored, but `loadConfig` warns at startup that it is likely to be killed mid-run.
- **Auto-consolidation failures are surfaced instead of swallowed** ([#135](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/135), reported by [@jasonrr](https://github.com/jasonrr)): `triggerConsolidation` returns a specific reason for every failure mode — lock contention, spawn failure, non-zero exit, timeout kill — and `MemoryStore` discarded all of it in a bare `catch {}`, returning the unchanged `Memory at N/M chars...` capacity error. Every mode looked identical to a memory that was simply full, and the auto path was undiagnosable from outside. The reason is now appended to the tool result (`... Auto-consolidation attempted but failed: <reason>`) and logged once per failure. A consolidation that ran successfully but freed no space is reported distinctly (`Auto-consolidation ran but did not free enough space.`), as is a reload failure after a successful consolidation.

## [0.9.1] - 2026-07-27

### Changed

- **Global skills return to `~/.pi/agent/pi-hermes-memory/skills/`** ([#126](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/126), reported by [@kdejaeger](https://github.com/kdejaeger)): 0.9.0 moved them into Pi's own `~/.pi/agent/skills/` to eliminate a shadowing bug. That fixed the bug by deleting one of the two directories, and took a deliberate design property with it — skills this extension curates from your sessions were mixed in with skills you installed yourself, so you could no longer wipe or audit ours without picking through yours. Worse, `skill_manage delete` gained the ability to remove hand-written skills it never created. Skills are separated by who writes them again.
- **`skill_manage delete` can no longer target Pi's global skills root.** It reaches only this extension's own global directory and the active project's. Skills you installed yourself are out of its blast radius.

### Fixed

- **Silent write-loss on shadowed global skill names, fixed at the source** ([#125](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/125)): Pi keys skills by name, first-loaded wins, and its own `~/.pi/agent/skills/` outranks anything an extension contributes via `resources_discover`. Creating a global skill under a name already present there wrote a file Pi never loads and reported success. Rather than removing one of the directories, `skill_manage` now **refuses** such a write and names both paths, so the shadowed state cannot be created in the first place. Project scope is unaffected — only the global root collides.

### Upgrading

If you ran 0.9.0, the skills it relocated into `~/.pi/agent/skills/` **stay there** and keep working. They are not moved back automatically: 0.9.0's migration renamed each skill and then removed its source directory without recording a manifest, and skill frontmatter carries no provenance field, so there is no reliable way to tell which skills in Pi's root came from this extension and which are yours. Moving files out of your global root on a guess would be a worse version of the mistake being corrected here. Move any you want back by hand, or open an issue and a confirmation-gated `/memory-skills reclaim` will be added.

## [0.9.0] - 2026-07-26

### Changed

- **Global skills moved to `~/.pi/agent/skills/`.** `skill_manage` with `scope: "global"` previously wrote to a private `~/.pi/agent/pi-hermes-memory/skills/`. Existing global skills are relocated automatically on first run. Because that directory is Pi's own user-skills root, `/memory-skills` now also lists skills you wrote by hand or that another tool installed there. See the #125/#126 entry below for why the private directory could not stay.
- **Project identity follows the Git repository, not the working directory name.** Running Pi from a linked worktree or a subdirectory of a repository now resolves to the repository's project scope. Directories that already exist under the old cwd-basename identity keep being used, so nothing is orphaned on upgrade.

### Fixed

- **Git worktrees each became their own project** ([#120](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/120)): project-scoped memory and skills were keyed off `path.basename(cwd)`, so running Pi in a linked worktree wrote to `projects-memory/<worktree-name>/`. Deleting the worktree after merging stranded that memory and those skills where the main checkout could never see them. Inside a Git repository the project name is now the *repository* root's basename — resolved from the worktree's `.git` pointer and its `commondir`, with no `git` subprocess — so every worktree and every subdirectory of a repository shares one identity. An existing `projects-memory/<cwd-basename>/` store still wins over a newly derived repository name, so upgrading never orphans memory written under the old identity.
- **Global skills were permanently shadowed by Pi's own skills root** ([#125](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/125), [#126](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/126)): `skill_manage` with `scope: "global"` wrote to `~/.pi/agent/pi-hermes-memory/skills/`, which the extension then contributed as an extra scan root. Pi keys skills by name, first-loaded wins, and its own `~/.pi/agent/skills/` is auto-discovered at higher precedence — so any name present in both places produced a collision warning every session **and** silently ignored our copy, making `skill_manage` edits a no-op against the skill the agent actually loaded. Global skills now live in `~/.pi/agent/skills/` alongside every other user skill, and only the project skills directory is contributed via `resources_discover`. Existing skills are moved out of the private directory on first run; a name that already exists in Pi's root is left untouched and reported rather than clobbered. `SKILL_TOOL_DESCRIPTION` now states the on-disk path for each scope.

### Performance

- **Session start no longer churns SQLite connections** ([#124](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/124), thanks [@Fraguinha](https://github.com/Fraguinha)): `AtomicLockCoordinator` opened and closed a fresh connection for every `tryAcquire`/`isCurrentOwner`/`release` — each open running PRAGMA setup plus `CREATE TABLE IF NOT EXISTS`, each close triggering a WAL checkpoint — and `syncMarkdownMemoriesToSqlite` constructed a new coordinator per file. On a 2.5 MB `sessions.db` this accounted for **16.7s of better-sqlite3 CPU per `/new` or `/resume`, now 3.7s**. Connections are cached per coordinator and coordinators are shared per database path, so every lock site (markdown mutations, consolidation, corruption recovery, legacy-root migration) reuses one connection instead of leaking one per call.

## [0.8.3] - 2026-07-26

> Tagged but never published to npm; its fixes ship in 0.9.0.

### Fixed

- **Compiled Pi failed to load the extension at all** ([#117](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/117)): `src/extension-root-migration.ts` resolved `better-sqlite3` at module scope, and `src/index.ts` imports it during extension load. Compiled Pi runs on Bun, whose resolver cannot find `better-sqlite3` (nor its transitive `bindings`) from an on-disk extension file, so every session started with `Failed to load extension: ResolveMessage: Cannot find package 'better-sqlite3'` and the whole extension was dead. The legacy-root migration now resolves SQLite lazily and routes through `bun:sqlite` under Bun, matching what `db.ts` and `atomic-lock-coordinator.ts` already did. Those two also defer their native load out of module scope, so an ABI mismatch now surfaces as an actionable in-session error (the recovery guidance added in 0.8.2) instead of a fatal extension-load failure.
- **`memory_search` silently missed natural-language queries with uppercase connectors** ([#122](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/122), [#127](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/127)): a query like `DO NOT USE FIND /` was classified as raw FTS5 syntax because of the uppercase `NOT`, the unquoted `/` then failed to parse, and the parse error was flattened into "no memories found" with the safe fallback skipped — while the same query in lowercase worked. Both `memory_search` and `session_search` now retry as quoted natural language when (and only when) the raw query fails to parse, preserving `target`/`project`/`limit` filters on the retry. Intentional operator queries such as `pnpm OR AEST` keep their exact semantics.

## [0.8.2] - 2026-07-21

### Fixed

- **Silent memory data loss after external `MEMORY.md` edits** ([#112](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/112), [#113](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/113)): manual truncate/`cp` races could return `success: true` with stale usage while the live Markdown file was empty and the SQLite search mirror was wiped. Mutations now treat disk as source of truth, refresh usage/entry counts from disk, retry post-publish fingerprint mismatches, and always reconcile SQLite via the existing mutation observer (including failed writes). Exhausted external-write conflicts point at `/memory-sync-markdown`.
- **Immediate `database is locked` under concurrent Pi writers** ([#110](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/110), [#113](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/113)): `DatabaseManager` now sets `PRAGMA busy_timeout = 5000` so short overlapping writers serialize instead of failing immediately.
- **Homebrew Pi `better-sqlite3` ABI mismatch** ([#111](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/111), [#114](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/114)): when the native addon was compiled for a different Node ABI than the runtime hosting Pi, load failures are detected, one automatic `npm rebuild better-sqlite3` is attempted against the current Node, and remaining failures return a clear recovery path (including brew/npm guidance).
- **`skill_manage` patch content format corruption** ([#107](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/107), [#115](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/115)): free-form LLM patch payloads (JSON arrays/objects, empty bodies, injected `##` headers) could wipe or splice skill sections. Patch now accepts structured section fields (`procedure_steps` / `pitfalls` / `verification_steps` / `when_to_use`), coerces JSON string arrays into Markdown lists, and rejects unsafe payloads. Prompts steer structured patch and prefer `update` for multi-section rewrites.

## [0.8.1] - 2026-07-14

### Fixed

- **Published package exposed unusable `check`/`test` scripts** ([#108](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/108)): `npm run check` and `npm test` are source-checkout-only (they need TypeScript, `tsconfig.json`, and `tests/`, none of which ship in the production tarball). Running them after `pi install` now fails with a clear message pointing at a git clone + `npm install`, instead of cryptic `tsc: not found` / `tests/run-all.sh: not found` errors. Runtime extension behavior is unchanged; CI still runs these scripts before publish.

## [0.8.0] - 2026-07-12

### Fixed

- **`--no-extensions` silently stripped provider auth adapters from child subprocesses** ([#94](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/94)): child `pi -p` invocations pass `--no-extensions` to skip loading settings.json packages, which also dropped OAuth billing adapters (e.g. `pi-claude-oauth-adapter`) — causing Claude Pro/Max subscription requests from consolidation/flush/correction/review subprocesses to silently rebill as paid "extra usage". Sibling packages matching the `*-oauth-adapter`/`*-auth-adapter` naming convention (including scoped packages) are now auto-detected via their `package.json` `pi.extensions` manifest and re-added to child invocations automatically — no hardcoded adapter list, so a future `xai-oauth-adapter` or similar is picked up without a code change. A new `childExtensionPaths` config option lets users explicitly re-add any other extension.
- **Sensitive prompt payload leaked via argv** ([#95](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/95)): child `pi -p` subprocess invocations (background review fallback, session flush, correction save, consolidation) now write the review/flush/consolidation prompt — which includes current memory, user profile, project memory, and recent transcript — to a private temp file (`0600`, per-invocation temp directory) and pass it via `@<path>` instead of embedding the raw text on the command line. Prevents the prompt from being captured by AV/EDR command-line logging (e.g. Windows Defender Protection History) or `ps`-style process listings. The temp file is deleted immediately after the child process exits.
- **Corrupt-DB recovery fork-storm** ([#96](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/96)): `DatabaseManager` corruption recovery is now gated behind a cross-process advisory lock — concurrent processes wait instead of independently quarantining and rebuilding — with a circuit breaker after repeated recovery failures and bounded backup/temp-file retention. A lock held by a process that's alive but wedged (blocked I/O, suspended) is now reclaimable once its lease exceeds a staleness threshold, and the destructive rebuild rename verifies it still holds the lease immediately before publishing so a resumed stale holder aborts instead of racing the current owner.
- **Duplicate consolidation subprocesses and unserialized memory mutations** ([#97](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/97), [#99](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/99)): concurrent writers to the same Markdown target (add/replace/remove, consolidation, session flush) are now serialized through a token-owned lock, and a content-fingerprint check immediately before every publish detects and safely retries around external/concurrent edits instead of silently overwriting them. Duplicate consolidation subprocess spawns for the same target are also deduplicated.
- **Orphaned SQLite search rows never self-heal** ([#98](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/98)): the SQLite `memory_search` mirror now reconciles against Markdown (the source of truth) on every mutation, automatically pruning rows for entries that were removed, deduplicated, or rewritten in Markdown instead of accumulating permanent orphans that only manual `sqlite3` surgery could clear. The reconciliation pass covers whole scopes (project or target) whose Markdown file was deleted entirely, not just individually-removed entries.
- **Unbounded `session_search` output could blow the model's context window** ([#100](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/100)): a single indexed message could produce a multi-million-character tool result. Legacy `session_search` snippets are now bounded to 1,200 characters by default (configurable 100–4,000 via a new `snippetChars` argument), and every response path — including zero-result and error responses — enforces a hard 50 KiB aggregate ceiling. Truncation is reported via `outputChars`/`outputTruncated`/`truncatedCount` metadata instead of duplicating the full oversized text into the tool's `details` payload.
- **Runaway child `pi` process trees could hang indefinitely** ([#105](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/105), [#106](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/106)): Pi's own child-process timeout only sends `SIGTERM` and considers the child handled once the signal is *sent*, not once it *exits* — a child that traps or ignores `SIGTERM` (e.g. during an unbounded invalid memory-tool retry loop) could run forever, and only the direct child was ever targeted, not its descendants. Every non-interactive child `pi` invocation (review, flush, correction, consolidation) now runs behind a bundled process-tree watchdog that enforces the timeout independently, escalates from graceful `SIGTERM` to a hard, whole-tree `SIGKILL` (POSIX process groups; `taskkill /T /F` on Windows), and routes cancellation through a private marker file instead of forwarding `AbortSignal` directly into the watchdog process.
- **Background review silently dropped a turn on a transient direct-transport failure**: unlike flush, correction detection, and consolidation, the background-review handler didn't catch exceptions from the in-process direct completion path, so a throw skipped the subprocess fallback entirely instead of falling back like its siblings. Found during post-merge verification; now wrapped in the same try/catch pattern as the other three handlers.
- **`session_search`'s `snippetChars` argument accepted non-finite input**: `snippetChars: NaN` bypassed the numeric clamp (unlike the adjacent `limit` argument, which already guarded against this) and silently produced an empty snippet instead of falling back to the default. Found during post-merge verification; now guarded the same way as `limit`.

### Changed

- **In-process direct transport extended to flush, correction save, and consolidation**: session flush, correction detection, and the manual `/memory-consolidate` command now try the same in-process `completeSimple()` transport background review already defaulted to, falling back to a `pi -p` subprocess only on failure. Since there's no subprocess on the common path, this also structurally sidesteps both the argv-leak (#95) and auth-adapter-stripping (#94) issues rather than just working around them — `ctx.modelRegistry` already carries whatever OAuth/billing headers any installed adapter registered, regardless of vendor. The automatic over-capacity consolidator (`MemoryStore`'s internal `setConsolidator` hook) stays subprocess-only by design, since it has no `ExtensionContext` access. Consolidation additionally requires a direct-mode result to have actually freed space (`appliedCount > 0`) before skipping the subprocess fallback, since an empty result there is a functional failure, not a normal outcome.

## [0.7.22] - 2026-06-28

### Fixed

- **Release dependency alignment**: aligned direct `@earendil-works/pi-ai` and `@earendil-works/pi-tui` package ranges with `@earendil-works/pi-coding-agent` 0.80.2 so `npm install` stays lockfile-clean and TypeScript sees a single compatible Pi TUI type surface in CI.

## [0.7.21] - 2026-06-28

### Fixed

- **Custom Pi session directory indexing** ([#90](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/90)): `/memory-index-sessions` now respects `PI_CODING_AGENT_SESSION_DIR`, so users with custom session storage do not need symlinks.
- **Legacy `sessions.db` project-column migration** ([#91](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/91)): older SQLite indexes missing `project` columns on `sessions` or `memories` now migrate automatically and backfill `sessions.project` from the session `cwd`, fixing repeated `no such column: project` errors after upgrades.

## [0.7.20] - 2026-06-25

### Fixed

- **Self-healing corrupt SQLite database** ([#86](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/86)): `DatabaseManager.open()` now runs `PRAGMA quick_check` before and after schema initialization and performs a lossless row-level rebuild (read readable rows → fresh DB → `foreign_key_check` + `quick_check` → atomic swap → quarantine original) when corruption is detected, falling back to recreate-empty only if the rebuild fails. A new `withCorruptionRecovery()` wrapper catches `SQLITE_CORRUPT`/"malformed" errors on writes (including the `message_end` live indexer and `session_shutdown` upsert paths) and heals + retries once, so a torn DB self-heals instead of logging `⚠️ Live session indexing failed` on every turn indefinitely. Also restores `wal_autocheckpoint` to SQLite's default (1000, was 100) to narrow the torn-write window.
- **Graceful close on corrupt handle**: `DatabaseManager.close()` now wraps `this.db.close()` in a try/catch so the recovery `close()` → reopen path doesn't propagate a throw from a corrupt database handle.

## [0.7.19] - 2026-06-23

### Fixed

- **Bounded startup session backfill** ([#83](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/83), [#84](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/84)): startup no longer synchronously parses the full session history. The `session_start` backfill now does a stat-only discovery pass and only parses files without matching stored size/mtime metadata, capped at 50 files per startup, instead of calling `indexAllSessions` on every Pi launch. Eliminates multi-second startup stalls for users with large session archives.
- **Newest-first backfill ordering** ([#85](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/85)): `indexChangedSessions` now sorts changed files by modification time descending before applying the per-startup cap, so recently crashed sessions are indexed on the next startup instead of waiting behind old historical files.
- **Shutdown metadata sync** ([#85](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/85)): the `session_shutdown` handler now upserts `session_files` metadata after indexing, so stored size/mtime reflects the final on-disk state. Prevents every startup from re-parsing recently-closed sessions whose metadata had gone stale.

### Fixed

- **Failure-memory consolidation** ([#68](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/68)): `failures.md` now participates in both automatic and manual consolidation flows, so full failure memory no longer gets stuck in a persistent overflow state while other core memory targets can recover.

### Changed

- **Skill tool naming** ([#66](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/66)): the procedural-skill management tool is now exposed as `skill_manage` to make its purpose explicit and reduce accidental use as a generic skill-discovery tool.

## [0.7.13] - 2026-05-27

### Fixed

- **Memory store maintenance for issue #52** ([#59](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/59), [#52](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/52)): failure memories now respect configured caps and exact dedupe, `memory remove` can accept the formatted text copied directly from `memory_search` results, and successful memory mutations return concise metadata instead of dumping large entry lists.

### Changed

- Failure-memory writes now use the same guarded add path as other memory targets, so overflow handling and validation stay consistent across stores.
- The SQLite memory mirror now normalizes pasted search-result text the same way as the Markdown source of truth, keeping remove/replace behavior aligned.

## [0.7.12] - 2026-05-27

### Fixed

- **FTS query normalization for `memory_search` and `session_search`** ([#58](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/58)): multi-word natural-language queries now behave like term-wise searches instead of accidental exact-phrase matches, while explicit quoted phrases and valid FTS operators still work.
- **Project memory auto-consolidation** ([#51](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/51)): project-scoped memory writes now follow the same auto-consolidation retry flow as the global store when limits are hit.
- **WAL growth controls on SQLite connections** ([#56](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/56)): SQLite setup now bounds WAL growth with `wal_autocheckpoint`, `journal_size_limit`, and a best-effort checkpoint on close.

### Changed

- Main now includes the merged WAL follow-up from [#56](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/56) together with its underlying runtime change commit (`761400d`) and the later search-fix merge from [#58](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/58).

## [0.7.4] - 2026-05-13

### Added

- **Configurable correction detection patterns**: Strong, weak, and negative correction patterns plus weak-pattern directive words can now be overridden with optional config fields. Omitted fields preserve the existing defaults.

### Tests

- Config loading tests now use an injected temporary config path instead of writing to `~/.pi/agent/hermes-memory-config.json`.

## [0.7.3] - 2026-05-12

### Added

- **Configurable memory policy prompt** ([#26](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/26)): `policy-only` mode now supports `memoryPolicyStyle` (`full`, `compact`, `custom`, or `none`) and `memoryPolicyCustomText`. The default `full` style preserves the existing v0.7 policy prompt behavior.

### Fixed

- **Bun runtime SQLite compatibility** ([#27](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/27), [#25](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/25), [#24](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/24)): Added a runtime fallback from `better-sqlite3` to `bun:sqlite` in `src/store/db.ts` so memory and search features do not crash when loaded in Bun contexts.
- **Safer DB initialization across runtimes** ([#27](https://github.com/efrembaraldo/gsd-pi-hermes-memory/pull/27)): PRAGMA setup now consistently enables `journal_mode=WAL` and `foreign_keys=ON` for each connection, and legacy target-constraint migration handling is hardened to avoid partial schema updates.

## [0.7.2] - 2026-05-11

### Fixed

- **Searchable project-memory backfill**: Startup now runs the same Markdown-to-SQLite sync used by `/memory-sync-markdown` after migrating legacy project folders. This makes memories in `~/.pi/agent/projects-memory/<project>/MEMORY.md` searchable via `memory_search` automatically, including entries copied forward from the old `~/.pi/agent/<project>/MEMORY.md` layout.
- **Project-scoped correction search**: Correction/failure memories captured while a project is active are now synced into SQLite with that project scope, so `memory_search` can retrieve them using the project filter.
- **Explicit project writes**: `target="project"` now routes to the project `MEMORY.md` target explicitly before mirroring the entry into SQLite.

### Tests

- Added coverage proving new-layout project Markdown is indexed into SQLite and returned by `memory_search`.
- Added coverage for project-scoped correction memory sync and explicit project target routing.

## [0.7.1] - 2026-05-11

### Fixed

- **Legacy project memory migration**: Users upgrading from the old `~/.pi/agent/<project>/MEMORY.md` layout now keep their existing project memories. On startup, legacy project memory files are copied or merged into `~/.pi/agent/projects-memory/<project>/MEMORY.md` without deleting the old folders.
- **Markdown backfill compatibility**: `/memory-sync-markdown` now scans both the new `projects-memory/<project>` layout and legacy `~/.pi/agent/<project>` project folders, so existing project memories can still be imported into SQLite search.

### Tests

- Added migration coverage for copy, merge/dedupe, skip behavior, and legacy project backfill.

## [0.7.0] - 2026-05-11

### Added

- **Policy-only memory prompt by default**: The system prompt now appends a compact `<memory-policy>` instead of dumping full Markdown memory, project memory, recent failures, and the skill index into every new session.
- **Legacy injection escape hatch**: Set `memoryMode: "legacy-inject"` to restore the previous full prompt-injection behavior for users who rely on it.
- **Prompt context builder**: Centralized prompt assembly in `buildPromptContext()` with tests for policy-only and legacy modes.
- **Expanded `/memory-preview-context`**: Shows the active policy-only prompt by default, or the full legacy memory/skill blocks when legacy mode is enabled.
- **v0.7 docs and task plan**: Added the token-aware memory policy plan and future retrieval/router phases.

### Changed

- Memory is described and handled as searchable context, not always-on authority.
- The memory policy now accurately reflects current tool behavior:
  - `memory_search` searches durable user, global, project-scoped, and failure memories.
  - `session_search` searches indexed past conversation messages.
  - `skill` supports `list`, `view`, `create`, `patch`, `edit`, and `delete`.
- Category-filter guidance now avoids missing ordinary user/project/global memories; category filters are reserved for categorized failure/lesson memories.
- README, roadmap, in-app learning guide, Mermaid diagrams, and generated SVGs now describe policy-only as the default and `legacy-inject` as opt-in.
- Content scanner warnings now mention search and legacy prompt injection instead of implying all memory is always injected.

### Preserved From Recent PRs

- Project-scoped memory remains under `~/.pi/agent/projects-memory/<project>/`.
- Windows-safe atomic writes still use temp files next to their target files and `fs.rm()` cleanup.
- `reviewRecentMessages` and `flushRecentMessages` remain configurable and independently applied.

### Tests

- 362 automated tests across 23 test files.
- Added policy prompt tests covering default policy-only behavior, legacy prompt assembly, accurate memory tool guidance, and stale wording regressions.

## [0.6.5] - 2026-05-03

### Fixed

- **Background review no longer blocks interactive chat** ([#10](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/10)): The `turn_end` handler now spawns the review subprocess as fire-and-forget instead of `await`-ing it. `reviewInProgress` is reset immediately so the next review cycle can proceed. Notifications are delivered asynchronously via `.then()`.
- **Auto-review errors silenced on Windows** ([#9](https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/9)): The auto-review error notification (`[hermes] auto-review failed (exit=...)`) has been removed. Auto-review is best-effort — subprocess failures (non-zero exits, timeouts, spawn errors) are silently ignored. The next review cycle will retry naturally.

## [0.2.0] - 2026-04-26

### Added

**Procedural Skills (`skill` tool)**
- New `skill` tool with actions: `create`, `view`, `patch`, `edit`, `delete`
- Skills stored as SKILL.md files in `~/.pi/agent/memory/skills/`
- Progressive disclosure — skill index (name + description only) injected into system prompt, full content loaded on demand via `skill view`
- Auto-extraction after complex tasks (8+ tool calls using 2+ distinct tool types in a single turn)
- Rate limited to 1 auto-extraction per session
- All skill writes pass through the same content scanner as memory writes
- New `/memory-skills` command to list all agent-created skills

**Auto-Consolidation**
- When `add()` would exceed the character limit, automatically trigger consolidation instead of returning an error
- Consolidation spawns a one-shot `pi.exec()` process that merges related entries and removes outdated ones
- Parent process reloads from disk after consolidation to stay in sync with changes
- New `/memory-consolidate` command for manual consolidation trigger
- Configurable via `autoConsolidate` setting (default: `true`)

**Correction Detection**
- Detect user corrections in real-time and trigger immediate memory save
- Two-pass pattern filter:
  - **Strong patterns** (always trigger): "don't do that", "I said...", "please don't...", "that's not what I..."
  - **Weak patterns** (need directive clause): "no, use yarn" triggers, "no worries" does not
  - **Negative patterns** (suppress false positives): "no worries", "actually looks great", "no problem", "stop there"
- Rate limited to 1 correction save per 3 turns
- Configurable via `correctionDetection` setting (default: `true`)

**Tool-Call-Aware Nudge**
- Background review now triggers based on tool call count OR turn count, whichever comes first
- Counts `toolCall` blocks from the session branch at `turn_end` time
- Default: triggers at 15 tool calls (configurable via `nudgeToolCalls`)
- Both turn and tool-call counters reset after each review

**Updated Background Review Prompt**
- `COMBINED_REVIEW_PROMPT` now explicitly references the `skill` tool
- Tells the agent to use `create` for new skills and `patch` for updating existing ones
- Single review pass can save both memories and skills

### Changed

- `MemoryStore.add()` is now async (returns `Promise<MemoryResult>`) to support consolidation
- Consolidator injected via `setConsolidator()` to avoid circular imports
- Background review counts tool calls from session branch instead of relying on events

### Configuration

New settings in `~/.pi/agent/hermes-memory-config.json`:

| Setting | Default | Description |
|---|---|---|
| `autoConsolidate` | `true` | Auto-merge when memory hits capacity |
| `correctionDetection` | `true` | Detect user corrections and save immediately |
| `nudgeToolCalls` | `15` | Tool calls before background review triggers |

### Tests

- 218 total tests (up from 119 in v0.1.0)
- 99 new tests covering: auto-consolidation (9), correction detection (35), tool-call nudge (6), skill store (27), skill tool (10), skill auto-trigger (6)

### Files Changed

**New files (7 source + 6 test):**
- `src/store/skill-store.ts` — SkillStore class with CRUD, frontmatter parsing, progressive disclosure
- `src/tools/skill-tool.ts` — `skill` LLM tool registration and execute
- `src/handlers/auto-consolidate.ts` — Consolidation trigger and `/memory-consolidate` command
- `src/handlers/correction-detector.ts` — Two-pass correction detection and immediate save
- `src/handlers/skill-auto-trigger.ts` — Auto-extract skills after complex tasks
- `src/handlers/skills-command.ts` — `/memory-skills` command
- `tests/handlers/auto-consolidate.test.ts`
- `tests/handlers/correction-detector.test.ts`
- `tests/handlers/skill-auto-trigger.test.ts`
- `tests/store/skill-store.test.ts`
- `tests/tools/skill-tool.test.ts`

**Modified files (8):**
- `src/index.ts` — Wire all new handlers, tools, commands, and system prompt injection
- `src/types.ts` — New interfaces (`ConsolidationResult`, `SkillIndex`, `SkillDocument`, `SkillResult`) + config fields
- `src/constants.ts` — New prompts (`CONSOLIDATION_PROMPT`, `CORRECTION_SAVE_PROMPT`, `SKILL_TOOL_DESCRIPTION`), correction patterns, updated `COMBINED_REVIEW_PROMPT`
- `src/config.ts` — Parse new config fields (`autoConsolidate`, `correctionDetection`, `nudgeToolCalls`)
- `src/store/memory-store.ts` — `add()` async, `setConsolidator()` injection, reload-after-consolidation
- `src/tools/memory-tool.ts` — `await store.add()`
- `src/handlers/background-review.ts` — Tool-call counting, OR trigger logic
- `tests/store/memory-store.test.ts` — All `add()` calls migrated to `await`, new config fields in test fixtures

---

## [0.1.0] - 2026-04-20

### Added

- Persistent memory via `MEMORY.md` + `USER.md` with `§` delimiter
- Real-time `memory` tool (add / replace / remove) for the LLM
- Content scanning: prompt injection, role hijacking, secret exfiltration, invisible unicode
- Background learning loop (every N turns via `pi.exec`)
- Session flush before compaction and shutdown
- `/memory-insights` command
- Frozen snapshot injection into system prompt (preserves Pi's prompt cache)
- Atomic writes (temp + rename)
- 119 automated tests, 0 type errors
