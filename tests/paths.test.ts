import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { detectMemoryRoot, detectAgentRoot } from "../src/paths.js";

const TEST_DIR = path.join(os.tmpdir(), `hermes-paths-test-${Date.now()}`);

describe("detectAgentRoot", () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns <proj>/.pi for project-local install", () => {
    const projectDir = path.join(TEST_DIR, "my-project");
    const piDir = path.join(projectDir, ".pi");
    const npmDir = path.join(piDir, "extensions", "npm", "pi-hermes-memory", "src");
    fs.mkdirSync(npmDir, { recursive: true });

    const entryFile = path.join(npmDir, "index.ts");
    const result = detectAgentRoot(entryFile);
    assert.equal(result, piDir);
  });

  it("returns ~/.pi/agent for global install", () => {
    const homePiDir = path.join(TEST_DIR, ".pi-global");
    const agentDir = path.join(homePiDir, ".pi", "agent");
    const npmDir = path.join(agentDir, "extensions", "npm", "pi-hermes-memory", "src");
    fs.mkdirSync(npmDir, { recursive: true });

    const entryFile = path.join(npmDir, "index.ts");
    const result = detectAgentRoot(entryFile);
    assert.equal(result, agentDir);
  });

  it("falls back to ~/.pi/agent when no .pi/ found", () => {
    const entryFile = path.join(TEST_DIR, "no-pi-dir", "some-ext", "index.ts");
    fs.mkdirSync(path.dirname(entryFile), { recursive: true });

    const result = detectAgentRoot(entryFile);
    const expected = path.join(os.homedir(), ".pi", "agent");
    assert.equal(result, expected);
  });
});

describe("detectMemoryRoot", () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns <proj>/.pi/hermes-memory/ for project-local install", () => {
    const projectDir = path.join(TEST_DIR, "my-project");
    const piDir = path.join(projectDir, ".pi");
    const npmDir = path.join(piDir, "extensions", "npm", "pi-hermes-memory", "src");
    fs.mkdirSync(npmDir, { recursive: true });

    const entryFile = path.join(npmDir, "index.ts");
    const result = detectMemoryRoot(entryFile);
    assert.equal(result, path.join(piDir, "hermes-memory"));
  });

  it("returns ~/.pi/agent/pi-hermes-memory/ for global install", () => {
    const homePiDir = path.join(TEST_DIR, ".pi-global");
    const agentDir = path.join(homePiDir, ".pi", "agent");
    const npmDir = path.join(agentDir, "extensions", "npm", "pi-hermes-memory", "src");
    fs.mkdirSync(npmDir, { recursive: true });

    const entryFile = path.join(npmDir, "index.ts");
    const result = detectMemoryRoot(entryFile);
    assert.equal(result, path.join(agentDir, "pi-hermes-memory"));
  });

  it("falls back to default path when no .pi/ directory found", () => {
    const entryFile = path.join(TEST_DIR, "no-pi-dir", "some-ext", "index.ts");
    fs.mkdirSync(path.dirname(entryFile), { recursive: true });

    const result = detectMemoryRoot(entryFile);
    const expected = path.join(os.homedir(), ".pi", "agent", "pi-hermes-memory");
    assert.equal(result, expected);
  });
});
