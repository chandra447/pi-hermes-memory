import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "../src/config.js";

const TEST_CONFIG_PATH = path.join(os.tmpdir(), `hermes-memory-config-test-${process.pid}.json`);

afterEach(() => {
  fs.rmSync(TEST_CONFIG_PATH, { force: true });
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryMode, "policy-only");
    assert.strictEqual(config.memoryPolicyStyle, "full");
    assert.strictEqual(config.memoryPolicyCustomText, undefined);
    assert.strictEqual(config.memoryCharLimit, 5000);
    assert.strictEqual(config.userCharLimit, 5000);
    assert.strictEqual(config.nudgeInterval, 10);
    assert.strictEqual(config.reviewRecentMessages, 0);
    assert.strictEqual(config.reviewEnabled, true);
    assert.strictEqual(config.flushOnCompact, true);
    assert.strictEqual(config.flushOnShutdown, true);
    assert.strictEqual(config.flushMinTurns, 6);
    assert.strictEqual(config.flushRecentMessages, 0);
    assert.strictEqual(config.failureInjectionEnabled, true);
    assert.strictEqual(config.failureInjectionMaxAgeDays, 7);
    assert.strictEqual(config.failureInjectionMaxEntries, 5);
    assert.strictEqual(config.projectsMemoryDir, "projects-memory");
  });

  it("overrides defaults when config file exists", () => {
    // Write a config file
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryCharLimit: 3000,
      memoryMode: "legacy-inject",
      memoryPolicyStyle: "custom",
      memoryPolicyCustomText: "<memory-policy>Custom</memory-policy>",
      nudgeInterval: 15,
      reviewRecentMessages: 25,
      flushRecentMessages: 40,
      failureInjectionEnabled: false,
      failureInjectionMaxAgeDays: 30,
      failureInjectionMaxEntries: 2,
      projectsMemoryDir: "my-memory",
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryMode, "legacy-inject");
    assert.strictEqual(config.memoryPolicyStyle, "custom");
    assert.strictEqual(config.memoryPolicyCustomText, "<memory-policy>Custom</memory-policy>");
    assert.strictEqual(config.memoryCharLimit, 3000);
    assert.strictEqual(config.nudgeInterval, 15);
    assert.strictEqual(config.reviewRecentMessages, 25);
    assert.strictEqual(config.flushRecentMessages, 40);
    assert.strictEqual(config.failureInjectionEnabled, false);
    assert.strictEqual(config.failureInjectionMaxAgeDays, 30);
    assert.strictEqual(config.failureInjectionMaxEntries, 2);
    assert.strictEqual(config.projectsMemoryDir, "my-memory");
    // Unset values use defaults
    assert.strictEqual(config.userCharLimit, 5000);
    assert.strictEqual(config.reviewEnabled, true);
  });

  it("handles partial config (missing keys use defaults)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ reviewEnabled: false }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.reviewEnabled, false);
    assert.strictEqual(config.memoryMode, "policy-only");
    assert.strictEqual(config.memoryPolicyStyle, "full");
    assert.strictEqual(config.memoryCharLimit, 5000); // default
    assert.strictEqual(config.reviewRecentMessages, 0);
    assert.strictEqual(config.flushRecentMessages, 0);
    assert.strictEqual(config.failureInjectionEnabled, true);
    assert.strictEqual(config.failureInjectionMaxAgeDays, 7);
    assert.strictEqual(config.failureInjectionMaxEntries, 5);
    assert.strictEqual(config.projectsMemoryDir, "projects-memory");
  });

  it("handles partial config with all boolean overrides", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 20,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.reviewEnabled, false);
    assert.strictEqual(config.flushOnCompact, false);
    assert.strictEqual(config.flushOnShutdown, false);
    assert.strictEqual(config.flushMinTurns, 20);
    assert.strictEqual(config.memoryCharLimit, 5000);
    assert.strictEqual(config.userCharLimit, 5000);
    assert.strictEqual(config.nudgeInterval, 10);
  });

  it("accepts review and flush recent-message limits independently", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      reviewRecentMessages: 12,
      flushRecentMessages: 34,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.reviewRecentMessages, 12);
    assert.strictEqual(config.flushRecentMessages, 34);
  });

  it("ignores invalid recent-message limits", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      reviewRecentMessages: -1,
      flushRecentMessages: "5",
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.reviewRecentMessages, 0);
    assert.strictEqual(config.flushRecentMessages, 0);
  });

  it("handles empty file gracefully (falls back to defaults)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, "");
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.reviewEnabled, true);
  });

  it("handles malformed JSON (falls back to defaults)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, "{ bad json }");
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryCharLimit, 5000);
    assert.strictEqual(config.reviewEnabled, true);
  });

  it("ignores unknown keys in config file", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      unknownKey: "value",
      anotherKey: 123,
      memoryCharLimit: 1000,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryCharLimit, 1000);
    assert.strictEqual(config.memoryMode, "policy-only");
    assert.strictEqual(config.reviewEnabled, true);
  });

  it("ignores invalid memoryMode values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryMode: "invalid",
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryMode, "policy-only");
  });

  it("accepts valid memoryPolicyStyle values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });

    for (const style of ["full", "compact", "custom", "none"] as const) {
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ memoryPolicyStyle: style }));
      const config = loadConfig(TEST_CONFIG_PATH);
      assert.strictEqual(config.memoryPolicyStyle, style);
    }
  });

  it("ignores invalid memoryPolicyStyle values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryPolicyStyle: "invalid",
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryPolicyStyle, "full");
  });

  it("accepts string memoryPolicyCustomText and ignores non-string values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryPolicyCustomText: "custom policy",
    }));
    let config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryPolicyCustomText, "custom policy");

    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      memoryPolicyCustomText: 123,
    }));
    config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.memoryPolicyCustomText, undefined);
  });

  it("accepts correction pattern string arrays including empty arrays", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      correctionStrongPatterns: ["^custom strong"],
      correctionWeakPatterns: [],
      correctionNegativePatterns: ["^custom negative"],
      correctionDirectiveWords: ["shipit"],
    }));

    const config = loadConfig(TEST_CONFIG_PATH);
    assert.deepStrictEqual(config.correctionStrongPatterns, ["^custom strong"]);
    assert.deepStrictEqual(config.correctionWeakPatterns, []);
    assert.deepStrictEqual(config.correctionNegativePatterns, ["^custom negative"]);
    assert.deepStrictEqual(config.correctionDirectiveWords, ["shipit"]);
  });

  it("ignores invalid correction pattern array values", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      correctionStrongPatterns: "^custom strong",
      correctionWeakPatterns: ["^custom weak", 123],
      correctionNegativePatterns: [false],
      correctionDirectiveWords: { word: "shipit" },
    }));

    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.correctionStrongPatterns, undefined);
    assert.strictEqual(config.correctionWeakPatterns, undefined);
    assert.strictEqual(config.correctionNegativePatterns, undefined);
    assert.strictEqual(config.correctionDirectiveWords, undefined);
  });
});
