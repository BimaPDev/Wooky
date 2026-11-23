import { BRAIN_BODY_MAX_BYTES } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";

interface SecretPattern {
  name: string;
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

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  {
    name: "API key (sk-)",
    pattern: /\bsk-[A-Za-z0-9_-]{24,}/,
    accept: (match) => hasLetterAndDigit(match[0]),
  },
  { name: "Slack token", pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/ },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    name: "credential assignment",
    pattern:
      /\b[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?([A-Za-z0-9+/_=.-]{16,})/i,
    accept: (match) => {
      const value = match[1] ?? "";
      return hasLetterAndDigit(value) && entropy(value) >= 3.5;
    },
  },
];

/** Name of the first credential-shaped pattern in the text, or null. Never returns the match. */
export function findSecret(text: string): { name: string; line: number } | null {
  for (const { name, pattern, accept } of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const scan = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = scan.exec(text)) !== null) {
      if (accept === undefined || accept(match)) {
        return { name, line: text.slice(0, match.index).split("\n").length };
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
