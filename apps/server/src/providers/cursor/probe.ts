/** Pure parsers for cursor-agent probe output. */

export function parseAuthFromStatus(output: string): boolean | null {
  const lower = output.toLowerCase();
  // Negative phrases first: "not logged in" contains "logged in".
  if (isAuthFailure(lower) || /\bnot (signed|logged) in\b/.test(lower)) return false;
  if (/\b(logged|signed) in\b/.test(lower)) return true;
  return null;
}

/** True when CLI output says the user must sign in (status, --list-models or a turn). */
export function isAuthFailure(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("authentication required") ||
    lower.includes("authentication is required") ||
    lower.includes("run 'agent login'") ||
    lower.includes("please run 'agent login'")
  );
}

export function parseModelsFromList(output: string): Array<{ id: string; label: string }> {
  const models: Array<{ id: string; label: string }> = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Available")) continue;
    const dash = trimmed.indexOf(" - ");
    if (dash === -1) continue;
    const id = trimmed.slice(0, dash).trim();
    const label = trimmed.slice(dash + 3).trim();
    if (id) models.push({ id, label });
  }
  return models;
}
