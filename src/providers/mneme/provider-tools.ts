/**
 * Provider tool registration.
 *
 * Each Mneme provider owns its tools via `getToolSchemas()` + `handleToolCall()`
 * (the Hermes dispatch idiom). This wraps that so every declared schema becomes
 * one Pi tool whose `execute` dispatches straight back to the provider:
 *
 *   registerTool({ name, label, description, parameters, execute })
 *     -> execute() -> provider.handleToolCall(name, params) -> JSON string
 *
 * The schema in `getToolSchemas()` is registered verbatim; Pi validates the
 * parameters at dispatch time. Providers inject this module; they never call
 * `registerTool` themselves.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryProvider, ToolSchema } from "../holographic/memory-provider.js";

/** Derive a human label for a tool (`fact_store` -> "Fact Store"). */
function labelFromToolName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Register one provider tool with the host. `execute` returns the provider's
 * JSON string as a single text result; the raw JSON is also surfaced as
 * `details` for callers that want structured access.
 */
export function registerProviderTool(
  pi: ExtensionAPI,
  provider: MemoryProvider,
  schema: ToolSchema,
): void {
  if (typeof pi.registerTool !== "function") return;

  pi.registerTool({
    name: schema.name,
    label: labelFromToolName(schema.name),
    description: schema.description,
    promptSnippet: `${schema.name}: ${schema.description}`,
    parameters: schema.parameters,
    async execute(_toolCallId, params, _signal, _onUpdate) {
      // `params` is the schema-validated record; the handlers coerce per-arg.
      const text = provider.handleToolCall(schema.name, params as Record<string, unknown>);
      let details: Record<string, unknown> = {};
      try {
        details = JSON.parse(text);
      } catch {
        // Non-JSON error strings (the provider still returns valid JSON in
        // practice) fall through with an empty details object.
      }
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },
  } as ToolDefinition);
}

/** Register every tool a provider declares via `getToolSchemas()`. */
export function registerProviderTools(pi: ExtensionAPI, provider: MemoryProvider): void {
  for (const schema of provider.getToolSchemas()) {
    registerProviderTool(pi, provider, schema);
  }
}
