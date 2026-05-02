# v0.3.0: Interview + Hardening — ✅ COMPLETE

Published as pi-hermes-memory@0.3.0 on npm.

## Epic 1: /memory-interview ✅
- [x] Add INTERVIEW_PROMPT to constants.ts
- [x] Create src/handlers/interview.ts
- [x] Wire in index.ts
- [x] Write tests (6 tests)

## Epic 2: Context Fencing ✅
- [x] Update memory-store.ts renderBlock/renderProjectBlock + fenceBlock helper
- [x] Update skill-store.ts formatIndexForSystemPrompt
- [x] Update tests

## Epic 3: Memory Aging ✅
- [x] Add encodeEntry/decodeEntry/stripMetadata helpers
- [x] Update add(), replace() — encode/decode metadata, preserve created date
- [x] Update formatForSystemPrompt() — strip metadata from display
- [x] Update CONSOLIDATION_PROMPT with age-based staleness guidance
- [x] Update tests

## Epic 4: Project Memory Polish ✅
- [x] Extract project detection into src/project.ts
- [x] Add /memory-switch-project command
- [x] Refactor index.ts to use detectProject()

## Epic 5: Release ✅
- [x] Update README — two-tier architecture section, new commands
- [x] Bump version to 0.3.0
- [x] npm run check passes, key tests pass (122 tests)
- [x] Published to npm
