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

const PLACEHOLDER_PASSWORD = /^(?:[$<{%]|\*+$|x+$|\.+$)/i;

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
      /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:@/?#]{1,64}:([^\s@/?#]{1,128})@[^\s/?#]{1,255}/gi,
    accept: (match) => !PLACEHOLDER_PASSWORD.test(match[1] ?? ""),
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
      /(?:password|passwd|secret|token|api[_ -]?key)[A-Za-z0-9_-]{0,32}["']?\s{0,4}[:=]\s{0,4}["']?([A-Za-z0-9+/_=.-]{16,256})/gi,
    accept: (match) => {
      const value = match[1] ?? "";
      return hasLetterAndDigit(value) && entropy(value) >= 3.5;
    },
  },
  {
    name: "API key assignment",
    pattern:
      /api[_ -]?key[A-Za-z0-9_-]{0,32}["']?\s{0,4}[:=]\s{0,4}["']?([A-Za-z]{16,256})(?![A-Za-z0-9+/_=.-])/gi,
    accept: (match) => entropy(match[1] ?? "") >= 3.5,
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

/** Name of the first credential-shaped pattern in the text, or null. Never returns the match. */
export function findSecret(text: string): { name: string; line: number } | null {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const piece of windows(line)) {
      for (const { name, pattern, accept } of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(piece)) !== null) {
          if (match[0] === "") pattern.lastIndex += 1;
          else if (accept === undefined || accept(match)) return { name, line: index + 1 };
        }
      }
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
