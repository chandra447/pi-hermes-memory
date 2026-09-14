import {
  CORRECTION_DIRECTIVE_WORDS,
  CORRECTION_NEGATIVE_PATTERNS,
  CORRECTION_STRONG_PATTERNS,
  CORRECTION_WEAK_PATTERNS,
} from "./constants.js";
import { getMessageText, type MemoryConfig } from "./types.js";

export interface LazyEventState {
  userTurnCount: number;
  turnsSinceReview: number;
  toolCallsSinceReview: number;
}

type CorrectionPatternConfig = Pick<MemoryConfig,
  "correctionStrongPatterns" |
  "correctionWeakPatterns" |
  "correctionNegativePatterns" |
  "correctionDirectiveWords"
>;

function compileCorrectionPatterns(configured: string[] | undefined, defaults: RegExp[]): RegExp[] {
  if (configured === undefined) return defaults;
  const patterns: RegExp[] = [];
  for (const source of configured) {
    try {
      patterns.push(new RegExp(source, "i"));
    } catch {
      // Invalid configured expressions do not disable the remaining valid ones.
    }
  }
  return patterns;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDirectiveWord(remainder: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const source = words.map(escapeRegexLiteral).join("|");
  return new RegExp(`\\b(${source})\\b`, "i").test(remainder);
}

export function isCorrection(text: string, config?: CorrectionPatternConfig): boolean {
  for (const pattern of compileCorrectionPatterns(config?.correctionNegativePatterns, CORRECTION_NEGATIVE_PATTERNS)) {
    if (pattern.test(text)) return false;
  }
  for (const pattern of compileCorrectionPatterns(config?.correctionStrongPatterns, CORRECTION_STRONG_PATTERNS)) {
    if (pattern.test(text)) return true;
  }
  for (const pattern of compileCorrectionPatterns(config?.correctionWeakPatterns, CORRECTION_WEAK_PATTERNS)) {
    const match = pattern.exec(text);
    if (match && match.index === 0) {
      const remainder = text.slice(match[0].length).trim();
      if (hasDirectiveWord(remainder, config?.correctionDirectiveWords ?? CORRECTION_DIRECTIVE_WORDS)) return true;
    }
  }
  return false;
}

/** Lightweight counters that decide whether a cold policy-only runtime is needed. */
export function createLazyEventQualifier(config: MemoryConfig) {
  let state: LazyEventState = {
    userTurnCount: 0,
    turnsSinceReview: 0,
    toolCallsSinceReview: 0,
  };
  let stateBeforeLastEvent = { ...state };

  const qualifies = (name: string, event: any): boolean => {
    stateBeforeLastEvent = { ...state };

    if (name === "message_end") {
      if (event.message?.role !== "user") return false;
      state.userTurnCount++;
      const text = getMessageText(event.message);
      return config.correctionDetection && text !== null && isCorrection(text, config);
    }

    if (name === "turn_end") {
      state.turnsSinceReview++;
      if (event.message?.role === "assistant" && Array.isArray(event.message.content)) {
        state.toolCallsSinceReview += event.message.content.filter((part: any) => part?.type === "toolCall").length;
      }
      if (!config.reviewEnabled || state.userTurnCount < 3) return false;
      return state.turnsSinceReview >= config.nudgeInterval || state.toolCallsSinceReview >= config.nudgeToolCalls;
    }

    if (name === "session_before_compact") {
      return config.flushOnCompact && state.userTurnCount >= config.flushMinTurns;
    }

    if (name === "session_shutdown") {
      return event.reason !== "reload" && config.flushOnShutdown && state.userTurnCount >= config.flushMinTurns;
    }

    return false;
  };

  return Object.assign(qualifies, {
    getState: (): LazyEventState => ({ ...state }),
    getStateBeforeLastEvent: (): LazyEventState => ({ ...stateBeforeLastEvent }),
    resetReviewCounters: (): void => {
      state = { ...state, turnsSinceReview: 0, toolCallsSinceReview: 0 };
    },
  });
}
