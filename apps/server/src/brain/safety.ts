import { BRAIN_BODY_MAX_BYTES } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";

interface SecretPattern {
  name: string;
  /** Linear time: every repetition is bounded, and a start is anchored so it cannot be retried inside a run. */
  pattern: RegExp;
  /** Receives the match groups; return false to treat the match as ordinary text. */
  accept?: (match: RegExpExecArray) => boolean;
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const hasLetterAndDigit = (value: string) => /[A-Za-z]/.test(value) && /[0-9]/.test(value);
const hasMixedCaseAndDigit = (value: string) =>
  /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);

/**
 * What a template or an example puts where a password goes: `${DB_PASS}`, `$DB_PASS`,
 * `<password>`, `{{DB_PASS}}`, `%(db_pass)s`, `%DB_PASS%`, or a run of `*`, `x` or `.`. A leading
 * `%` or `$` alone is not enough: `%40Xq7m…` is a percent-encoded real password.
 */
const PLACEHOLDER_PASSWORD =
  /^(?:\$\{[^}]{1,64}\}|<[^>]{1,64}>|\{\{[^}]{1,64}\}\}|%\([A-Za-z_][A-Za-z0-9_]{0,63}\)[sdi]|\*+|x+|\.+)$/i;
/** `$DB_PASS`, `%DB_PASS%`: an environment variable name, which a random secret is not. */
const VARIABLE_PASSWORD = /^(?:\$[A-Za-z_][A-Za-z0-9_]{0,63}|%[A-Za-z_][A-Za-z0-9_]{0,63}%)$/;
/** Passwords people put in examples and local dev setups, compared in lowercase. */
const PLACEHOLDER_WORDS = new Set([
  "password",
  "pass",
  "secret",
  "changeme",
  "guest",
  "root",
  "example",
  "test",
]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** `localhost:5432` -> `localhost`; `[::1]:5432` -> `::1`. */
function hostName(authority: string): string {
  const lower = authority.toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end === -1 ? lower : lower.slice(1, end);
  }
  const colon = lower.indexOf(":");
  return colon === -1 ? lower : lower.slice(0, colon);
}

const looksRandom = (value: string) =>
  value.length >= 16 && hasLetterAndDigit(value) && entropy(value) >= 3.5;

/** `XApiKeyHeaderName`, `apiKeyHeaderName`: two or more capitalised words, code and not a key. */
const CAMEL_CASE_IDENTIFIER = /^(?:[a-z]+|[A-Z]+)?(?:[A-Z][a-z]{2,}){2,}$/;

