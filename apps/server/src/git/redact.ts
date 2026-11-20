const GH_TOKEN =
  /\b(ghp_[A-Za-z0-9_]+|gho_[A-Za-z0-9_]+|ghs_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g;

/** Strip credentials from CLI stderr/stdout before it reaches clients. */
export function redactCliError(text: string): string {
  let out = text.replace(GH_TOKEN, "[redacted]");
  out = out.replace(/(?<scheme>https?:\/\/)[^/\s@]+@/gi, "$<scheme>");
  return out;
}
