# v0.3.0: Interview + Hardening

Implement the 5 epics from docs/0.3/PLAN.md in order:

## Epic 1: /memory-interview
- [ ] Add INTERVIEW_PROMPT to constants.ts
- [ ] Create src/handlers/interview.ts
- [ ] Wire in index.ts
- [ ] Write tests

## Epic 2: Context Fencing
- [ ] Update memory-store.ts renderBlock/renderProjectBlock
- [ ] Update skill-store.ts formatIndexForSystemPrompt
- [ ] Update tests

## Epic 3: Memory Aging
- [ ] Add encodeEntry/decodeEntry helpers
- [ ] Update add(), replace(), readFile(), formatForSystemPrompt()
- [ ] Update CONSOLIDATION_PROMPT
- [ ] Update tests

## Epic 4: Project Memory Polish
- [ ] Polish /memory-insights project section
- [ ] Add /memory-switch-project command
- [ ] Extract project detection helper
- [ ] Update tests and docs

## Epic 5: Release
- [ ] Update README, ROADMAP
- [ ] Bump version, npm run check, npm test
- [ ] Tag and publish
