export function shouldWarnAutoConsolidationFailure(
  warnOnFailure: boolean,
  consolidated: boolean,
  partial = false,
): boolean {
  return warnOnFailure && (!consolidated || partial);
}
