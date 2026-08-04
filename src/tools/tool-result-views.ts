import type { SharedOutputView } from "./shared-output-view.js";
import { normalizeSharedOutputView } from "./shared-output-view.js";

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function resultData(result: unknown): Record<string, any> | null {
  const resultRecord = record(result);
  const details = record(resultRecord?.details);
  if (details && Object.keys(details).length > 0) return details;

  const content = resultRecord?.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const text = record(content[0])?.text;
  if (typeof text !== "string" || !text.trimStart().startsWith("{")) return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function warningText(data: Record<string, any>): string | null {
  const warnings = Array.isArray(data.warnings)
    ? data.warnings.filter((value: unknown) => typeof value === "string" && value.trim())
    : [];
  return firstText(data.warning, ...warnings);
}

export function memoryResultView(result: unknown): SharedOutputView {
  const base = normalizeSharedOutputView(result);
  const data = resultData(result);
  if (!data) return base;

  if (data.success === false || (data.success !== true && firstText(data.error))) {
    const failureReason = firstText(data.error, data.message);
    return { ...base, status: "failure", summary: failureReason ? `Error · ${failureReason}` : "Error" };
  }
  if (data.success !== true) return base;

  const primaryMessage = (firstText(data.message) ?? "").split(/\s*\bWarning:/)[0].trim();
  const evicted = typeof data.evicted_count === "number"
    ? data.evicted_count
    : Array.isArray(data.evicted_entries)
      ? data.evicted_entries.length
      : 0;
  const outcome = /^Entry added\.$/.test(primaryMessage) || /^Failure memory saved:/.test(primaryMessage) || evicted > 0
    ? "Saved"
    : /^Entry replaced\.$/.test(primaryMessage)
      ? "Replaced"
      : /^Entry removed\.$/.test(primaryMessage)
        ? "Removed"
        : /^Entry already exists/.test(primaryMessage)
          ? "Unchanged"
          : "Updated";
  const parts = [outcome];
  if (typeof data.target === "string" && data.target.trim()) parts.push(`target: ${data.target.trim()}`);
  if (typeof data.category === "string" && data.category.trim()) parts.push(`category: ${data.category.trim()}`);
  if (evicted > 0) parts.push(`evicted: ${evicted}`);
  if (typeof data.entry_count === "number") parts.push(`${data.entry_count} ${data.entry_count === 1 ? "entry" : "entries"}`);
  if (typeof data.usage === "string" && data.usage.trim()) parts.push(data.usage.trim());
  const warning = warningText(data);
  if (warning) parts.push(`Warning: ${warning}`);
  return { ...base, status: "success", summary: parts.join(" · ") };
}

export function searchResultView(result: unknown): SharedOutputView {
  const base = normalizeSharedOutputView(result);
  const data = resultData(result);
  if (!data || data.success === false) return base;
  if (typeof data.count === "number") {
    return { ...base, summary: data.count === 1 ? "Found 1 result" : `Found ${data.count} results` };
  }
  return base;
}

export function skillResultView(result: unknown): SharedOutputView {
  const base = normalizeSharedOutputView(result);
  const data = resultData(result);
  if (!data) return base;
  if (data.success === false) {
    const failureReason = firstText(data.error, data.message);
    return { ...base, status: "failure", summary: failureReason ? `Error · ${failureReason}` : "Error" };
  }
  if (Array.isArray(data.skills)) return { ...base, summary: `Skills: ${data.skills.length} available` };

  const name = firstText(data.displayName, data.name, data.skillId, data.skill_id);
  if (name) return { ...base, summary: `Skill: ${name}` };
  return { ...base, summary: firstText(data.message) ?? "Skill updated" };
}
