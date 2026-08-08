export function shouldWarnAutoConsolidationFailure(
  warnOnFailure: boolean,
  consolidated: boolean,
): boolean {
  return !consolidated && warnOnFailure;
}
