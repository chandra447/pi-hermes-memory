import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectLlmMessageParts } from "../../src/handlers/message-parts.js";

describe("collectLlmMessageParts", () => {
  it("preserves summaries longer than the legacy 500-char default", () => {
    const longText = "x".repeat(700);
    const parts = collectLlmMessageParts([
      {
        role: "assistant",
        content: [{ type: "text", text: longText }],
      },
    ]);
    assert.strictEqual(parts.length, 1);
    assert.ok(
      parts[0].includes("x".repeat(700)),
      "full 700-char summary must survive without truncation",
    );
    assert.match(parts[0], /^\[ASSISTANT\]: x+$/);
  });

  it("formats user/assistant/tool parts with role prefixes", () => {
    const parts = collectLlmMessageParts([
      { role: "user", content: [{ type: "text", text: "user msg" }] },
      { role: "assistant", content: [{ type: "text", text: "assistant msg" }] },
      { role: "toolResult", content: [{ type: "text", text: "tool msg" }] },
    ]);
    assert.deepStrictEqual(parts, [
      "[USER]: user msg",
      "[ASSISTANT]: assistant msg",
      "[TOOL]: tool msg",
    ]);
  });
});
