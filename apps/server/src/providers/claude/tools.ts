import { workspaceRelative as relPath } from "../paths.ts";
import type { ToolKind } from "@age/contracts";
import { clip, firstLine } from "./text.ts";

const KINDS = new Map<string, ToolKind>([
  ["Read", "read"],
  ["NotebookRead", "read"],
  ["Glob", "search"],
  ["Grep", "search"],
  ["LS", "search"],
  ["Edit", "edit"],
  ["Write", "edit"],
  ["MultiEdit", "edit"],
  ["NotebookEdit", "edit"],
  ["Bash", "command"],
  ["WebFetch", "web"],
  ["WebSearch", "web"],
  ["Task", "task"],
  ["Agent", "task"],
]);

export function toolKind(name: string): ToolKind {
  return KINDS.get(name) ?? "other";
}

export type ToolInput = Record<string, unknown>;

export function str(input: ToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export { relPath };

export function targetPath(input: ToolInput): string | undefined {
  return str(input, "file_path") ?? str(input, "notebook_path") ?? str(input, "path");
}

export interface ToolDescription {
  kind: ToolKind;
  title: string;
  files?: string[];
}

const TITLE_MAX = 120;

export function describeTool(name: string, input: ToolInput, cwd: string): ToolDescription {
  const kind = toolKind(name);
  const path = targetPath(input);
  const rel = path ? relPath(path, cwd) : undefined;
  const title = (text: string) => clip(text, TITLE_MAX);

  switch (name) {
    case "Read":
    case "NotebookRead":
      return { kind, title: title(rel ? `Read ${rel}` : "Read file") };
    case "Glob":
    case "Grep": {
      const pattern = str(input, "pattern");
      return { kind, title: title(pattern ? `Search ${pattern}` : "Search files") };
    }
    case "LS":
      return { kind, title: title(`List ${rel ?? "directory"}`) };
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": {
      const verb = name === "Write" ? "Write" : "Edit";
      return {
        kind,
        title: title(rel ? `${verb} ${rel}` : `${verb} file`),
        ...(rel ? { files: [rel] } : {}),
      };
    }
    case "Bash": {
      const command = firstLine(str(input, "command") ?? "");
      return { kind, title: title(command || str(input, "description") || "Run command") };
    }
    case "WebFetch":
      return { kind, title: title(`Fetch ${str(input, "url") ?? "page"}`) };
    case "WebSearch":
      return { kind, title: title(`Web search: ${str(input, "query") ?? ""}`.trimEnd()) };
    case "Task":
    case "Agent":
      return { kind, title: title(str(input, "description") ?? "Run subagent") };
    case "TodoWrite":
      return { kind, title: "Update todo list" };
    default:
      return { kind, title: title(prettyToolName(name)) };
  }
}

/** `mcp__github__create_issue` becomes `github: create_issue`. */
function prettyToolName(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${match[1]}: ${match[2]}` : name;
}
