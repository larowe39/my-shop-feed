import * as SecureStore from "expo-secure-store";

const RECENT_SEARCHES_KEY = "penchant.recent-searches";
const MAX_RECENT_SEARCHES = 8;

export async function loadRecentSearches(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(RECENT_SEARCHES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export async function saveRecentSearch(query: string): Promise<string[]> {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) return loadRecentSearches();
  const current = await loadRecentSearches();
  const next = [
    normalized,
    ...current.filter((item) => item.toLowerCase() !== normalized.toLowerCase()),
  ].slice(0, MAX_RECENT_SEARCHES);
  await persistRecentSearches(next);
  return next;
}

export async function removeRecentSearch(query: string): Promise<string[]> {
  const next = (await loadRecentSearches()).filter((item) => item !== query);
  await persistRecentSearches(next);
  return next;
}

export async function clearRecentSearches(): Promise<void> {
  await persistRecentSearches([]);
}

async function persistRecentSearches(searches: string[]) {
  try {
    await SecureStore.setItemAsync(RECENT_SEARCHES_KEY, JSON.stringify(searches));
  } catch {
    return;
  }
}