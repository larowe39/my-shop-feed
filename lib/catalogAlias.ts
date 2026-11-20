// Shared staged/canonical alias identity rules.
export function normalizeAliasConflictKey(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildStagedAliasEntries(candidate: {
  aliases?: string[];
  brand?: string | null;
  productName: string;
  modelNumber?: string | null;
}): Array<{ alias: string; normalizedAlias: string }> {
  const brandKey = normalizeAliasConflictKey(candidate.brand);
  const entriesByKey = new Map<string, string>();
  for (const alias of [...(candidate.aliases ?? []), candidate.productName, candidate.modelNumber ?? ""]) {
    const normalizedAlias = normalizeAliasConflictKey(alias);
    if (!alias || !normalizedAlias || normalizedAlias === brandKey) continue;
    const existingAlias = entriesByKey.get(normalizedAlias);
    if (!existingAlias || alias.localeCompare(existingAlias) < 0) entriesByKey.set(normalizedAlias, alias);
  }
  return [...entriesByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([normalizedAlias, alias]) => ({ alias, normalizedAlias }));
}