/*
 * A scan runs on attacker-influenced text, so no pattern may backtrack badly. The rules here:
 * every `+` or `*` is a bounded `{m,n}`; a pattern that starts inside a run of its own
 * character class is anchored with a lookbehind so it starts once per run, not once per
 * character; and the text is scanned one line at a time in bounded windows.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/g },
  { name: "GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g },
  { name: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,128}/g },
  { name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,256}/g },
  {
    name: "API key (sk-)",
    pattern: /\bsk-[A-Za-z0-9_-]{24,256}/g,
    accept: (match) => hasLetterAndDigit(match[0]),
  },
  { name: "Stripe key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,128}/g },
  { name: "Google API key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g },
  { name: "npm token", pattern: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g },
  { name: "Hugging Face token", pattern: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,128}/g },
  { name: "SendGrid key", pattern: /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },
  { name: "Slack token", pattern: /\bxox[a-z]-[A-Za-z0-9-]{10,256}/g },
  {
    name: "Slack webhook",
    pattern:
      /hooks\.slack\.com\/services\/[A-Za-z0-9]{6,32}\/[A-Za-z0-9]{6,32}\/[A-Za-z0-9]{16,64}/g,
  },
  { name: "private key", pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g },
  {
    name: "JWT",
    pattern:
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,512}\.eyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}/g,
  },
  {
    name: "URL with credentials",
    pattern:
      /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{1,15}:\/\/([^\s:@/?#]{0,64}):([^\s@/?#]{1,128})@([^\s/?#]{1,255})/gi,
    accept: (match) => {
      const user = (match[1] ?? "").toLowerCase();
      const password = match[2] ?? "";
      const lower = password.toLowerCase();
      const authority = match[3] ?? "";
      if (PLACEHOLDER_PASSWORD.test(password)) return false;
      if (VARIABLE_PASSWORD.test(password) && !looksRandom(password)) return false;
      if (PLACEHOLDER_WORDS.has(lower)) return false;
      // `user:user@host` is an example; a long random string used twice is a real secret.
      if (lower === user && !looksRandom(password)) return false;
      // A password to a local service is a dev default unless it looks like a real secret. A
      // second `@` means the real host comes after it (`app:pw@localhost:1@db.prod`: URL
      // parsers take the host after the last `@`), so `localhost` here is just part of a password.
      if (
        !authority.includes("@") &&
        LOCAL_HOSTS.has(hostName(authority)) &&
        !looksRandom(password)
      ) {
        return false;
      }
      return true;
    },
  },
  {
    name: "bearer token",
    pattern:
      /\bauthorization["']?\s{0,3}[:=]\s{0,3}["']?bearer\s{1,3}([A-Za-z0-9._~+/=-]{16,512})/gi,
    accept: (match) => {
      const value = match[1] ?? "";
      return hasLetterAndDigit(value) && entropy(value) >= 3;
    },
  },
  {
    name: "credential assignment",
    pattern:
      /(?:password|passwd|secret|token|api[_ -]?key)[A-Za-z0-9_-]{0,32}["']?\s{0,16}[:=]\s{0,16}(?:[|>][-+]?\s{0,16})?["']?([A-Za-z0-9+/_=.!@#$%^&*~-]{16,256})/gi,
    accept: (match) => {
      const value = match[1] ?? "";
      return hasLetterAndDigit(value) && entropy(value) >= 3.5;
    },
  },
  {
    name: "API key assignment",
    pattern:
      /api[_ -]?key[A-Za-z0-9_-]{0,32}["']?\s{0,16}[:=]\s{0,16}(?:[|>][-+]?\s{0,16})?["']?([A-Za-z]{16,256})(?![A-Za-z0-9+/_=.-])/gi,
    accept: (match) => {
      const value = match[1] ?? "";
      return entropy(value) >= 3.5 && !CAMEL_CASE_IDENTIFIER.test(value);
    },
  },
  {
    name: "AWS secret key",
    pattern:
      /aws[\w ._-]{0,30}secret[\w ._-]{0,30}["']?\s{0,4}[:=]?\s{0,4}["']?(?<![A-Za-z0-9+/])([A-Za-z0-9+/]{40})(?![A-Za-z0-9+/=])/gi,
    accept: (match) => hasMixedCaseAndDigit(match[1] ?? ""),
  },
];

/** The longest single match any pattern can make, with room to spare; windows overlap by this much. */
const WINDOW = 4096;
const OVERLAP = 2048;

function* windows(line: string): Generator<string> {
  if (line.length <= WINDOW) {
    yield line;
    return;
  }
  for (let start = 0; start < line.length; start += WINDOW - OVERLAP) {
    yield line.slice(start, start + WINDOW);
    if (start + WINDOW >= line.length) return;
  }
}

/**
 * A key at the end of one line and its value at the start of a later one (`password:\n  <value>`,
 * also `password: |` and `password: >-` blocks). Up to `JOIN_BLANK_LINES` blank lines may sit
 * between them and the value may be indented by up to `JOIN_INDENT` characters; the newlines and
 * the indentation collapse to one space. Only this much of each line is joined, so the text a
 * pattern sees stays small and the pass stays linear in the text.
 */
const JOIN_TAIL = 128;
const JOIN_HEAD = 320;
const JOIN_BLANK_LINES = 2;
const JOIN_INDENT = 64;

/** The next line with text on it, within `JOIN_BLANK_LINES` blank lines of `index`, indentation removed. */
function nextValueLine(lines: readonly string[], index: number): string | null {
  for (let at = index + 1; at <= index + 1 + JOIN_BLANK_LINES; at += 1) {
    const candidate = lines[at];
    if (candidate === undefined) return null;
    const trimmed = candidate.slice(0, JOIN_INDENT + JOIN_HEAD).trimStart();
    if (trimmed.length > 0) return trimmed.slice(0, JOIN_HEAD);
  }
  return null;
}

