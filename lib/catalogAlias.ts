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
  productName: string;
  modelNumber?: string | null;
}): Array<{ alias: string; normalizedAlias: string }> {
  const entries: Array<{ alias: string; normalizedAlias: string }> = [];
  const seen = new Set<string>();
  for (const alias of [...(candidate.aliases ?? []), candidate.productName, candidate.modelNumber ?? ""]) {
    const normalizedAlias = normalizeAliasConflictKey(alias);
    if (!alias || !normalizedAlias || seen.has(normalizedAlias)) continue;
    seen.add(normalizedAlias);
    entries.push({ alias, normalizedAlias });
  }
  return entries;
}
