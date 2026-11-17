/** Pure parsers for cursor-agent probe output. */

export function parseAuthFromStatus(output: string): boolean | null {
  const lower = output.toLowerCase();
  if (lower.includes("logged in") || lower.includes("✓") || /\bsigned in\b/.test(lower)) {
    return true;
  }
  if (
    lower.includes("login") ||
    lower.includes("authentication is required") ||
    lower.includes("not signed in") ||
    lower.includes("not logged in")
  ) {
    return false;
  }
  return null;
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
