#!/usr/bin/env node
/**
 * Setup `@gsd/pi-*` into ./vendor/@gsd/.
 *
 * The extension's source code imports from `@gsd/pi-coding-agent`,
 * `@gsd/pi-ai`, `@gsd/pi-tui`, and (historically) `@gsd/pi-agent-core`. These
 * packages are workspace packages inside the gsd-pi monorepo, NOT published
 * as standalone npm packages, so `npm install` cannot fetch them.
 *
 * At runtime Pi/GSD provides them through its own monorepo resolver. For the
 * type-check (and for `tsx` to run the test suite) we need both types AND
 * runtime artifacts (`@gsd/pi-ai` exposes `StringEnum`, `@gsd/pi-tui` exposes
 * TUI components — both are runtime imports in this project). This script
 * copies the full built `dist/` and the `package.json` from a built gsd-pi
 * checkout into `./vendor/@gsd/` so resolution works without network access.
 *
 * Idempotent: exits 0 if all four vendor copies are already present.
 *
 * Resolution priority:
 *   1. GSD_PI_CHECKOUT env var (explicit override; CI uses /tmp/gsd-pi)
 *   2. /home/opengsd/repos/open-gsd_gsd-pi (canonical local dev path)
 *   3. /tmp/gsd-pi (CI default)
 *
 * Pattern modeled on gsd-pi-discussion-arena/scripts/setup-types.mjs.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	unlinkSync,
	copyFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const VENDOR = join(ROOT, "vendor", "@gsd");
const NODE_MODULES = join(ROOT, "node_modules");
const NODE_MODULES_GSD = join(NODE_MODULES, "@gsd");

const PACKAGES = [
	// Direct imports from this extension's source code
	"pi-coding-agent", // type-only
	"pi-ai", // runtime (StringEnum + completeSimple via /compat)
	"pi-tui", // runtime (Input, Key, fuzzyFilter, matchesKey, etc.)
	"pi-agent-core", // legacy import (kept for compatibility, currently unused)
	// Transitive runtime dependencies required by the packages above when
	// running outside the gsd-pi monorepo (e.g. via `tsx --test`)
	"native",
	"gsd-agent-core", // source directory is `gsd-agent-core`, package name is `@gsd/agent-core`
];

function allVendorReady() {
	return PACKAGES.every((name) =>
		existsSync(join(VENDOR, name, "dist", "index.js"))
		&& existsSync(join(VENDOR, name, "package.json")),
	);
}

function allSymlinksReady() {
	return PACKAGES.every((name) => {
		const linkPath = join(NODE_MODULES_GSD, name);
		if (!existsSync(linkPath)) return false;
		try {
			return lstatSync(linkPath).isSymbolicLink()
				&& readlinkSync(linkPath) === join("..", "..", "vendor", "@gsd", name);
		} catch {
			return false;
		}
	});
}

if (allVendorReady() && allSymlinksReady()) {
	console.log("[setup-types] vendor/@gsd/* + node_modules/@gsd/* already ready, skipping");
	process.exit(0);
}

const candidates = [
	process.env.GSD_PI_CHECKOUT,
	"/home/opengsd/repos/open-gsd_gsd-pi",
	"/tmp/gsd-pi",
];

let sourceRoot = null;
for (const candidate of candidates) {
	if (!candidate) continue;
	if (existsSync(join(candidate, "packages", "pi-coding-agent", "dist", "index.js"))) {
		sourceRoot = candidate;
		break;
	}
}

if (!sourceRoot) {
	console.error(
		"[setup-types] FAIL: no built gsd-pi checkout found with packages/pi-coding-agent/dist/index.js",
	);
	console.error("");
	console.error("  Tried:");
	for (const c of candidates.filter(Boolean)) {
		console.error(`    - ${c}/packages/pi-coding-agent/dist/index.js`);
	}
	console.error("");
	console.error("  Fix:");
	console.error(
		"  - Set GSD_PI_CHECKOUT=<path> to a gsd-pi checkout with packages/pi-{coding-agent,ai,tui,agent-core}/dist/",
	);
	console.error(
		"  - OR build it: cd <gsd-pi-checkout> && pnpm install && pnpm --filter @gsd/pi-coding-agent --filter @gsd/pi-ai --filter @gsd/pi-tui --filter @gsd/pi-agent-core build",
	);
	console.error(
		"  - OR clone+build: git clone https://github.com/open-gsd/gsd-pi.git /tmp/gsd-pi && cd /tmp/gsd-pi && pnpm install && pnpm --filter @gsd/pi-coding-agent --filter @gsd/pi-ai --filter @gsd/pi-tui --filter @gsd/pi-agent-core build",
	);
	process.exit(1);
}

function copyTree(srcDir, dstDir) {
	for (const entry of readdirSync(srcDir)) {
		const srcPath = join(srcDir, entry);
		const dstPath = join(dstDir, entry);
		const stat = statSync(srcPath);
		if (stat.isDirectory()) {
			mkdirSync(dstPath, { recursive: true });
			copyTree(srcPath, dstPath);
		} else {
			copyFileSync(srcPath, dstPath);
		}
	}
}

let copied = 0;
for (const name of PACKAGES) {
	const sourcePkg = join(sourceRoot, "packages", name);
	const sourceDist = join(sourcePkg, "dist");
	const targetPkg = join(VENDOR, name);
	if (!existsSync(sourceDist)) {
		console.warn(`[setup-types] missing ${sourceDist}; skipping ${name}`);
		continue;
	}
	mkdirSync(targetPkg, { recursive: true });
	copyFileSync(join(sourcePkg, "package.json"), join(targetPkg, "package.json"));
	copyTree(sourceDist, join(targetPkg, "dist"));
	copied += 1;
}

// Patch @gsd/pi-ai's vendored package.json to expose the legacy `./compat`
// subpath. Older API versions exported it; the current 1.12 has consolidated
// everything into the main export — `./dist/stream.js` still exports
// `completeSimple`, `streamSimple`, etc. This extension still uses the
// legacy alias, so re-add it here.
const piAiPkgPath = join(VENDOR, "pi-ai", "package.json");
if (existsSync(piAiPkgPath)) {
	try {
		const piAiPkg = JSON.parse(readFileSync(piAiPkgPath, "utf-8"));
		if (!piAiPkg.exports) piAiPkg.exports = {};
		if (!piAiPkg.exports["./compat"]) {
			piAiPkg.exports["./compat"] = {
				types: "./dist/stream.d.ts",
				import: "./dist/stream.js",
			};
			writeFileSync(piAiPkgPath, JSON.stringify(piAiPkg, null, "\t") + "\n");
		}
	} catch (err) {
		console.warn(`[setup-types] could not patch ${piAiPkgPath}: ${err.message}`);
	}
}

// Phase 2: create node_modules/@gsd/<pkg> symlinks pointing at vendor/@gsd/<pkg>.
// Node's resolver looks in node_modules/<scope>/<name>, so a symlink there is
// the only way to make `@gsd/pi-ai` (a runtime import of `StringEnum`) and
// `@gsd/pi-tui` (runtime TUI components) resolvable when running outside the
// gsd-pi monorepo — e.g. via `tsx --test`. Inside the monorepo, gsd-pi itself
// provides these modules and the symlinks are not consulted.
let linked = 0;
if (existsSync(NODE_MODULES)) {
	mkdirSync(NODE_MODULES_GSD, { recursive: true });
	for (const name of PACKAGES) {
		const linkPath = join(NODE_MODULES_GSD, name);
		const target = join("..", "..", "vendor", "@gsd", name);
		if (existsSync(join(VENDOR, name))) {
			try {
				if (existsSync(linkPath)) {
					try { unlinkSync(linkPath); } catch {}
				}
				symlinkSync(target, linkPath, "dir");
				linked += 1;
			} catch (err) {
				console.warn(`[setup-types] failed to link ${linkPath}: ${err.message}`);
			}
		}
	}
} else {
	console.warn(`[setup-types] ${NODE_MODULES} missing; skipping symlink phase`);
}

console.log(
	`[setup-types] done (${copied}/${PACKAGES.length} vendor copies, ${linked}/${PACKAGES.length} symlinks, from ${sourceRoot})`,
);