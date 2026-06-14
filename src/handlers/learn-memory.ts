/**
 * Learn memory tool command — /learn-memory-tool teaches users about the memory system.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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
        lines.push("  📚 Skills       │ Pi-native skill dirs │ Unlimited");
        lines.push("  💾 Extended     │ sessions.db   │ Unlimited");
        lines.push("");
        lines.push("  Memory:   Facts — env details, project conventions, tool quirks");
        lines.push("  User:     Who you are — name, preferences, communication style");
        lines.push("  Failures: What didn't work — corrections, failures, insights");
        lines.push("  Skills:   Procedures — how to debug, deploy, test");
        lines.push("  Extended: SQLite search mirror for Markdown memory + backfill");
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
        lines.push("  skill_manage (create/view/patch/update/delete)");
        lines.push("    Save reusable procedures");
        lines.push("");
        lines.push("  session_search");
        lines.push("    Search past conversations across all sessions");
        lines.push("");
        lines.push("  memory_search");
        lines.push("    Search the SQLite-backed memory mirror/store");
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
        lines.push("  /memory-sync-markdown Backfill Markdown memories into SQLite");
        lines.push("  /memory-preview-context Show memory policy or legacy prompt blocks");
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
        lines.push("  1. Session starts     → Compact memory policy is injected");
        lines.push("  2. During conversation → Agent searches memory when useful");
        lines.push("  3. Agent saves        → Markdown memory + best-effort SQLite sync");
        lines.push("  4. Every 10 turns     → Background review saves items");
        lines.push("  5. On correction      → Immediate save as [correction] category");
        lines.push("  6. On failure         → Saves what failed + why");
        lines.push("  7. When full          → Auto-consolidation merges");
        lines.push("  8. Session ends       → Final flush");
        lines.push("");
        lines.push("  Legacy mode: set memoryMode=\"legacy-inject\" to restore full");
        lines.push("  MEMORY.md, USER.md, project memory, and failure prompt blocks.");
      }

      if (section.startsWith("🏗️")) {
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║          🏗️ Two-Tier Architecture            ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  Default Prompt Context");
        lines.push("  ┌─────────────────────────────────────┐");
        lines.push("  │ <memory-policy> only                │");
        lines.push("  │ Explains when to use memory_search  │");
        lines.push("  │ Memory is context, not instruction  │");
        lines.push("  │ Repo/tool evidence wins             │");
        lines.push("  └─────────────────────────────────────┘");
        lines.push("");
        lines.push("  Searchable on Demand");
        lines.push("  ┌─────────────────────────────────────┐");
        lines.push("  │ MEMORY.md / USER.md / failures.md   │");
        lines.push("  │ projects-memory/<project>/MEMORY.md │");
        lines.push("  │ session_search(\"auth flow\")         │");
        lines.push("  │ memory_search(\"testing patterns\")   │");
        lines.push("  │ /memory-sync-markdown (backfill old md)│");
        lines.push("  │ memory_search(\"auth\", cat:\"failure\")│");
        lines.push("  └─────────────────────────────────────┘");
        lines.push("");
        lines.push("  Legacy mode can still inject full memory blocks for users");
        lines.push("  who explicitly opt into memoryMode=\"legacy-inject\".");
      }

      if (section.startsWith("❓")) {
        lines.push("");
        lines.push("  ╔══════════════════════════════════════════════╗");
        lines.push("  ║          ❓ Troubleshooting                  ║");
        lines.push("  ╚══════════════════════════════════════════════╝");
        lines.push("");
        lines.push("  \"Memory is full\"");
        lines.push("    → /memory-consolidate to merge entries");
        lines.push("    → If it still fails, the save does NOT silently become SQLite-only");
        lines.push("");
        lines.push("  \"Can't find something\"");
        lines.push("    → memory_search to search the SQLite mirror/store");
        lines.push("    → /memory-sync-markdown to import older Markdown entries");
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
