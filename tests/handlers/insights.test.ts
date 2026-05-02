import { describe, it } from "node:test";
import assert from "node:assert";
import { registerInsightsCommand } from "../../src/handlers/insights.js";

/**
 * Create a mock store with given memory and user entries,
 * then register the insights command and return the handler
 * plus the captured notify calls.
 */
async function setupCommand(
  memoryEntries: string[],
  userEntries: string[],
): Promise<{
  handler: Function;
  notifyCalls: { message: string; severity: string }[];
}> {
  const notifyCalls: { message: string; severity: string }[] = [];

  const mockStore = {
    getMemoryEntries: () => [...memoryEntries],
    getUserEntries: () => [...userEntries],
  };

  const commands: { name: string; handler: Function }[] = [];
  const mockPi = {
    registerCommand: (name: string, opts: any) => {
      commands.push({ name, handler: opts.handler });
    },
  };

  registerInsightsCommand(mockPi as any, mockStore as any, null, "test-project");

  assert.ok(commands.length === 1, "Expected exactly one registered command");
  return { handler: commands[0].handler, notifyCalls };
}

/** Invoke the handler with a fake context that captures notify calls. */
async function invoke(
  handler: Function,
  notifyCalls: { message: string; severity: string }[],
): Promise<string> {
  await handler({}, {
    ui: {
      notify: (message: string, severity: string) => {
        notifyCalls.push({ message, severity });
      },
    },
  });
  assert.ok(notifyCalls.length === 1, "Expected exactly one notify call");
  return notifyCalls[0].message;
}

describe("registerInsightsCommand", () => {
  it("command is registered", async () => {
    const { handler } = await setupCommand([], []);
    assert.ok(typeof handler === "function");
  });

  it("shows MEMORY section with numbered entries", async () => {
    const { handler, notifyCalls } = await setupCommand(
      ["first entry", "second entry"],
      [],
    );
    const output = await invoke(handler, notifyCalls);

    assert.match(output, /1\.\s/);
    assert.match(output, /2\.\s/);
    assert.ok(output.includes("first entry"));
    assert.ok(output.includes("second entry"));
  });

  it("shows USER PROFILE section", async () => {
    const { handler, notifyCalls } = await setupCommand([], ["user fact"]);
    const output = await invoke(handler, notifyCalls);

    assert.ok(output.includes("USER PROFILE"));
    assert.ok(output.includes("user fact"));
  });

  it('shows "(empty)" when no entries exist', async () => {
    const { handler, notifyCalls } = await setupCommand([], []);
    const output = await invoke(handler, notifyCalls);

    const emptyMatches = output.match(/\(empty\)/g);
    assert.ok(
      emptyMatches && emptyMatches.length === 2,
      "Expected (empty) in both MEMORY and USER sections",
    );
  });

  it("entries truncated to 100 chars", async () => {
    const longEntry = "x".repeat(200);
    const { handler, notifyCalls } = await setupCommand([longEntry], []);
    const output = await invoke(handler, notifyCalls);

    // Should contain first 100 chars + "..."
    assert.ok(output.includes("x".repeat(100) + "..."));
    // Should NOT contain the full 200-char entry
    assert.ok(!output.includes("x".repeat(200)));
  });

  it("box drawing characters in output", async () => {
    const { handler, notifyCalls } = await setupCommand([], []);
    const output = await invoke(handler, notifyCalls);

    assert.ok(output.includes("╔"));
    assert.ok(output.includes("═"));
    assert.ok(output.includes("║"));
    assert.ok(output.includes("╗"));
    assert.ok(output.includes("╚"));
    assert.ok(output.includes("╝"));
  });

  it("notification called with info severity", async () => {
    const { handler, notifyCalls } = await setupCommand([], []);
    await invoke(handler, notifyCalls);

    assert.strictEqual(notifyCalls[0].severity, "info");
  });

  it("multiple entries displayed correctly", async () => {
    const mem = ["mem1", "mem2", "mem3"];
    const usr = ["usr1", "usr2"];
    const { handler, notifyCalls } = await setupCommand(mem, usr);
    const output = await invoke(handler, notifyCalls);

    for (const m of mem) {
      assert.ok(output.includes(m), `Missing memory entry: ${m}`);
    }
    for (const u of usr) {
      assert.ok(output.includes(u), `Missing user entry: ${u}`);
    }
  });

  it("entry numbering is sequential", async () => {
    const { handler, notifyCalls } = await setupCommand(
      ["alpha", "beta", "gamma"],
      [],
    );
    const output = await invoke(handler, notifyCalls);

    assert.match(output, /1\.\s*alpha/);
    assert.match(output, /2\.\s*beta/);
    assert.match(output, /3\.\s*gamma/);
  });

  it("unicode content renders correctly", async () => {
    const entries = ["user loves 🍕 pizza", "works on 🚀 rockets"];
    const { handler, notifyCalls } = await setupCommand([], entries);
    const output = await invoke(handler, notifyCalls);

    assert.ok(output.includes("🍕"));
    assert.ok(output.includes("🚀"));
    assert.ok(output.includes("pizza"));
    assert.ok(output.includes("rockets"));
  });
});
