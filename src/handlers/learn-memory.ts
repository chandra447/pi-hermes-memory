/**
 * Learn memory tool command — /learn-memory-tool teaches users about the memory system.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export function registerLearnMemoryCommand(pi: ExtensionAPI): void {
  pi.registerCommand("learn-memory-tool", {
    description: "Learn how to use the pi-hermes-memory extension effectively",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      // Show main menu first
      const section = await ctx.ui.select("Pi Hermes Memory Guide", [
        "📦 What Gets Saved",
        "🔧 Tools Available",
        "📋 Commands",
        "✅ Best Practices",
        "🔄 How Memory Flows",
        "🏗️ Architecture",
        "❓ Troubleshooting",
      ], {});

      if (!section) return;

      const lines: string[] = [];

      if (section.startsWith("📦")) {
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║           📦 What Gets Saved                 ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  Type            │ File          │ Limit");
        lines.push("  ────────────────┼───────────────┼────────────");
        lines.push("  🧠 Memory       │ MEMORY.md     │ 5,000 chars");
        lines.push("  👤 User Profile │ USER.md       │ 5,000 chars");
        lines.push("  ⚠️  Failures     │ failures.md   │ 10,000 chars");
        lines.push("  📚 Skills       │ skills/*.md   │ Unlimited");
        lines.push("  💾 Extended     │ sessions.db   │ Unlimited");
        lines.push("");
        lines.push("  Memory:   Facts — env details, project conventions, tool quirks");
        lines.push("  User:     Who you are — name, preferences, communication style");
        lines.push("  Failures: What didn't work — corrections, failures, insights");
        lines.push("  Skills:   Procedures — how to debug, deploy, test");
        lines.push("  Extended: Searchable memories beyond the core limit");
        lines.push("");
        lines.push("  Memory Categories:");
        lines.push("  ─────────────────");
        lines.push("  [failure]      What was tried but didn't work");
        lines.push("  [correction]   User corrected the agent");
        lines.push("  [insight]      Learning from experience");
        lines.push("  [preference]   User preference");
        lines.push("  [convention]   Project convention");
        lines.push("  [tool-quirk]   Tool-specific knowledge");
      }

      if (section.startsWith("🔧")) {
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║           🔧 Tools Available                 ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  memory (add/replace/remove)");
        lines.push("    Save, update, or delete memories");
        lines.push("    Targets: memory, user, failure, project");
        lines.push("");
        lines.push("  skill (create/view/patch/edit/delete)");
        lines.push("    Save reusable procedures");
        lines.push("");
        lines.push("  session_search");
        lines.push("    Search past conversations across all sessions");
        lines.push("");
        lines.push("  memory_search");
        lines.push("    Search extended memory store (unlimited)");
        lines.push("    Filters: project, target, category");
        lines.push("    Categories: failure, correction, insight, preference, convention, tool-quirk");
      }

      if (section.startsWith("📋")) {
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║             📋 Commands                      ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  /memory-insights      Show everything stored in memory");
        lines.push("  /memory-skills        List all saved skills");
        lines.push("  /memory-consolidate   Manually trigger memory cleanup");
        lines.push("  /memory-interview     Answer questions to pre-fill profile");
        lines.push("  /memory-switch-project List all project memories");
        lines.push("  /memory-index-sessions Import past sessions for search");
        lines.push("  /memory-review-candidates TUI review/triage/promotion flow");
        lines.push("  /memory-candidates-stats Show candidate pipeline counts");
        lines.push("  /memory-candidates-rebuild Rebuild candidates from indexed sessions");
      }

      if (section.startsWith("✅")) {
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║           ✅ Best Practices                  ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  ✅ DO save:");
        lines.push("     • User preferences (\"prefers pnpm\", \"uses vim\")");
        lines.push("     • Environment facts (\"macOS M1\", \"Node 20\")");
        lines.push("     • Corrections (\"don't use npm — use pnpm\")");
        lines.push("     • Project conventions (\"monorepo with turborepo\")");
        lines.push("     • Failures (\"tried localStorage — XSS vulnerability\")");
        lines.push("");
        lines.push("  ❌ DON'T save:");
        lines.push("     • Task progress (\"finished implementing auth\")");
        lines.push("     • Session outcomes (\"PR #42 was merged\")");
        lines.push("     • Temporary state (\"currently debugging X\")");
      }

      if (section.startsWith("🔄")) {
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║          🔄 How Memory Flows                 ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  1. Session starts     → Core memory + recent failures injected");
        lines.push("  2. During conversation → Agent saves via memory tool");
        lines.push("  3. Every 10 turns     → Background review saves items");
        lines.push("  4. On correction      → Immediate save as [correction] category");
        lines.push("  5. On failure         → Saves what failed + why");
        lines.push("  6. When full          → Auto-consolidation merges");
        lines.push("  7. Session ends       → Final flush");
      }

      if (section.startsWith("🏗️")) {
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║          🏗️ Two-Tier Architecture            ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  Always in Context (5,000 chars each)");
        lines.push("  ┌─────────────────────────────────────┐");
        lines.push("  │ MEMORY.md — Facts, conventions      │");
        lines.push("  │ USER.md   — Who you are             │");
        lines.push("  │ failures.md — Recent failures (7d)  │");
        lines.push("  │ Project memory — When cwd matches   │");
        lines.push("  └─────────────────────────────────────┘");
        lines.push("");
        lines.push("  Searchable on Demand (Unlimited)");
        lines.push("  ┌─────────────────────────────────────┐");
        lines.push("  │ session_search(\"auth flow\")         │");
        lines.push("  │ memory_search(\"testing patterns\")   │");
        lines.push("  │ memory_search(\"auth\", cat:\"failure\")│");
        lines.push("  └─────────────────────────────────────┘");
      }

      if (section.startsWith("❓")) {
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║          ❓ Troubleshooting                  ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  \"Memory is full\"");
        lines.push("    → /memory-consolidate to merge entries");
        lines.push("");
        lines.push("  \"Can't find something\"");
        lines.push("    → memory_search to search extended store");
        lines.push("");
        lines.push("  \"Agent forgot something\"");
        lines.push("    → Check /memory-insights, tell agent \"remember X\"");
        lines.push("");
        lines.push("  \"Want to edit manually\"");
        lines.push("    → Files at ~/.pi/agent/memory/ (plain markdown)");
      }

      if (lines.length > 0) {
        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });
}
