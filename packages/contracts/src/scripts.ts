import { z } from "zod";
import { parseHttpUrl } from "./remote.ts";

const ScriptId = z.string().min(1).max(128);

/** Relative path brought into a worktree. `.gitignore` is allowed; `.git` itself is not. */
function isSharedRelPath(value: string): boolean {
  if (value.includes("\0")) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.startsWith("\\\\")) return false;
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return parts[0] !== ".git";
}

export const SharedRelPath = z.string().min(1).max(512).refine(isSharedRelPath, {
  message: "Path must be relative, must not contain '..', and must not be inside .git",
});

export const SharedPath = z.object({
  path: SharedRelPath,
  mode: z.enum(["link", "copy"]),
});
export type SharedPath = z.infer<typeof SharedPath>;

export const ProjectPrompt = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(60),
  text: z.string().min(1).max(20_000),
});
export type ProjectPrompt = z.infer<typeof ProjectPrompt>;

/** A preview opens on the machine the script runs on, never somewhere else. */
export function isLocalPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function isPreviewUrl(value: string): boolean {
  if (value.includes("\0")) return false;
  const parsed = parseHttpUrl(value);
  return parsed !== null && isLocalPreviewHost(parsed.hostname);
}

const PreviewUrl = z.string().min(1).max(2048).refine(isPreviewUrl, {
  message: "Preview URL must be http(s) on localhost, 127.0.0.1 or [::1]",
});

/** Written settings reject a bad address; stored ones drop it instead of failing to decode. */
const previewUrlField = (stored: boolean) =>
  stored ? PreviewUrl.optional().catch(undefined) : PreviewUrl.optional();

/** A command the user runs in the project's shell, through the PTY terminal. */
const scriptShape = (stored: boolean) => ({
  id: ScriptId,
  name: z.string().min(1),
  command: z.string().min(1),
  icon: z.string().min(1).optional(),
  runOnWorktreeCreate: z.boolean().default(false),
  /** May contain `${PORT}` for the preview server's port. */
  previewUrl: previewUrlField(stored),
});

export const ProjectScript = z.object(scriptShape(false));
export type ProjectScript = z.infer<typeof ProjectScript>;

const StoredProjectScript = z.object(scriptShape(true));

function settingsObject(stored: boolean) {
  return z.object({
    scripts: z.array(stored ? StoredProjectScript : ProjectScript).default([]),
    worktreeSetup: z.string().min(1).optional(),
    /** May contain `${PORT}`. */
    defaultPreviewUrl: previewUrlField(stored),
    sharedPaths: z.array(SharedPath).default([]),
    prompts: z.array(ProjectPrompt).max(50).default([]),
  });
}

export const ProjectSettings = settingsObject(false).default({
  scripts: [],
  sharedPaths: [],
  prompts: [],
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/** What a stored event or snapshot carries; a preview URL written before the check reads as absent. */
export const StoredProjectSettings = settingsObject(true).default({
  scripts: [],
  sharedPaths: [],
  prompts: [],
});
export type StoredProjectSettings = ProjectSettings;
