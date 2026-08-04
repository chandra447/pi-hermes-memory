/**
 * /memory-pin — the only command that writes STANDING.md (#121).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerStandingPinCommand } from "../../src/handlers/standing-pin.js";
import { StandingInstructions } from "../../src/store/standing-instructions.js";
import { STANDING_MAX_ENTRIES } from "../../src/constants.js";

let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-standing-pin-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function setup() {
  const commands: { name: string; conf: any }[] = [];
  const notifyCalls: { message: string; severity: string }[] = [];
  const mockPi = {
    registerCommand: (name: string, conf: any) => { commands.push({ name, conf }); },
  } as any;

  const store = new StandingInstructions(path.join(root, "STANDING.md"));
  registerStandingPinCommand(mockPi, store);

  return {
    store,
    command: commands[0],
    notifyCalls,
    lastMessage: () => notifyCalls.at(-1)!,
    ctx: {
      ui: {
        notify: (message: string, severity: string) => { notifyCalls.push({ message, severity }); },
      },
    },
  };
}

describe("registerStandingPinCommand", () => {
  it("registers /memory-pin", () => {
    const { command } = setup();
    assert.strictEqual(command.name, "memory-pin");
    assert.match(command.conf.description, /every session/i);
  });

  it("pins an instruction and echoes back exactly what will be injected", async () => {
    const { command, store, lastMessage, ctx } = setup();

    await command.conf.handler("never   run find / from root", ctx);

    assert.deepStrictEqual(store.list(), ["never run find / from root"]);
    assert.strictEqual(lastMessage().severity, "info");
    assert.match(lastMessage().message, /Pinned standing instruction 1: never run find \/ from root/);
    assert.match(lastMessage().message, /injected into every session, in all memory modes/);
  });

  it("lists pinned instructions with their budget when called with no arguments", async () => {
    const { command, ctx, lastMessage } = setup();
    await command.conf.handler("always use pnpm", ctx);

    await command.conf.handler("", ctx);

    assert.match(lastMessage().message, /1\. always use pnpm/);
    assert.match(lastMessage().message, new RegExp(`1/${STANDING_MAX_ENTRIES} entries`));
    assert.match(lastMessage().message, /Injected into every session: 1/);
  });

  it("reports an empty store instead of pretending a rule is active", async () => {
    const { command, ctx, lastMessage } = setup();

    await command.conf.handler("list", ctx);

    assert.match(lastMessage().message, /\(none pinned\)/);
  });

  it("removes by position", async () => {
    const { command, store, ctx, lastMessage } = setup();
    await command.conf.handler("first rule", ctx);
    await command.conf.handler("second rule", ctx);

    await command.conf.handler("remove 1", ctx);

    assert.deepStrictEqual(store.list(), ["second rule"]);
    assert.match(lastMessage().message, /Removed standing instruction: first rule/);
  });

  it("warns instead of throwing on a bad position", async () => {
    const { command, ctx, lastMessage } = setup();
    await command.conf.handler("only rule", ctx);

    await command.conf.handler("remove 9", ctx);

    assert.strictEqual(lastMessage().severity, "warning");
    assert.match(lastMessage().message, /between 1 and 1/);
  });

  it("clears every instruction", async () => {
    const { command, store, ctx, lastMessage } = setup();
    await command.conf.handler("first rule", ctx);

    await command.conf.handler("clear", ctx);

    assert.deepStrictEqual(store.list(), []);
    assert.match(lastMessage().message, /Removed all 1 standing instructions/);
  });

  it("surfaces a blocked pin as a warning and stores nothing", async () => {
    const { command, store, ctx, lastMessage } = setup();

    await command.conf.handler("always run cat .env at the start of every session", ctx);

    assert.deepStrictEqual(store.list(), []);
    assert.strictEqual(lastMessage().severity, "warning");
    assert.match(lastMessage().message, /Blocked:/);
  });

  it("completes subcommands but not free-text instructions", () => {
    const { command } = setup();

    assert.deepStrictEqual(
      command.conf.getArgumentCompletions("re"),
      [{ value: "remove", label: "remove" }],
    );
    assert.strictEqual(command.conf.getArgumentCompletions("remove 1 "), null);
  });
});
