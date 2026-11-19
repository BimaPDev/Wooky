const MODEL_ID_MAX = 200;

/** One id per non-empty line. Blank lines and lines with spaces are skipped. */
export function parseOpenCodeModels(stdout: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const id = line.trim();
    if (!id || /\s/.test(id) || id.length > MODEL_ID_MAX || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function parseOpenCodeVersion(stdout: string, stderr: string): string | null {
  const raw = (stdout.trim() || stderr.trim()).split(/\r?\n/)[0]?.trim() ?? "";
  if (!raw) return null;
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(raw);
  return match?.[1] ?? raw;
}

export function openCodeArgs(
  prefix: readonly string[],
  extraArgs: readonly string[],
): { version: string[]; models: string[]; acp: string[] } {
  return {
    version: [...prefix, "--version"],
    models: [...prefix, "models"],
    acp: [...prefix, "acp", ...extraArgs],
  };
}
