#!/usr/bin/env node
/**
 * Guard for check/test npm scripts.
 *
 * The published tarball intentionally omits tests/ and TypeScript (devDependency).
 * When those scripts are run from an installed package (e.g. after `gsd install`),
 * fail with a clear message instead of `tsc: not found` / `tests/run-all.sh: not found`.
 *
 * @see https://github.com/efrembaraldo/gsd-pi-hermes-memory/issues/108
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const REPO = "https://github.com/efrembaraldo/gsd-pi-hermes-memory";

function fail(message) {
	console.error(`\n[gsd-pi-hermes-memory] ${message}`);
	console.error("");
	console.error("These scripts only work from a full source checkout:");
	console.error(`  git clone ${REPO}.git`);
	console.error("  cd gsd-pi-hermes-memory && npm install");
	console.error("  npm run check   # or: npm test");
	console.error("");
	console.error(
		"The published package is for runtime use via Pi; CI validates check/test before publish.",
	);
	console.error("");
	process.exit(1);
}

if (mode === "check") {
	const require = createRequire(join(root, "package.json"));
	try {
		require.resolve("typescript/package.json");
	} catch {
		fail(
			"`npm run check` requires TypeScript (a devDependency). The published npm package does not include it.",
		);
	}
	if (!existsSync(join(root, "tsconfig.json"))) {
		fail(
			"`npm run check` requires tsconfig.json. The published npm package does not include it.",
		);
	}
} else if (mode === "test") {
	if (!existsSync(join(root, "tests", "run-all.sh"))) {
		fail(
			"`npm test` requires the tests/ directory. The published npm package intentionally omits it.",
		);
	}
} else {
	fail(`Unknown mode "${mode ?? ""}". Expected "check" or "test".`);
}
