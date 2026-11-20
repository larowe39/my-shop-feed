// scripts/lib/cliArgs.js
// Small shared helper so every catalog-* CLI script parses --flag=value and
// --flag value forms consistently (npm run x -- --backend=local both work).
function getFlagValue(args, flagName) {
  const eqPrefix = `${flagName}=`;
  const eqArg = args.find((arg) => arg.startsWith(eqPrefix));
  if (eqArg) return eqArg.slice(eqPrefix.length);
  const index = args.indexOf(flagName);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith("--")) return args[index + 1];
  return null;
}

function parseBoundedApplyLimit(args) {
  const explicit = args.some((arg) => arg === "--limit" || arg.startsWith("--limit="));
  const raw = getFlagValue(args, "--limit");
  if (!explicit || raw === null || raw.trim() === "" || !/^\d+$/.test(raw)) {
    throw new Error("Refusing apply: provide an explicit integer --limit between 1 and 100.");
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Refusing apply: provide an explicit integer --limit between 1 and 100.");
  }
  return limit;
}

module.exports = { getFlagValue, parseBoundedApplyLimit };
