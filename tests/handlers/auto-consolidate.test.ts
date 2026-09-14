/**
 * Unit tests for auto-consolidation — triggerConsolidation and /memory-consolidate command.
 */

import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { registerConsolidateCommand, triggerConsolidation } from "../../src/handlers/auto-consolidate.js";
import { resolveWatchedChildPiInvocation } from "../../src/handlers/pi-child-process.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { AtomicLockCoordinator } from "../../src/store/atomic-lock-coordinator.js";
import { DEFAULT_CONSOLIDATION_TIMEOUT_MS, ENTRY_DELIMITER } from "../../src/constants.js";

// PLACEHOLDER_PARTIAL_WILL_REPLACE
