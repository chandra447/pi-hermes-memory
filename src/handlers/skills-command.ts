/**
 * Skills command — /memory-skills opens an interactive skills manager.
 */

import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { SkillStore } from "../store/skill-store.js";
import type { SkillIndex, SkillResult, SkillScope } from "../types.js";
import {
  Input,
  Key,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

export const MEMORY_SKILLS_KEYMAP = {
  moveGlobal: "g",
  moveProject: "p",
  deleteSelected: "d",
  cycleSort: "s",
  selectAllFiltered: "a",
  clearSelection: "n",
  focusSearch: "/",
  openFilters: "f",
  toggleSelection: "space",
  switchFocus: "tab",
  close: "esc",
} as const;

export type SkillRowCategory = "G" | "P" | "E";
export type SkillSortMode = "updated" | "created" | "name";

export interface SkillModalRow {
  skillId: string;
  scope?: SkillScope;
  category: SkillRowCategory;
  mutable: boolean;
  name: string;
  displayName: string;
  description: string;
  path: string;
  displayPath: string;
  created?: string;
  updated?: string;
  projectName?: string;
  selected: boolean;
  searchText: string;
}

interface LoadedSkillRow {
  name: string;
  displayName: string;
  description: string;
  path: string;
  displayPath: string;
  sourceScope?: string;
  sourceOrigin?: string;
  sourceLabel?: string;
}

interface SkillCommandInfo {
  name: string;
  description?: string;
  source?: string;
  sourceInfo?: {
    path?: string;
    scope?: string;
    source?: string;
    origin?: string;
    baseDir?: string;
  };
}

interface SkillCategoryFilters {
  global: boolean;
  project: boolean;
  external: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const DEFAULT_SKILL_FILTERS: SkillCategoryFilters = {
  global: true,
  project: true,
  external: true,
};

function cloneFilters(filters: SkillCategoryFilters): SkillCategoryFilters {
  return {
    global: filters.global,
    project: filters.project,
    external: filters.external,
  };
}

function ensureValidFilters(filters: SkillCategoryFilters): SkillCategoryFilters {
  if (filters.global || filters.project || filters.external) return filters;
  return { ...DEFAULT_SKILL_FILTERS };
}

function filtersLabel(filters: SkillCategoryFilters): string {
  const active: string[] = [];
  if (filters.global) active.push("[G]");
  if (filters.project) active.push("[P]");
  if (filters.external) active.push("[E]");
  return active.length > 0 ? active.join(" ") : "(none)";
}

function normalizePathForKey(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const normalized = resolved.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function formatSkillPath(inputPath: string): string {
  const absolutePath = path.resolve(inputPath);
  const home = os.homedir();
  const relative = path.relative(home, absolutePath);
  const underHome = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

  if (!underHome) return absolutePath;
  if (relative === "") return "~";
  return `~${path.sep}${relative}`;
}

function categoryForScope(scope: SkillScope): SkillRowCategory {
  return scope === "global" ? "G" : "P";
}

function createExternalSkillId(name: string, filePath: string): string {
  const safeName = (name || "skill")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "skill";
  const hash = createHash("sha1").update(`${name}|${filePath}`).digest("hex").slice(0, 10);
  return `external:${safeName}:${hash}`;
}

function matchesCategoryFilter(row: SkillModalRow, filters: SkillCategoryFilters): boolean {
  if (row.category === "G") return filters.global;
  if (row.category === "P") return filters.project;
  return filters.external;
}

function categoryOrder(category: SkillRowCategory): number {
  switch (category) {
    case "G":
      return 0;
    case "P":
      return 1;
    case "E":
      return 2;
  }
}

function recencyValue(row: Pick<SkillModalRow, "updated" | "created">): string {
  return row.updated || row.created || "";
}

function sortModeLabel(sortMode: SkillSortMode): string {
  switch (sortMode) {
    case "updated":
      return "Updated";
    case "created":
      return "Created";
    case "name":
      return "Name";
  }
}

function nextSortMode(sortMode: SkillSortMode): SkillSortMode {
  switch (sortMode) {
    case "updated":
      return "created";
    case "created":
      return "name";
    case "name":
      return "updated";
  }
}

function compareSkillRows(a: SkillModalRow, b: SkillModalRow, sortMode: SkillSortMode): number {
  if (sortMode === "name") {
    const byName = a.displayName.localeCompare(b.displayName);
    if (byName !== 0) return byName;
    return categoryOrder(a.category) - categoryOrder(b.category);
  }

  const primaryA = sortMode === "updated" ? recencyValue(a) : (a.created || "");
  const primaryB = sortMode === "updated" ? recencyValue(b) : (b.created || "");
  if (primaryA || primaryB) {
    if (!primaryA) return 1;
    if (!primaryB) return -1;
    if (primaryA !== primaryB) return primaryB.localeCompare(primaryA);
  }

  if (sortMode === "updated") {
    const createdA = a.created || "";
    const createdB = b.created || "";
    if (createdA || createdB) {
      if (!createdA) return 1;
      if (!createdB) return -1;
      if (createdA !== createdB) return createdB.localeCompare(createdA);
    }
  } else {
    const updatedA = recencyValue(a);
    const updatedB = recencyValue(b);
    if (updatedA || updatedB) {
      if (!updatedA) return 1;
      if (!updatedB) return -1;
      if (updatedA !== updatedB) return updatedB.localeCompare(updatedA);
    }
  }

  const byCategory = categoryOrder(a.category) - categoryOrder(b.category);
  if (byCategory !== 0) return byCategory;
  return a.displayName.localeCompare(b.displayName);
}

export function collectLoadedSkillsFromCommands(commands: SkillCommandInfo[]): LoadedSkillRow[] {
  const loaded: LoadedSkillRow[] = [];

  for (const command of commands) {
    if (!isRecord(command)) continue;
    const source = getStringField(command.source);
    if (source !== "skill") continue;

    const commandName = getStringField(command.name)?.trim();
    if (!commandName) continue;

    const sourceInfo = isRecord(command.sourceInfo) ? command.sourceInfo : undefined;
    const sourcePath = sourceInfo ? getStringField(sourceInfo.path)?.trim() : undefined;
    if (!sourcePath) continue;

    const rawName = commandName.startsWith("skill:")
      ? commandName.slice("skill:".length)
      : commandName;
    const displayName = rawName || commandName;
    const filePath = path.resolve(sourcePath);

    loaded.push({
      name: rawName || commandName,
      displayName,
      description: getStringField(command.description) || "",
      path: filePath,
      displayPath: formatSkillPath(filePath),
      sourceScope: sourceInfo ? getStringField(sourceInfo.scope) : undefined,
      sourceOrigin: sourceInfo ? getStringField(sourceInfo.origin) : undefined,
      sourceLabel: sourceInfo ? getStringField(sourceInfo.source) : undefined,
    });
  }

  return loaded.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function formatSkillsList(rows: SkillModalRow[], projectName: string | null): string {
  const globalSkills = rows.filter((row) => row.category === "G");
  const projectSkills = rows.filter((row) => row.category === "P");
  const externalSkills = rows.filter((row) => row.category === "E");

  const lines: string[] = [];
  lines.push("");
  lines.push("  ╔═══════════════════════════════════════════════════════════╗");
  lines.push("  ║                    🧠 Procedural Skills                  ║");
  lines.push("  ╚═══════════════════════════════════════════════════════════╝");
  lines.push("  Legend: [G] global · [P] project · [E] external (read-only)");
  lines.push("");

  if (rows.length === 0) {
    lines.push("  (no skills found in this session)");
    lines.push("");
    lines.push("  Ask the agent to save a reusable procedure");
    lines.push("  with the skill_manage tool when it is worth keeping.");
    return lines.join("\n");
  }

  if (globalSkills.length > 0) {
    lines.push("  [G] Global Skills");
    lines.push("  ─────────────────");
    for (const row of globalSkills) {
      lines.push(`  📄 ${row.displayName} (${row.displayPath})`);
      lines.push(`     ${row.description || "(no description)"}`);
      lines.push(`     id: ${row.skillId}`);
      lines.push("");
    }
  }

  if (projectSkills.length > 0) {
    lines.push(`  [P] Project Skills${projectName ? ` (${projectName})` : ""}`);
    lines.push("  ─────────────────────────────────");
    for (const row of projectSkills) {
      lines.push(`  📄 ${row.displayName} (${row.displayPath})`);
      lines.push(`     ${row.description || "(no description)"}`);
      lines.push(`     id: ${row.skillId}`);
      lines.push("");
    }
  }

  if (externalSkills.length > 0) {
    lines.push("  [E] External Skills (read-only)");
    lines.push("  ───────────────────────────────");
    for (const row of externalSkills) {
      lines.push(`  📄 ${row.displayName} (${row.displayPath})`);
      lines.push(`     ${row.description || "(no description)"}`);
      lines.push(`     id: ${row.skillId}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function buildSkillRows(skills: SkillIndex[], selectedSkillIds = new Set<string>()): SkillModalRow[] {
  return skills.map((skill) => {
    const displayName = skill.displayName || skill.name;
    const displayPath = formatSkillPath(skill.path);
    return {
      skillId: skill.skillId,
      scope: skill.scope,
      category: categoryForScope(skill.scope),
      mutable: true,
      name: skill.name,
      displayName,
      description: skill.description,
      path: skill.path,
      displayPath,
      created: skill.created,
      updated: skill.updated,
      projectName: skill.projectName,
      selected: selectedSkillIds.has(skill.skillId),
      searchText: `${displayName} ${skill.name} ${skill.description || ""} ${skill.path} ${displayPath}`.trim(),
    };
  });
}

export function buildUnifiedSkillRows(
  managedSkills: SkillIndex[],
  loadedSkills: LoadedSkillRow[],
  selectedSkillIds = new Set<string>(),
  sortMode: SkillSortMode = "updated",
): SkillModalRow[] {
  const managedRows = buildSkillRows(managedSkills, selectedSkillIds);
  const managedPathKeys = new Set(managedRows.map((row) => normalizePathForKey(row.path)));
  const externalPathKeys = new Set<string>();

  const externalRows: SkillModalRow[] = [];
  for (const loaded of loadedSkills) {
    const loadedKey = normalizePathForKey(loaded.path);
    if (managedPathKeys.has(loadedKey)) continue;
    if (externalPathKeys.has(loadedKey)) continue;
    externalPathKeys.add(loadedKey);

    const externalSkillId = createExternalSkillId(loaded.name, loaded.path);
    externalRows.push({
      skillId: externalSkillId,
      scope: undefined,
      category: "E",
      mutable: false,
      name: loaded.name,
      displayName: loaded.displayName,
      description: loaded.description,
      path: loaded.path,
      displayPath: loaded.displayPath,
      selected: selectedSkillIds.has(externalSkillId),
      searchText: `${loaded.displayName} ${loaded.name} ${loaded.description || ""} ${loaded.path} ${loaded.displayPath}`.trim(),
    });
  }

  return [...managedRows, ...externalRows].sort((a, b) => compareSkillRows(a, b, sortMode));
}

export function filterSkillRows(rows: SkillModalRow[], query: string): SkillModalRow[] {
  const trimmed = query.trim();
  if (!trimmed) return rows;
  return fuzzyFilter(rows, trimmed, (row) => row.searchText);
}

export function getSelectedSkillIds(rows: SkillModalRow[]): string[] {
  return rows.filter((row) => row.selected).map((row) => row.skillId);
}

function summarizeAction(
  actionVerb: string,
  targetLabel: string,
  successes: SkillResult[],
  unchanged: SkillResult[],
  blocked: Array<{ skillId: string; error: string }>,
): string[] {
  const lines: string[] = [];
  const changed = successes.filter((result) => result.message?.includes(actionVerb) || result.skillId);

  if (actionVerb === "moved") {
    lines.push(`Moved ${successes.length} skill${successes.length === 1 ? "" : "s"} to ${targetLabel}.`);
  } else if (actionVerb === "deleted") {
    lines.push(`Deleted ${successes.length} skill${successes.length === 1 ? "" : "s"}.`);
  } else {
    lines.push(`${changed.length} skill action(s) completed.`);
  }

  if (unchanged.length > 0) {
    lines.push(`${unchanged.length} already matched the target scope.`);
  }

  if (blocked.length > 0) {
    lines.push(`Blocked ${blocked.length} skill${blocked.length === 1 ? "" : "s"}:`);
    for (const item of blocked.slice(0, 4)) {
      lines.push(`- ${item.skillId}: ${item.error}`);
    }
    if (blocked.length > 4) {
      lines.push(`- …and ${blocked.length - 4} more`);
    }
  }

  return lines;
}

type SkillMoveStore = Pick<SkillStore, "move" | "loadIndex" | "getProjectName">;
type SkillDeleteStore = Pick<SkillStore, "delete" | "loadIndex">;
export type ConfirmDialog = (title: string, message: string) => Promise<boolean>;

export interface SkillBatchActionResult {
  skills: SkillIndex[];
  summaryLines: string[];
  retainSelectedSkillIds?: string[];
  focusSkillId?: string;
}

export async function moveSelectedSkills(
  store: SkillMoveStore,
  skillIds: string[],
  targetScope: SkillScope,
): Promise<SkillBatchActionResult> {
  const dedupedSkillIds = Array.from(new Set(skillIds));
  const currentSkills = await store.loadIndex();

  if (dedupedSkillIds.length === 0) {
    return {
      skills: currentSkills,
      summaryLines: ["Select one or more skills first."],
    };
  }

  if (targetScope === "project" && !store.getProjectName()) {
    return {
      skills: currentSkills,
      summaryLines: ["Move to project is unavailable: no active project detected."],
      retainSelectedSkillIds: dedupedSkillIds,
    };
  }

  const successes: SkillResult[] = [];
  const unchanged: SkillResult[] = [];
  const blocked: Array<{ skillId: string; error: string }> = [];

  for (const skillId of dedupedSkillIds) {
    try {
      const result = await store.move(skillId, targetScope);
      if (result.success) {
        if (result.skillId === skillId && result.scope === targetScope) {
          unchanged.push(result);
        } else {
          successes.push(result);
        }
      } else {
        blocked.push({ skillId, error: result.error || "Unknown move failure." });
      }
    } catch (error) {
      blocked.push({
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const refreshedSkills = await store.loadIndex();
  const focusSkillId = blocked[0]?.skillId
    ?? successes[0]?.skillId
    ?? unchanged[0]?.skillId;

  return {
    skills: refreshedSkills,
    summaryLines: summarizeAction("moved", targetScope, successes, unchanged, blocked),
    retainSelectedSkillIds: blocked.map((item) => item.skillId),
    focusSkillId,
  };
}

export async function deleteSelectedSkills(
  store: SkillDeleteStore,
  skillIds: string[],
): Promise<SkillBatchActionResult> {
  const dedupedSkillIds = Array.from(new Set(skillIds));
  const currentSkills = await store.loadIndex();

  if (dedupedSkillIds.length === 0) {
    return {
      skills: currentSkills,
      summaryLines: ["Select one or more skills first."],
    };
  }

  const successes: SkillResult[] = [];
  const blocked: Array<{ skillId: string; error: string }> = [];

  for (const skillId of dedupedSkillIds) {
    try {
      const result = await store.delete(skillId);
      if (result.success) {
        successes.push(result);
      } else {
        blocked.push({ skillId, error: result.error || "Unknown delete failure." });
      }
    } catch (error) {
      blocked.push({
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const refreshedSkills = await store.loadIndex();

  return {
    skills: refreshedSkills,
    summaryLines: summarizeAction("deleted", "delete", successes, [], blocked),
    retainSelectedSkillIds: blocked.map((item) => item.skillId),
    focusSkillId: blocked[0]?.skillId,
  };
}

export async function confirmDeleteSelectedSkills(
  confirm: ConfirmDialog,
  store: SkillDeleteStore,
  skillIds: string[],
): Promise<SkillBatchActionResult> {
  const currentSkills = await store.loadIndex();
  if (skillIds.length === 0) {
    return { skills: currentSkills, summaryLines: ["Select one or more skills first."] };
  }

  const confirmed = await confirm(
    "Delete selected skills?",
    `Delete ${skillIds.length} selected skill${skillIds.length === 1 ? "" : "s"}? This cannot be undone.`,
  );

  if (!confirmed) {
    return {
      skills: currentSkills,
      summaryLines: ["Delete cancelled."],
      retainSelectedSkillIds: skillIds,
      focusSkillId: skillIds[0],
    };
  }

  return deleteSelectedSkills(store, skillIds);
}

interface SkillsManagerCallbacks {
  moveSelected: (scope: SkillScope, skillIds: string[]) => Promise<SkillBatchActionResult>;
  deleteSelected: (skillIds: string[]) => Promise<SkillBatchActionResult>;
  close: () => void;
  projectName: string | null;
}

export class SkillsManagerModal implements Focusable {
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncSearchFocus();
  }

  private readonly searchInput = new Input();
  private managedSkills: SkillIndex[];
  private readonly loadedSkills: LoadedSkillRow[];
  private rows: SkillModalRow[];
  private selectedIndex = 0;
  private query = "";
  private focusArea: "search" | "list" | "filters" = "list";
  private busy = false;
  private closed = false;
  private pendingDeleteConfirm: { skillIds: string[] } | null = null;
  private activeFilters: SkillCategoryFilters = { ...DEFAULT_SKILL_FILTERS };
  private pendingFilters: SkillCategoryFilters | null = null;
  private filterCursor = 0;
  private sortMode: SkillSortMode = "updated";
  private summaryLines: string[] = [
    "Select skills with space, then move with g/p or delete with d. Press s to change sort and f for filters.",
  ];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    initialRows: SkillModalRow[],
    private readonly callbacks: SkillsManagerCallbacks,
    options?: {
      managedSkills?: SkillIndex[];
      loadedSkills?: LoadedSkillRow[];
    },
  ) {
    const selectedSkillIds = new Set(initialRows.filter((row) => row.selected).map((row) => row.skillId));

    this.loadedSkills = options?.loadedSkills
      ?? initialRows
        .filter((row) => row.category === "E")
        .map((row) => ({
          name: row.name,
          displayName: row.displayName,
          description: row.description,
          path: row.path,
          displayPath: row.displayPath,
        }));

    this.managedSkills = options?.managedSkills
      ?? initialRows
        .filter((row) => row.category !== "E" && row.scope)
        .map((row) => ({
          skillId: row.skillId,
          scope: row.scope!,
          fileName: path.basename(row.path),
          path: row.path,
          projectName: row.projectName,
          name: row.name,
          displayName: row.displayName,
          description: row.description,
          created: row.created ?? "",
          updated: row.updated ?? "",
        }));

    this.rows = buildUnifiedSkillRows(this.managedSkills, this.loadedSkills, selectedSkillIds, this.sortMode);
    this.syncSearchFocus();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  private get filteredRows(): SkillModalRow[] {
    const categoryFiltered = this.rows.filter((row) => matchesCategoryFilter(row, this.activeFilters));
    return filterSkillRows(categoryFiltered, this.query);
  }

  private getCurrentRow(): SkillModalRow | null {
    const rows = this.filteredRows;
    if (rows.length === 0) return null;
    return rows[Math.min(this.selectedIndex, rows.length - 1)] ?? null;
  }

  private getSelectedRows(): SkillModalRow[] {
    return this.rows.filter((row) => row.selected);
  }

  private getSelectedIds(): string[] {
    return getSelectedSkillIds(this.rows);
  }

  private getFilterOptions(): Array<{ key: keyof SkillCategoryFilters; label: string }> {
    return [
      { key: "global", label: "Global [G]" },
      { key: "project", label: "Project [P]" },
      { key: "external", label: "External [E] (read-only)" },
    ];
  }

  private syncSearchFocus(): void {
    this.searchInput.focused = this.focused && this.focusArea === "search";
  }

  private syncQueryFromInput(): void {
    this.query = this.searchInput.getValue();
    const rows = this.filteredRows;
    if (rows.length === 0) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
    }
  }

  private setFocusArea(area: "search" | "list" | "filters"): void {
    this.focusArea = area;
    this.syncSearchFocus();
    this.tui.requestRender();
  }

  private setRows(managedSkills: SkillIndex[], retainSelectedSkillIds: string[] = [], focusSkillId?: string): void {
    this.managedSkills = managedSkills;
    this.rows = buildUnifiedSkillRows(this.managedSkills, this.loadedSkills, new Set(retainSelectedSkillIds), this.sortMode);
    this.syncQueryFromInput();

    const rows = this.filteredRows;
    if (rows.length === 0) {
      this.selectedIndex = 0;
      return;
    }

    if (focusSkillId) {
      const focusIndex = rows.findIndex((row) => row.skillId === focusSkillId);
      if (focusIndex >= 0) {
        this.selectedIndex = focusIndex;
        return;
      }
    }

    this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
  }

  private toggleSelected(skillId: string): void {
    const row = this.rows.find((entry) => entry.skillId === skillId);
    if (!row) return;
    row.selected = !row.selected;
  }

  private toggleCurrentSelection(): void {
    const row = this.getCurrentRow();
    if (!row) return;
    this.toggleSelected(row.skillId);
    this.summaryLines = [
      `${row.selected ? "Selected" : "Cleared"} ${row.displayName}.`,
    ];
    this.tui.requestRender();
  }

  private selectAllFiltered(): void {
    const rows = this.filteredRows;
    for (const row of rows) {
      row.selected = true;
    }
    this.summaryLines = [
      `Selected ${rows.length} visible skill${rows.length === 1 ? "" : "s"}.`,
    ];
    this.tui.requestRender();
  }

  private clearSelection(): void {
    for (const row of this.rows) {
      row.selected = false;
    }
    this.summaryLines = ["Cleared all selections."];
    this.tui.requestRender();
  }

  private cycleSortMode(): void {
    this.sortMode = nextSortMode(this.sortMode);
    const selectedIds = this.getSelectedIds();
    const currentRow = this.getCurrentRow();
    this.rows = buildUnifiedSkillRows(
      this.managedSkills,
      this.loadedSkills,
      new Set(selectedIds),
      this.sortMode,
    );
    this.syncQueryFromInput();

    const rows = this.filteredRows;
    if (rows.length === 0) {
      this.selectedIndex = 0;
    } else if (currentRow) {
      const focusIndex = rows.findIndex((row) => row.skillId === currentRow.skillId);
      this.selectedIndex = focusIndex >= 0
        ? focusIndex
        : Math.min(this.selectedIndex, rows.length - 1);
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
    }

    this.summaryLines = [`Sort mode: ${sortModeLabel(this.sortMode)}.`];
    this.tui.requestRender();
  }

  private appendExternalReadOnlySummary(
    result: SkillBatchActionResult,
    blockedExternalRows: SkillModalRow[],
    verb: "move" | "delete",
  ): SkillBatchActionResult {
    if (blockedExternalRows.length === 0) return result;

    const blockedIds = blockedExternalRows.map((row) => row.skillId);
    const retainSet = new Set([...(result.retainSelectedSkillIds || []), ...blockedIds]);
    const focusSkillId = result.focusSkillId || blockedIds[0];
    const blockedLabel = blockedExternalRows.length === 1
      ? `Blocked 1 external skill: ${blockedExternalRows[0]!.displayName} is read-only.`
      : `Blocked ${blockedExternalRows.length} external skills: read-only (${verb} unavailable).`;

    return {
      ...result,
      summaryLines: [...result.summaryLines, blockedLabel],
      retainSelectedSkillIds: Array.from(retainSet),
      focusSkillId,
    };
  }

  private prepareMutableSelection(verb: "move" | "delete"):
    | { proceed: false }
    | { proceed: true; mutableIds: string[]; blockedExternalRows: SkillModalRow[] } {
    const selectedRows = this.getSelectedRows();
    if (selectedRows.length === 0) {
      this.summaryLines = ["Select one or more skills first."];
      this.tui.requestRender();
      return { proceed: false };
    }

    const mutableRows = selectedRows.filter((row) => row.mutable);
    const blockedExternalRows = selectedRows.filter((row) => !row.mutable);

    if (mutableRows.length === 0 && blockedExternalRows.length > 0) {
      this.summaryLines = [
        `Blocked ${blockedExternalRows.length} external skill${blockedExternalRows.length === 1 ? "" : "s"}: read-only (${verb} unavailable).`,
      ];
      this.tui.requestRender();
      return { proceed: false };
    }

    return {
      proceed: true,
      mutableIds: mutableRows.map((row) => row.skillId),
      blockedExternalRows,
    };
  }

  private async runMove(targetScope: SkillScope): Promise<void> {
    const selection = this.prepareMutableSelection("move");
    if (!selection.proceed) return;

    const action = this.callbacks.moveSelected(targetScope, selection.mutableIds)
      .then((result) => this.appendExternalReadOnlySummary(result, selection.blockedExternalRows, "move"));

    await this.runAsyncAction(action);
  }

  private promptDelete(): void {
    const selection = this.prepareMutableSelection("delete");
    if (!selection.proceed) return;

    this.pendingDeleteConfirm = { skillIds: selection.mutableIds };
    const blockedCount = selection.blockedExternalRows.length;
    this.summaryLines = [
      `Delete ${selection.mutableIds.length} selected skill${selection.mutableIds.length === 1 ? "" : "s"}? Press y to confirm or n to cancel.${blockedCount > 0 ? ` (${blockedCount} external read-only item${blockedCount === 1 ? "" : "s"} will be skipped)` : ""}`,
    ];
    this.tui.requestRender();
  }

  private async runDeleteConfirmed(skillIds: string[]): Promise<void> {
    const blockedExternalRows = this.rows.filter((row) => row.selected && !row.mutable);
    const action = this.callbacks.deleteSelected(skillIds)
      .then((result) => this.appendExternalReadOnlySummary(result, blockedExternalRows, "delete"));

    await this.runAsyncAction(action);
  }

  private closeModal(): void {
    if (this.closed) return;
    this.closed = true;
    this.callbacks.close();
  }

  private openFilterPanel(): void {
    this.pendingFilters = cloneFilters(this.activeFilters);
    this.filterCursor = 0;
    this.setFocusArea("filters");
    this.summaryLines = ["Filter panel open: space toggle · enter apply · esc cancel."];
    this.tui.requestRender();
  }

  private applyFilterPanel(): void {
    const candidate = ensureValidFilters(this.pendingFilters ? cloneFilters(this.pendingFilters) : cloneFilters(this.activeFilters));
    const wasAllOff = this.pendingFilters
      && !this.pendingFilters.global
      && !this.pendingFilters.project
      && !this.pendingFilters.external;

    this.activeFilters = candidate;
    this.pendingFilters = null;
    this.syncQueryFromInput();
    this.setFocusArea("list");
    this.summaryLines = [
      wasAllOff
        ? "All categories were disabled; restored filters to [G] [P] [E]."
        : `Applied filters: ${filtersLabel(this.activeFilters)}`,
    ];
    this.tui.requestRender();
  }

  private cancelFilterPanel(): void {
    this.pendingFilters = null;
    this.setFocusArea("list");
    this.summaryLines = ["Filter changes cancelled."];
    this.tui.requestRender();
  }

  private handleFilterInput(data: string): void {
    const options = this.getFilterOptions();
    const draft = this.pendingFilters ?? cloneFilters(this.activeFilters);
    this.pendingFilters = draft;

    if (matchesKey(data, Key.escape)) {
      this.cancelFilterPanel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.filterCursor = Math.max(0, this.filterCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.filterCursor = Math.min(options.length - 1, this.filterCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.space)) {
      const option = options[this.filterCursor];
      if (option) {
        draft[option.key] = !draft[option.key];
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.applyFilterPanel();
    }
  }

  private async runAsyncAction(action: Promise<SkillBatchActionResult>): Promise<void> {
    if (this.closed) return;

    this.busy = true;
    this.summaryLines = ["Applying skill changes…"];
    this.tui.requestRender();

    try {
      const result = await action;
      if (this.closed) return;
      this.setRows(result.skills, result.retainSelectedSkillIds, result.focusSkillId);
      this.summaryLines = result.summaryLines;
    } catch (error) {
      if (!this.closed) {
        this.summaryLines = [error instanceof Error ? error.message : String(error)];
      }
    } finally {
      this.busy = false;
      if (!this.closed) {
        this.tui.requestRender();
      }
    }
  }

  private moveSelection(delta: number): void {
    const rows = this.filteredRows;
    if (rows.length === 0) return;
    const next = this.selectedIndex + delta;
    this.selectedIndex = Math.max(0, Math.min(next, rows.length - 1));
    this.tui.requestRender();
  }

  private pageSelection(delta: number): void {
    const pageSize = Math.max(5, this.getMaxVisibleRows() - 1);
    this.moveSelection(delta * pageSize);
  }

  private getMaxVisibleRows(): number {
    return Math.max(6, Math.min(14, this.tui.terminal.rows - 22));
  }

  private focusSearchWithOptionalInput(data?: string): void {
    this.setFocusArea("search");
    if (data) {
      this.searchInput.handleInput(data);
      this.syncQueryFromInput();
      this.tui.requestRender();
    }
  }

  private isPrintableInput(data: string): boolean {
    return data.length === 1 && data >= " " && data !== "\x7f";
  }

  handleInput(data: string): void {
    if (this.closed) return;

    if (this.busy) {
      if (matchesKey(data, Key.escape)) this.closeModal();
      return;
    }

    if (this.pendingDeleteConfirm) {
      if (data === "y" || data === "Y") {
        const pending = this.pendingDeleteConfirm;
        this.pendingDeleteConfirm = null;
        void this.runDeleteConfirmed(pending.skillIds);
        return;
      }

      if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
        this.pendingDeleteConfirm = null;
        this.summaryLines = ["Delete cancelled."];
        this.tui.requestRender();
      }
      return;
    }

    if (this.focusArea === "filters") {
      this.handleFilterInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.closeModal();
      return;
    }

    if (this.focusArea === "search") {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
        this.setFocusArea("list");
        return;
      }

      this.searchInput.handleInput(data);
      this.syncQueryFromInput();
      this.tui.requestRender();
      return;
    }

    if (data === MEMORY_SKILLS_KEYMAP.openFilters) {
      this.openFilterPanel();
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.cycleSort) {
      this.cycleSortMode();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.slash)) {
      this.focusSearchWithOptionalInput();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.pageSelection(-1);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.pageSelection(1);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.selectedIndex = Math.max(0, this.filteredRows.length - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleCurrentSelection();
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.selectAllFiltered) {
      this.selectAllFiltered();
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.clearSelection) {
      this.clearSelection();
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.moveGlobal) {
      void this.runMove("global");
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.moveProject) {
      void this.runMove("project");
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.deleteSelected) {
      this.promptDelete();
      return;
    }
    if (this.isPrintableInput(data) && !["g", "p", "d", "a", "n", "f", "s"].includes(data)) {
      this.focusSearchWithOptionalInput(data);
    }
  }

  private renderFramedLine(content: string, width: number): string {
    const innerWidth = Math.max(10, width - 4);
    const padded = truncateToWidth(content, innerWidth, "");
    const spaces = Math.max(0, innerWidth - visibleWidth(padded));
    return `${this.theme.fg("borderAccent", "│")} ${padded}${" ".repeat(spaces)} ${this.theme.fg("borderAccent", "│")}`;
  }

  private renderWrappedSection(lines: string[], width: number): string[] {
    const rendered: string[] = [];
    const innerWidth = Math.max(10, width - 4);
    for (const line of lines) {
      const wrapped = wrapTextWithAnsi(line, innerWidth);
      if (wrapped.length === 0) {
        rendered.push(this.renderFramedLine("", width));
        continue;
      }
      for (const part of wrapped) {
        rendered.push(this.renderFramedLine(part, width));
      }
    }
    return rendered;
  }

  private renderFilterPanel(width: number): string[] {
    const panelWidth = Math.max(34, Math.min(width - 10, 58));
    const top = this.theme.fg("borderAccent", `┌${"─".repeat(Math.max(1, panelWidth - 2))}┐`);
    const bottom = this.theme.fg("borderAccent", `└${"─".repeat(Math.max(1, panelWidth - 2))}┘`);
    const lines: string[] = [top];

    lines.push(this.renderFramedLine(this.theme.fg("accent", this.theme.bold("Filters")), panelWidth));
    lines.push(this.renderFramedLine(this.theme.fg("dim", "Space toggle · Enter apply · Esc cancel"), panelWidth));
    lines.push(this.renderFramedLine("", panelWidth));

    const draft = this.pendingFilters ?? this.activeFilters;
    const options = this.getFilterOptions();
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!;
      const checked = draft[option.key] ? "[x]" : "[ ]";
      const cursor = i === this.filterCursor ? this.theme.fg("accent", "›") : " ";
      const text = `${cursor} ${checked} ${option.label}`;
      const rendered = i === this.filterCursor
        ? this.theme.bg("selectedBg", truncateToWidth(text, Math.max(10, panelWidth - 4), ""))
        : truncateToWidth(text, Math.max(10, panelWidth - 4), "");
      lines.push(this.renderFramedLine(rendered, panelWidth));
    }

    lines.push(this.renderFramedLine("", panelWidth));
    lines.push(this.renderFramedLine(this.theme.fg("dim", `Draft: ${filtersLabel(draft)}`), panelWidth));
    lines.push(bottom);
    return lines;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(60, width);
    const top = this.theme.fg("borderAccent", `┌${"─".repeat(Math.max(1, safeWidth - 2))}┐`);
    const bottom = this.theme.fg("borderAccent", `└${"─".repeat(Math.max(1, safeWidth - 2))}┘`);
    const lines: string[] = [top];

    const projectName = this.callbacks.projectName ? ` · project: ${this.callbacks.projectName}` : "";
    const title = this.theme.fg("accent", this.theme.bold(`🧠 Procedural Skills${projectName}`));
    lines.push(this.renderFramedLine(title, safeWidth));

    const searchHint = this.focusArea === "search"
      ? this.theme.fg("accent", "search")
      : this.theme.fg("dim", "search");
    const searchLine = this.searchInput.render(Math.max(10, safeWidth - 17))[0] ?? "";
    lines.push(this.renderFramedLine(`${searchHint}: ${searchLine}`, safeWidth));

    const filteredRows = this.filteredRows;
    const selectedCount = this.getSelectedIds().length;
    lines.push(this.renderFramedLine(
      this.theme.fg(
        "dim",
        `${filteredRows.length} visible · ${this.rows.length} total · ${selectedCount} selected · sort: ${sortModeLabel(this.sortMode)}${this.busy ? " · working…" : ""}`,
      ),
      safeWidth,
    ));

    lines.push(this.renderFramedLine(this.theme.fg("dim", `Legend: [G] global · [P] project · [E] external (read-only) · filters: ${filtersLabel(this.activeFilters)}`), safeWidth));
    lines.push(this.renderFramedLine("", safeWidth));

    if (filteredRows.length === 0) {
      const emptyMessage = this.rows.length === 0 ? "No skills found yet." : "No skills match the current filters/search.";
      lines.push(this.renderFramedLine(this.theme.fg("warning", emptyMessage), safeWidth));
      lines.push(this.renderFramedLine("", safeWidth));
    } else {
      const maxVisible = this.getMaxVisibleRows();
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), filteredRows.length - maxVisible));
      const end = Math.min(filteredRows.length, start + maxVisible);
      const visibleRows = filteredRows.slice(start, end);

      for (let i = 0; i < visibleRows.length; i++) {
        const row = visibleRows[i]!;
        const absoluteIndex = start + i;
        const cursor = absoluteIndex === this.selectedIndex ? this.theme.fg("accent", "›") : " ";
        const check = row.selected ? this.theme.fg("accent", "[x]") : this.theme.fg("dim", "[ ]");
        const category = row.category === "G"
          ? this.theme.fg("accent", "[G]")
          : row.category === "P"
            ? this.theme.fg("warning", "[P]")
            : this.theme.fg("dim", "[E]");

        const baseText = `${cursor} ${check} ${category} ${row.displayName} (${row.displayPath})`;
        const lineText = absoluteIndex === this.selectedIndex
          ? this.theme.bg("selectedBg", truncateToWidth(baseText, Math.max(10, safeWidth - 4), ""))
          : truncateToWidth(baseText, Math.max(10, safeWidth - 4), "");
        lines.push(this.renderFramedLine(lineText, safeWidth));
      }

      if (start > 0 || end < filteredRows.length) {
        lines.push(this.renderFramedLine(this.theme.fg("dim", `Showing ${start + 1}-${end} of ${filteredRows.length}`), safeWidth));
      }

      lines.push(this.renderFramedLine("", safeWidth));
      const currentRow = this.getCurrentRow();
      if (currentRow) {
        const scopeLabel = currentRow.category === "E"
          ? "external (read-only)"
          : currentRow.scope === "project"
            ? "project"
            : "global";
        lines.push(this.renderFramedLine(this.theme.fg("accent", `Focused: ${currentRow.displayName} · ${scopeLabel}`), safeWidth));
        lines.push(...this.renderWrappedSection([
          currentRow.description || "(no description)",
          this.theme.fg("dim", currentRow.skillId),
          this.theme.fg("dim", currentRow.displayPath),
        ], safeWidth));
      }
    }

    lines.push(this.renderFramedLine("", safeWidth));
    lines.push(this.renderFramedLine(this.theme.fg("accent", "Last action"), safeWidth));
    lines.push(...this.renderWrappedSection(this.summaryLines, safeWidth));
    lines.push(this.renderFramedLine("", safeWidth));

    const help = this.pendingDeleteConfirm
      ? "Confirm delete: y yes · n no · esc cancel"
      : this.callbacks.projectName
        ? "↑↓ move · space select · / search · s sort · f filters · tab switch · g global · p project · d delete · a all · n none · esc close"
        : "↑↓ move · space select · / search · s sort · f filters · tab switch · g global · p project (disabled) · d delete · a all · n none · esc close";
    lines.push(this.renderFramedLine(this.theme.fg("dim", help), safeWidth));

    if (this.focusArea === "filters") {
      lines.push(this.renderFramedLine("", safeWidth));
      for (const panelLine of this.renderFilterPanel(Math.min(64, safeWidth - 6))) {
        lines.push(this.renderFramedLine(panelLine, safeWidth));
      }
    }

    lines.push(bottom);
    return lines;
  }
}

export function registerSkillsCommand(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerCommand("memory-skills", {
    description: "Manage global, active-project, and loaded external procedural skills",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const getSkillCommands = (): SkillCommandInfo[] => {
        const readCommands = (owner: unknown): SkillCommandInfo[] | null => {
          try {
            const getter = (owner as { getCommands?: () => unknown })?.getCommands;
            if (typeof getter !== "function") return null;
            const commands = getter.call(owner);
            return Array.isArray(commands) ? commands as SkillCommandInfo[] : [];
          } catch {
            return null;
          }
        };

        return readCommands(pi)
          ?? readCommands(ctx)
          ?? [];
      };

      const managedSkills = await store.loadIndex();
      const loadedSkills = collectLoadedSkillsFromCommands(getSkillCommands());
      const initialRows = buildUnifiedSkillRows(managedSkills, loadedSkills);
      const projectName = store.getProjectName();

      if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
        ctx.ui.notify(formatSkillsList(initialRows, projectName), "info");
        return;
      }

      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => new SkillsManagerModal(
            tui,
            theme,
            initialRows,
            {
              moveSelected: (scope, skillIds) => moveSelectedSkills(store, skillIds, scope),
              deleteSelected: (skillIds) => deleteSelectedSkills(store, skillIds),
              close: () => done(undefined),
              projectName,
            },
            {
              managedSkills,
              loadedSkills,
            },
          ),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "92%",
              minWidth: 76,
              maxHeight: "88%",
              margin: 1,
            },
          },
        );
      } catch {
        const latestManagedSkills = await store.loadIndex();
        const latestRows = buildUnifiedSkillRows(
          latestManagedSkills,
          collectLoadedSkillsFromCommands(getSkillCommands()),
        );
        ctx.ui.notify(
          "Interactive skills manager unavailable in this runtime; showing read-only list fallback.",
          "warning",
        );
        ctx.ui.notify(formatSkillsList(latestRows, projectName), "info");
      }
    },
  });
}
