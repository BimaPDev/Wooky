import {
  BRAIN_BODY_MAX_BYTES,
  BRAIN_MAX_SEGMENTS,
  BRAIN_OVERVIEW_FILE,
  BRAIN_SUMMARY_MAX,
  BrainKind,
  formatBrainUri,
  isBrainMemoryPath,
  isBrainSegment,
  parseBrainPath,
  parseBrainUri,
  type BrainKind as BrainKindValue,
} from "@wooky/contracts";

const TAG_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 40;

const utf8Encoder = new TextEncoder();

export const BRAIN_KINDS: readonly { value: BrainKindValue; label: string }[] = [
  { value: "preference", label: "Preference" },
  { value: "decision", label: "Decision" },
  { value: "convention", label: "Convention" },
  { value: "gotcha", label: "Gotcha" },
  { value: "lesson", label: "Lesson" },
  { value: "playbook", label: "Playbook" },
  { value: "provider-note", label: "Provider note" },
  { value: "note", label: "Note" },
];

export function brainKindLabel(kind: BrainKindValue): string {
  return BRAIN_KINDS.find((entry) => entry.value === kind)?.label ?? kind;
}

export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

/**
 * Validates a scope-relative memory path against the rules in `docs/brain.md`.
 * Returns a human-readable error message, or `null` when valid.
 */
export function validateBrainMemoryPath(raw: string): string | null {
  const path = raw.trim();
  if (!path) return "Enter a memory path, for example lessons/pnpm.md";
  if (path.startsWith("/") || path.includes("\\")) {
    return "Use a relative path separated by /, without leading slashes or backslashes.";
  }
  if (path.includes("%")) {
    return "Path cannot contain % characters.";
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) {
    return "Path cannot contain empty segments (// or trailing /).";
  }
  if (segments.length > BRAIN_MAX_SEGMENTS) {
    return `Path can have at most ${BRAIN_MAX_SEGMENTS} segments.`;
  }
  for (const [index, segment] of segments.entries()) {
    if (segment === BRAIN_OVERVIEW_FILE) {
      return `${BRAIN_OVERVIEW_FILE} is reserved for folder overviews.`;
    }
    if (segment.includes("..")) {
      return "Path segments cannot contain ..";
    }
    if (segment.startsWith(".") || segment.endsWith(".")) {
      return "Path segments cannot start or end with a dot.";
    }
    if (!isBrainSegment(segment)) {
      return "Each segment must be lowercase a-z, 0-9, ., _, - (up to 64 characters) and not a reserved device name.";
    }
    if (segment.endsWith(".md") && index < segments.length - 1) {
      return "Only the final file name may end in .md, not a folder segment.";
    }
  }
  if (!path.endsWith(".md")) {
    return "A memory path must end in .md, for example conventions/tooling.md";
  }
  if (!isBrainMemoryPath(path) || parseBrainPath(path) === null) {
    return "Invalid memory path.";
  }
  return null;
}

export function validateBrainTags(raw: string): { tags: string[]; error: string | null } {
  const parts = raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  if (unique.length > MAX_TAGS) {
    return { tags: unique, error: `Use at most ${MAX_TAGS} tags.` };
  }
  for (const tag of unique) {
    if (tag.length > MAX_TAG_LENGTH) {
      return { tags: unique, error: `Tag "${tag}" exceeds ${MAX_TAG_LENGTH} characters.` };
    }
    if (!TAG_PATTERN.test(tag)) {
      return {
        tags: unique,
        error: `Tag "${tag}" must start with a-z or 0-9 and use only lowercase letters, digits, ., _, :, -.`,
      };
    }
  }
  return { tags: unique, error: null };
}

export function validateMemoryDraft(input: {
  path?: string;
  isNew?: boolean;
  summary: string;
  kind: BrainKindValue;
  tagsRaw: string;
  body: string;
}): string | null {
  if (input.isNew) {
    const pathError = validateBrainMemoryPath(input.path ?? "");
    if (pathError) return pathError;
  }
  if (!BrainKind.safeParse(input.kind).success) {
    return "Select a valid memory kind.";
  }
  const summary = input.summary.trim();
  if (!summary) {
    return "Summary is required.";
  }
  if (/[\r\n]/.test(summary)) {
    return "Summary must be a single line.";
  }
  if (summary.length > BRAIN_SUMMARY_MAX) {
    return `Summary must be at most ${BRAIN_SUMMARY_MAX} characters (currently ${summary.length}).`;
  }
  const { error: tagError } = validateBrainTags(input.tagsRaw);
  if (tagError) return tagError;

  const bytes = utf8ByteLength(input.body);
  if (bytes > BRAIN_BODY_MAX_BYTES) {
    return `Body exceeds the ${Math.round(BRAIN_BODY_MAX_BYTES / 1024)} KB limit (${bytes} bytes).`;
  }
  return null;
}

export function validateGlobalTargetUri(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("brain://global/")) {
    return "Inbox target must be a brain://global/<path>.md URI.";
  }
  const parsed = parseBrainUri(trimmed);
  if (!parsed || parsed.scope.kind !== "global") {
    return "Target URI is not a valid global brain URI.";
  }
  return validateBrainMemoryPath(parsed.path);
}

/** Returns the folder URI containing a memory URI, or `null` if the URI is already a folder/invalid. */
export function parentFolderUri(uri: string): string | null {
  const parsed = parseBrainUri(uri);
  if (!parsed || parsed.segments.length === 0) return null;
  const folderPath = parsed.segments.slice(0, -1).join("/");
  return formatBrainUri(parsed.scope, folderPath);
}

export function formatBrainTime(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
