export function isValidMaxTokens(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function isValidUsedTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Providers that do not report context occupancy display 0%. */
export function resolveContextDisplayPercentage(
  maxTokens: number | null,
  usedTokens: number | null,
): number {
  if (
    maxTokens === null ||
    usedTokens === null ||
    !isValidMaxTokens(maxTokens) ||
    !isValidUsedTokens(usedTokens)
  ) {
    return 0;
  }
  return (usedTokens / maxTokens) * 100;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}
