import { keyHint, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import stripAnsi from "strip-ansi";
import {
  Text,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

export type SharedStatus = "success" | "failure" | "empty";

export interface SharedOutputView {
  summary: string;
  expandedText: string;
  status: SharedStatus;
}

interface SharedOutputTheme {
  fg?: (color: any, text: string) => string;
  getBgAnsi?: (color: any) => string;
}

type ToolCardBackground = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
}

function sanitizeDisplayText(text: string): string {
  return stripAnsi(text).replace(/[\p{Cc}\p{Cs}\uFFF9-\uFFFB]/gu, (character) =>
    character === "\n" || character === "\t" ? character : ""
  );
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function reason(details: Record<string, unknown> | null): string {
  for (const value of [details?.error, details?.message, details?.reason]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function normalizeSharedOutputView(input: unknown): SharedOutputView {
  const result = record(input);
  const details = record(result?.details);
  const expandedText = sanitizeDisplayText(textBlocks(result?.content).join("\n"));
  const detailsReason = sanitizeDisplayText(reason(details));
  const failure = result?.isError === true || details?.success === false || details?.isError === true;
  const status: SharedStatus = failure ? "failure" : expandedText.trim() ? "success" : "empty";
  const summary = failure
    ? detailsReason || firstLine(expandedText) || "Error"
    : firstLine(expandedText) || detailsReason || "No output";
  return { summary, expandedText, status };
}

function themed(
  theme: SharedOutputTheme | undefined,
  status: SharedStatus,
  partial: boolean,
  text: string,
): string {
  if (typeof theme?.fg !== "function") return text;
  const color = partial ? "warning" : status === "failure" ? "error" : status === "empty" ? "muted" : "toolOutput";
  return theme.fg(color, text);
}

function restoreBackground(
  text: string,
  background: ToolCardBackground,
  theme: SharedOutputTheme | undefined,
): string {
  if (typeof theme?.getBgAnsi !== "function") return text;
  const backgroundAnsi = theme.getBgAnsi(background);
  return text.replace(/\x1b\[[0-?]*[ -/]*m/g, `$&${backgroundAnsi}`);
}

function compactSummary(summary: string, width: number, preserveTail: boolean): string {
  if (visibleWidth(summary) <= width) return summary;
  if (!preserveTail || width < 13) return truncateToWidth(summary, width, "…");

  const tailWidth = Math.max(6, Math.floor(width / 2));
  const headWidth = Math.max(3, width - tailWidth - 1);
  const fullWidth = visibleWidth(summary);
  return `${sliceByColumn(summary, 0, headWidth, true)}…${sliceByColumn(
    summary,
    Math.max(0, fullWidth - tailWidth),
    tailWidth,
    true,
  )}`;
}

function renderView(
  view: SharedOutputView,
  options: ToolRenderResultOptions,
  theme: SharedOutputTheme | undefined,
  background: ToolCardBackground,
): Component {
  if (options.expanded) {
    return new Text(
      view.expandedText || view.summary,
      0,
      0,
      (line) => restoreBackground(line, background, theme),
    );
  }

  return {
    render(width: number): string[] {
      const availableWidth = Math.max(1, width);
      const partialPrefix = options.isPartial && !/progress|partial|in progress|处理中/i.test(view.summary)
        ? "In progress: "
        : "";
      const fullSummary = `${partialPrefix}${view.summary}`;
      const hasHiddenText = view.expandedText.trim() !== view.summary.trim();
      const hint = hasHiddenText ? ` (${keyHint("app.tools.expand", "to expand")})` : "";
      const hintWidth = visibleWidth(hint);
      const visibleHint = hintWidth < availableWidth ? hint : "";
      const summaryWidth = Math.max(1, availableWidth - visibleWidth(visibleHint));
      const summary = compactSummary(
        fullSummary,
        summaryWidth,
        view.status === "failure" || /warning/i.test(fullSummary),
      );
      const line = themed(theme, view.status, options.isPartial, `${summary}${visibleHint}`);
      return [restoreBackground(line, background, theme)];
    },
    invalidate(): void {},
  };
}

export function createSharedToolResultRenderer(
  adapt: (result: unknown) => SharedOutputView = normalizeSharedOutputView,
) {
  return (
    result: unknown,
    options: ToolRenderResultOptions,
    theme: SharedOutputTheme,
    context?: { isError?: boolean },
  ): Component => {
    const adapted = adapt(result);
    const displayView = {
      ...adapted,
      summary: sanitizeDisplayText(adapted.summary),
      expandedText: sanitizeDisplayText(adapted.expandedText),
    };
    const view = context?.isError ? { ...displayView, status: "failure" as const } : displayView;
    const background: ToolCardBackground = options.isPartial
      ? "toolPendingBg"
      : context?.isError
        ? "toolErrorBg"
        : "toolSuccessBg";
    return renderView(view, options, theme, background);
  };
}