/** `startsBefore`: ignore a match that starts at or after this offset (it belongs to a later line). */
function firstMatch(piece: string, startsBefore = Number.POSITIVE_INFINITY): string | null {
  for (const { name, pattern, accept } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(piece)) !== null && match.index < startsBefore) {
      if (match[0] === "") pattern.lastIndex += 1;
      else if (accept === undefined || accept(match)) return name;
    }
  }
  return null;
}

/** Name of the first credential-shaped pattern in the text, or null. Never returns the match. */
export function findSecret(text: string): { name: string; line: number } | null {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const piece of windows(line)) {
      const name = firstMatch(piece);
      if (name !== null) return { name, line: index + 1 };
    }
    const next = line.length > 0 ? nextValueLine(lines, index) : null;
    if (next !== null) {
      const tail = line.slice(-JOIN_TAIL);
      const name = firstMatch(`${tail} ${next}`, tail.length);
      if (name !== null) return { name, line: index + 1 };
    }
  }
  return null;
}

/** Throws a ServiceError naming the pattern, never the secret itself. */
export function assertNoSecret(text: string, label: string): void {
  const found = findSecret(text);
  if (found !== null) {
    throw new ServiceError(
      "bad_request",
      `Not saved: the ${label} looks like it contains a credential (${found.name}, line ${found.line}). Remove it and write again.`,
    );
  }
}

export function assertBodySize(body: string): void {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > BRAIN_BODY_MAX_BYTES) {
    throw new ServiceError(
      "bad_request",
      `Body is ${bytes} bytes; the limit is ${BRAIN_BODY_MAX_BYTES}. Split it into smaller memories.`,
    );
  }
}

/** Serialized frontmatter is a few short fields; anything bigger is not scanned, just refused. */
export const FRONTMATTER_MAX_BYTES = 8 * 1024;
const WRITABLE_FIELD_NAMES = new Set(["summary", "kind", "tags", "status", "pinned", "source"]);
const MAX_LEAVES = 2000;
const MAX_DEPTH = 8;

/** Every object key and string value below a frontmatter value, as the writer spelled them. */
function* rawStrings(value: unknown): Generator<string> {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let seen = 0;
  while (pending.length > 0 && seen < MAX_LEAVES) {
    const { value: node, depth } = pending.pop() ?? { value: null, depth: 0 };
    seen += 1;
    if (typeof node === "string") yield node;
    else if (typeof node === "object" && node !== null && depth < MAX_DEPTH) {
      const children = Array.isArray(node) ? node : Object.entries(node);
      for (const child of children) {
        if (Array.isArray(node)) pending.push({ value: child, depth: depth + 1 });
        else {
          const [key, inner] = child as [string, unknown];
          yield key;
          pending.push({ value: inner, depth: depth + 1 });
        }
      }
    }
  }
}

/**
 * Refuses oversized frontmatter, then scans every key and value a writer sent. Each is scanned
 * as written (JSON escaping turns `"` into `\"` and hides what a quoted value looks like) and as
 * serialized. The error names a known field, or just "frontmatter", never an unrecognized key.
 */
export function assertFrontmatterHasNoSecret(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  let whole: string | undefined;
  try {
    whole = JSON.stringify(input);
  } catch {
    throw new ServiceError("bad_request", "frontmatter: a value cannot be serialized");
  }
  const bytes = Buffer.byteLength(whole ?? "", "utf8");
  if (bytes > FRONTMATTER_MAX_BYTES) {
    throw new ServiceError(
      "bad_request",
      `Frontmatter is ${bytes} bytes; the limit is ${FRONTMATTER_MAX_BYTES}. Shorten it.`,
    );
  }
  for (const [key, value] of Object.entries(input)) {
    const label = WRITABLE_FIELD_NAMES.has(key) ? key : "frontmatter";
    assertNoSecret(key, label);
    assertNoSecret(`${key}: ${JSON.stringify(value) ?? ""}`, label);
    if (typeof value === "string") assertNoSecret(`${key}: ${value}`, label);
    for (const text of rawStrings(value)) assertNoSecret(text, label);
  }
}
