import type { MemoryStore } from "./store/memory-store.js";

export type ProjectStoreRef = MemoryStore | null | (() => MemoryStore | null);
export type ProjectNameRef = string | null | (() => string | null | undefined);

export function resolveProjectStore(ref: ProjectStoreRef): MemoryStore | null {
  return typeof ref === "function" ? ref() : ref;
}

export function resolveProjectName(ref: ProjectNameRef): string | null {
  const value = typeof ref === "function" ? ref() : ref;
  return value?.trim() || null;
}
