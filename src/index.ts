/** Thin synchronous bootstrap for Pi Hermes Memory. */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SkillStore as SkillStoreType } from "./store/skill-store.js";
import { SkillStore } from "./store/skill-store.js";
import { StandingInstructions } from "./store/standing-instructions.js";
import { loadConfig } from "./config.js";
import { STANDING_FILE } from "./constants.js";
import { AGENT_ROOT } from "./paths.js";
import { detectProjectSkills } from "./project.js";
import { resolveMemoryPolicyPrompt } from "./prompt-context.js";
import { registerThinTools } from "./thin-tool-definitions.js";
import { createRetryableLoader } from "./deferred-loader.js";
import { createLazyEventQualifier } from "./lazy-event-qualifier.js";
import type { MemoryConfig } from "./types.js";
import type { LazyEventState } from "./lazy-event-qualifier.js";

export function resolveProjectSkillDiscovery(
  skillStore: SkillStoreType,
  projectsMemoryDir: string | undefined,
  cwd?: string,
): { skillPaths: string[] } {
  const detected = detectProjectSkills(projectsMemoryDir, cwd);
  skillStore.setProjectContext(detected.name, detected.skillsDir);
  const skillPaths = [skillStore.getGlobalSkillsDir()];
  if (detected.skillsDir) skillPaths.push(detected.skillsDir);
  return { skillPaths };
}

export function registerProjectSkillDiscoveryHandler(
  pi: Pick<ExtensionAPI, "on">,
  skillStore: SkillStoreType,
  projectsMemoryDir: string | undefined,
): void {
  pi.on("resources_discover", async (event, _ctx) =>
    resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, (event as { cwd?: string }).cwd));
}

type Handler = (event: any, ctx: any) => any;
type RuntimeRegistry = {
  handlers: Map<string, Handler[]>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  seedLazyState?: (state: LazyEventState) => void;
};
type RuntimeRegistrar = (
  pi: ExtensionAPI,
  config: MemoryConfig,
  options?: {
    skillStore?: SkillStoreType;
    standingStore?: StandingInstructions | null;
    startupStoresPrepared?: () => boolean;
    lazyState?: LazyEventState;
  },
) => { seedLazyState(state: LazyEventState): void } | void;

export interface EntrypointDependencies {
  importRuntime?: () => Promise<{ default: RuntimeRegistrar }>;
}

const COMMANDS: Array<[string, string]> = [
  ["memory-insights", "Show what's stored in persistent memory"],
  ["memory-consolidate", "Manually trigger memory consolidation to free up space"],
  ["learn-memory-tool", "Learn how to use the pi-hermes-memory extension effectively"],
  ["memory-preview-context", "Preview the memory policy or legacy memory context blocks"],
  ["memory-skills", "Manage global, active-project, and loaded external procedural skills"],
  ["memory-interview", "Answer a few questions to pre-fill your user profile so the agent remembers you across sessions"],
  ["memory-sync-markdown", "Reconcile the SQLite search mirror with Markdown memories"],
  ["memory-index-sessions", "Import past Pi sessions into the search database"],
  ["memory-pin", "Pin a standing instruction that is injected into every session"],
  ["memory-switch-project", "Switch the active project for project-scoped memory"],
];

const LAZY_EVENTS = ["message_end", "turn_end", "session_before_compact"] as const;

function logHandlerFailure(name: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`⚠️ Deferred memory runtime '${name}' handler failed: ${detail}`);
}

