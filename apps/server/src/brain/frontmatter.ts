import {
  BRAIN_SUMMARY_MAX,
  BrainKind,
  BrainSource,
  BrainStatus,
  MemoryFrontmatter,
  MemoryFrontmatterInput,
} from "@wooky/contracts";
import type { z } from "zod";
import { ServiceError } from "../errors.ts";

/**
 * A memory file is `---`, one `key: <JSON value>` line per field, `---`, a blank line, the body.
 * JSON values are valid YAML flow values, so other tools read the same file. The parser is
 * strict when we write and forgiving when a person has edited the file by hand.
 */

const FIELD_ORDER = ["summary", "kind", "tags", "status", "pinned", "updatedAt", "source"] as const;

export function serializeMemory(frontmatter: MemoryFrontmatter, body: string): string {
  const lines = FIELD_ORDER.flatMap((key) => {
    const value = frontmatter[key];
    return value === undefined ? [] : [`${key}: ${JSON.stringify(value)}`];
  });
  return `---\n${lines.join("\n")}\n---\n\n${normalizeBody(body)}`;
}

/** LF line endings, no leading blank lines, one trailing newline (none for an empty body). */
export function normalizeBody(body: string): string {
  const text = body.replace(/\r\n?/g, "\n").replace(/^\n+/, "").trimEnd();
  return text === "" ? "" : `${text}\n`;
}

function describeIssues(label: string, error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      return `${label}${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Validates what a writer supplied. Unknown fields and malformed values are errors. */
export function parseFrontmatterInput(input: unknown, updatedAt: string): MemoryFrontmatter {
  const parsed = MemoryFrontmatterInput.safeParse(input);
  if (!parsed.success) {
    throw new ServiceError("bad_request", describeIssues("frontmatter", parsed.error));
  }
  const full = MemoryFrontmatter.safeParse({ ...parsed.data, updatedAt });
  if (!full.success) {
    throw new ServiceError("bad_request", describeIssues("frontmatter", full.error));
  }
  return full.data;
}

export interface ParsedMemory {
  frontmatter: MemoryFrontmatter;
  body: string;
  /** True when the file had no usable frontmatter and was read as a plain note. */
  plain: boolean;
}

function splitFence(text: string): { header: string[]; body: string } | null {
  if (!text.startsWith("---\n")) return null;
  const lines = text.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trimEnd() === "---") {
      return { header: lines.slice(1, index), body: lines.slice(index + 1).join("\n") };
    }
  }
  return null;
}

function readValue(raw: string): unknown {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    if (text.startsWith("[") && text.endsWith("]")) {
      return text
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter((item) => item !== "");
    }
    return text.replace(/^["']|["']$/g, "");
  }
}

function readFields(header: string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const line of header) {
    const match = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (match?.[1] !== undefined && !(match[1] in fields))
      fields[match[1]] = readValue(match[2] ?? "");
  }
  return fields;
}

/** First meaningful line of a note, as an L0 summary. */
export function deriveSummary(text: string): string {
  for (const line of text.split("\n")) {
    const cleaned = line
      .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/, "")
      .replace(/[`*_]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned === "" || cleaned === "---") continue;
    return cleaned.length > BRAIN_SUMMARY_MAX
      ? `${cleaned.slice(0, BRAIN_SUMMARY_MAX - 1)}…`
      : cleaned;
  }
  return "Empty note";
}

function cleanTags(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tags = items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z0-9][a-z0-9._:-]{0,39}$/.test(item));
  return [...new Set(tags)].slice(0, 12);
}

function cleanTime(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? fallback : time.toISOString();
}

/**
 * Reads a memory file. A hand-edited file never fails to load: bad fields fall back to
 * defaults, and a file without frontmatter is a note whose summary is its first line.
 */
export function parseMemory(raw: string, mtimeIso: string): ParsedMemory {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const fence = splitFence(text);
  if (fence === null) {
    return {
      frontmatter: MemoryFrontmatter.parse({
        summary: deriveSummary(text),
        kind: "note",
        tags: [],
        status: "active",
        updatedAt: mtimeIso,
      }),
      body: text,
      plain: true,
    };
  }
  const fields = readFields(fence.header);
  const body = fence.body.replace(/^\n+/, "");
  const summary =
    typeof fields["summary"] === "string" && fields["summary"].trim() !== ""
      ? fields["summary"].replace(/\s+/g, " ").trim().slice(0, BRAIN_SUMMARY_MAX)
      : deriveSummary(body);
  const source = BrainSource.safeParse(fields["source"]);
  const kind = BrainKind.safeParse(fields["kind"]);
  const status = BrainStatus.safeParse(fields["status"]);
  const pinned = fields["pinned"] === true || fields["pinned"] === "true" ? true : undefined;
  return {
    frontmatter: MemoryFrontmatter.parse({
      summary,
      kind: kind.success ? kind.data : "note",
      tags: cleanTags(fields["tags"]),
      status: status.success ? status.data : "active",
      ...(pinned === undefined ? {} : { pinned }),
      updatedAt: cleanTime(fields["updatedAt"], mtimeIso),
      ...(source.success ? { source: source.data } : {}),
    }),
    body,
    plain: false,
  };
}
