import { describe, it } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, DEFAULT_CONFIG_PATH } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig();
    assert.strictEqual(config.memoryCharLimit, 5000);
    assert.strictEqual(config.userCharLimit, 5000);
    assert.strictEqual(config.nudgeInterval, 10);
    assert.strictEqual(config.reviewEnabled, true);
    assert.strictEqual(config.flushOnCompact, true);
    assert.strictEqual(config.flushOnShutdown, true);
    assert.strictEqual(config.flushMinTurns, 6);
    assert.strictEqual(config.failureInjectionEnabled, true);
    assert.strictEqual(config.failureInjectionMaxAgeDays, 7);
    assert.strictEqual(config.failureInjectionMaxEntries, 5);
  });

  it("overrides defaults when config file exists", () => {
    // Write a config file
    fs.mkdirSync(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify({
      memoryCharLimit: 3000,
      nudgeInterval: 15,
      failureInjectionEnabled: false,
      failureInjectionMaxAgeDays: 30,
      failureInjectionMaxEntries: 2,
    }));
    const config = loadConfig();
    assert.strictEqual(config.memoryCharLimit, 3000);
    assert.strictEqual(config.nudgeInterval, 15);
    assert.strictEqual(config.failureInjectionEnabled, false);
    assert.strictEqual(config.failureInjectionMaxAgeDays, 30);
    assert.strictEqual(config.failureInjectionMaxEntries, 2);
    // Unset values use defaults
    assert.strictEqual(config.userCharLimit, 5000);
    assert.strictEqual(config.reviewEnabled, true);
    // Clean up
    fs.rmSync(DEFAULT_CONFIG_PATH);
  });

  it("handles partial config (missing keys use defaults)", () => {
    fs.mkdirSync(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify({ reviewEnabled: false }));
    const config = loadConfig();
    assert.strictEqual(config.reviewEnabled, false);
    assert.strictEqual(config.memoryCharLimit, 5000); // default
    assert.strictEqual(config.failureInjectionEnabled, true);
    assert.strictEqual(config.failureInjectionMaxAgeDays, 7);
    assert.strictEqual(config.failureInjectionMaxEntries, 5);
    fs.rmSync(DEFAULT_CONFIG_PATH);
  });

  it("handles partial config with all boolean overrides", () => {
    fs.mkdirSync(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify({
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 20,
    }));
    const config = loadConfig();
    assert.strictEqual(config.reviewEnabled, false);
    assert.strictEqual(config.flushOnCompact, false);
    assert.strictEqual(config.flushOnShutdown, false);
    assert.strictEqual(config.flushMinTurns, 20);
    assert.strictEqual(config.memoryCharLimit, 5000);
    assert.strictEqual(config.userCharLimit, 5000);
    assert.strictEqual(config.nudgeInterval, 10);
    fs.rmSync(DEFAULT_CONFIG_PATH);
  });

  it("handles empty file gracefully (falls back to defaults)", () => {
    fs.mkdirSync(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(DEFAULT_CONFIG_PATH, "");
    const config = loadConfig();
    assert.strictEqual(config.reviewEnabled, true);
    fs.rmSync(DEFAULT_CONFIG_PATH);
  });

  it("handles malformed JSON (falls back to defaults)", () => {
    fs.mkdirSync(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(DEFAULT_CONFIG_PATH, "{ bad json }");
    const config = loadConfig();
    assert.strictEqual(config.memoryCharLimit, 5000);
    assert.strictEqual(config.reviewEnabled, true);
    fs.rmSync(DEFAULT_CONFIG_PATH);
  });

  it("ignores unknown keys in config file", () => {
    fs.mkdirSync(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify({
      unknownKey: "value",
      anotherKey: 123,
      memoryCharLimit: 1000,
    }));
    const config = loadConfig();
    assert.strictEqual(config.memoryCharLimit, 1000);
    assert.strictEqual(config.reviewEnabled, true);
    fs.rmSync(DEFAULT_CONFIG_PATH);
  });
});