export default function registerExtension(pi: ExtensionAPI, dependencies: EntrypointDependencies = {}): void {
  const config = loadConfig();
  const lazy = config.lazyInitialization === true && config.memoryMode === "policy-only";
  const agentRoot = AGENT_ROOT;
  const legacyGlobalDir = path.join(agentRoot, "memory");
  const configuredMemoryDir = config.memoryDir?.trim();
  const pointsToLegacyMemoryDir = configuredMemoryDir
    ? path.resolve(configuredMemoryDir) === path.resolve(legacyGlobalDir)
    : false;
  const globalDir = !configuredMemoryDir || pointsToLegacyMemoryDir
    ? path.join(agentRoot, "pi-hermes-memory")
    : configuredMemoryDir;

  const skillStore = new SkillStore({
    globalSkillsDir: path.join(globalDir, "skills"),
    piGlobalSkillsDir: path.join(agentRoot, "skills"),
    projectSkillsDir: null,
    projectName: null,
    legacySkillsDir: path.join(legacyGlobalDir, "skills"),
    migrationSentinelPath: path.join(globalDir, ".skills-migrated-to-extension-storage"),
  });
  const standingStore = config.standingInstructionsEnabled !== false
    ? new StandingInstructions(
      path.join(globalDir, STANDING_FILE), undefined, undefined,
      (!configuredMemoryDir || pointsToLegacyMemoryDir) ? path.join(legacyGlobalDir, STANDING_FILE) : undefined,
    )
    : null;

  type PendingEvent = { name: string; event: any; ctx: any; stateBefore?: LazyEventState };
  type Generation = {
    sessionStart?: { event: any; ctx: ExtensionContext };
    pendingEvents: PendingEvent[];
    qualifies: ReturnType<typeof createLazyEventQualifier>;
    activationRequired: boolean;
    correctionTurnPending: boolean;
    initialLazyState?: LazyEventState;
    lifecycleChain: Promise<any>;
    loadPending: boolean;
    invalidated: boolean;
    cancelled: Promise<void>;
    cancel(): void;
    loadRuntime?: () => Promise<RuntimeRegistry>;
  };

  let runtime: RuntimeRegistry | undefined;
  let startupStoresPrepared = false;
  const lifecycleEventsEnabled = config.reviewEnabled || config.correctionDetection || config.flushOnCompact || config.flushOnShutdown;

  const createGeneration = (): Generation => {
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
    return {
      pendingEvents: [],
      qualifies: createLazyEventQualifier(config),
      activationRequired: !lazy,
      correctionTurnPending: false,
      lifecycleChain: Promise.resolve(undefined),
      loadPending: false,
      invalidated: false,
      cancelled,
      cancel,
    };
  };

  let generation = createGeneration();

  const invalidate = (obsolete: Generation): void => {
    if (obsolete.invalidated) return;
    obsolete.invalidated = true;
    obsolete.sessionStart = undefined;
    obsolete.pendingEvents.length = 0;
    obsolete.initialLazyState = undefined;
    obsolete.correctionTurnPending = false;
    obsolete.activationRequired = false;
    obsolete.lifecycleChain = Promise.resolve(undefined);
    obsolete.cancel();
  };

  const dispatchRegistry = async (
    registry: RuntimeRegistry,
    name: string,
    event: any,
    ctx: any,
    throwAfter = false,
  ) => {
    let result: any;
    const failures: unknown[] = [];
    for (const handler of registry.handlers.get(name) ?? []) {
      try {
        result = (await handler(event, ctx)) ?? result;
      } catch (error) {
        failures.push(error);
        logHandlerFailure(name, error);
      }
    }
    if (throwAfter && failures.length > 0) {
      throw new AggregateError(failures, `Deferred runtime '${name}' replay failed`);
    }
    return result;
  };

  const getLoadRuntime = (owner: Generation): (() => Promise<RuntimeRegistry>) => {
    owner.loadRuntime ??= createRetryableLoader(async (): Promise<RuntimeRegistry> => {
      if (owner.invalidated || owner !== generation) throw new Error("Deferred memory runtime generation was invalidated");
      const { default: registerRuntime } = await (dependencies.importRuntime?.() ?? import("./runtime.js"));
      if (owner.invalidated || owner !== generation) throw new Error("Deferred memory runtime generation was invalidated");
      const candidate: RuntimeRegistry = {
        handlers: new Map<string, Handler[]>(),
        tools: new Map<string, any>(),
        commands: new Map<string, any>(),
      };
      const runtimePi = new Proxy(pi as any, {
        get(target, property, receiver) {
          if (property === "on") return (name: string, handler: Handler) => {
            const values = candidate.handlers.get(name) ?? [];
            values.push(handler);
            candidate.handlers.set(name, values);
          };
          if (property === "registerTool") return (tool: any) => candidate.tools.set(tool.name, tool);
          if (property === "registerCommand") return (name: string, command: any) => candidate.commands.set(name, command);
          return Reflect.get(target, property, receiver);
        },
      });
      const registration = registerRuntime(runtimePi, config, {
        skillStore,
        standingStore,
        startupStoresPrepared: () => startupStoresPrepared,
        lazyState: owner.initialLazyState,
      });
      candidate.seedLazyState = registration?.seedLazyState;
      try {
        if (owner.sessionStart) {
          await dispatchRegistry(candidate, "session_start", owner.sessionStart.event, owner.sessionStart.ctx, true);
        }
      } catch (error) {
        if (owner.sessionStart) {
          await dispatchRegistry(candidate, "session_shutdown", { type: "session_shutdown", reason: "reload" }, owner.sessionStart.ctx);
        }
        throw error;
      }
      if (owner.invalidated || owner !== generation) throw new Error("Deferred memory runtime generation was invalidated");
      runtime = candidate;
      return candidate;
    });
    return owner.loadRuntime;
  };

  const activateAndReplay = async (owner: Generation): Promise<RuntimeRegistry> => {
    if (owner.invalidated || owner !== generation) throw new Error("Deferred memory runtime generation was invalidated");
    owner.loadPending = true;
    try {
      const loaded = await getLoadRuntime(owner)();
      while (!owner.invalidated && owner.pendingEvents.length > 0) {
        const pending = owner.pendingEvents.shift()!;
        if (pending.stateBefore) loaded.seedLazyState?.(pending.stateBefore);
        await dispatchRegistry(loaded, pending.name, pending.event, pending.ctx);
      }
      owner.activationRequired = false;
      return loaded;
    } finally {
      owner.loadPending = false;
    }
  };

  const serialize = <T>(owner: Generation, operation: () => Promise<T>): Promise<T | undefined> => {
    const result = owner.lifecycleChain.then(operation, operation);
    owner.lifecycleChain = result.then(() => undefined, () => undefined);
    return Promise.race([result, owner.cancelled.then(() => undefined)]);
  };

  const loadForOperation = async (): Promise<RuntimeRegistry> => {
    const owner = generation;
    if (owner.invalidated) throw new Error("Deferred memory runtime generation was invalidated");
    owner.loadPending = true;
    const loaded = await serialize(owner, () => activateAndReplay(owner));
    if (!loaded) throw new Error("Deferred memory runtime generation was invalidated");
    return loaded;
  };

  registerThinTools(pi, config.sessionSearch?.variant ?? "legacy", async (name) => {
    const loaded = await loadForOperation();
    const tool = loaded.tools.get(name);
    if (!tool) throw new Error(`Deferred memory tool '${name}' was not registered`);
    return tool;
  });

  for (const [name, description] of COMMANDS) {
    const command: any = {
      description,
      async handler(args: string, ctx: any) {
        const loaded = await loadForOperation();
        const implementation = loaded.commands.get(name);
        if (!implementation) throw new Error(`Deferred memory command '${name}' was not registered`);
        return implementation.handler(args, ctx);
      },
    };
    if (name === "memory-pin") {
      command.getArgumentCompletions = (prefix: string) => {
        const trimmed = prefix.trimStart();
        if (trimmed.includes(" ")) return null;
        return ["list", "remove", "clear"]
          .filter((value) => value.startsWith(trimmed))
          .map((value) => ({ value, label: value }));
      };
    }
    pi.registerCommand(name, command);
  }

  pi.on("session_start", async (event, ctx) => {
    if (!runtime && (generation.invalidated || (lazy && generation.sessionStart))) {
      invalidate(generation);
      generation = createGeneration();
      startupStoresPrepared = false;
    }
    const owner = generation;
    owner.sessionStart = { event, ctx };
    if (!lazy || runtime) {
      return serialize(owner, async () => {
        if (runtime) return dispatchRegistry(runtime, "session_start", event, ctx);
        await getLoadRuntime(owner)(); // The loader replays the saved session_start once.
      });
    }
    if (standingStore) await standingStore.load();
    resolveProjectSkillDiscovery(skillStore, config.projectsMemoryDir, ctx.cwd);
    await skillStore.migrateLegacySkills();
    await skillStore.ensureDiscoveredRoots();
    startupStoresPrepared = true;
  });

  pi.on("resources_discover", async (event, ctx) => {
    const owner = generation;
    if (!lazy || runtime) {
      return serialize(owner, async () => dispatchRegistry(await activateAndReplay(owner), "resources_discover", event, ctx));
    }
    return resolveProjectSkillDiscovery(skillStore, config.projectsMemoryDir, (event as { cwd?: string }).cwd);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const owner = generation;
    if (!lazy || runtime) {
      return serialize(owner, async () => dispatchRegistry(await activateAndReplay(owner), "before_agent_start", event, ctx));
    }
    const prompt = resolveMemoryPolicyPrompt(config);
    const standing = standingStore?.formatForSystemPrompt() ?? "";
    const promptContext = [prompt, standing].filter(Boolean).join("\n\n");
    if (promptContext) return { systemPrompt: event.systemPrompt + "\n\n" + promptContext };
  });

  const enqueueLazyEvent = (name: string, event: any, ctx: any) => {
    const owner = generation;
    let shutdownEligible = false;
    if (name === "session_shutdown" && !runtime) {
      shutdownEligible = lazy && owner.qualifies(name, event);
      // A shutdown which cannot flush retires a cold generation instead of
      // leaving its session_start available for a later first-use operation.
      // Eager startup is also cancelled here when its import is still pending.
      if (!shutdownEligible) {
        invalidate(owner);
        return;
      }
    }

    if (runtime || !lazy) {
      owner.pendingEvents.push({ name, event, ctx });
      return serialize(owner, async () => activateAndReplay(owner));
    }

    // Cold policy-only sessions keep only the trigger event. Counters are
    // retained as primitives and seeded into the full runtime on activation.
    if (!lifecycleEventsEnabled) return;
    const trigger = name === "session_shutdown" ? shutdownEligible : owner.qualifies(name, event);
    const stateBefore = owner.qualifies.getStateBeforeLastEvent();
    const correctionFollowup = owner.activationRequired && owner.correctionTurnPending && name === "turn_end";
    if (name === "message_end" && trigger) owner.correctionTurnPending = true;
    if (correctionFollowup) owner.correctionTurnPending = false;
    if (name === "turn_end" && trigger) owner.qualifies.resetReviewCounters();
    if (!trigger && !correctionFollowup) return;

    if (!owner.activationRequired) {
      owner.activationRequired = true;
      owner.initialLazyState = stateBefore;
    }
    owner.pendingEvents.push({ name, event, ctx, stateBefore });
    owner.loadPending = true;
    return serialize(owner, async () => activateAndReplay(owner));
  };

  for (const eventName of LAZY_EVENTS) {
    (pi.on as any)(eventName, (event: any, ctx: any) => enqueueLazyEvent(eventName, event, ctx));
  }

  (pi.on as any)("session_shutdown", (event: any, ctx: any) => enqueueLazyEvent("session_shutdown", event, ctx));
}
