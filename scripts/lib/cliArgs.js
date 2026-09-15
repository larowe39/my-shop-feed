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

module.exports = { getFlagValue };
