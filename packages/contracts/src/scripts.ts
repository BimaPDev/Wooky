import { z } from "zod";

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

/** A command the user runs in the project's shell, through the PTY terminal. */
export const ProjectScript = z.object({
  id: ScriptId,
  name: z.string().min(1),
  command: z.string().min(1),
  icon: z.string().min(1).optional(),
  runOnWorktreeCreate: z.boolean().default(false),
  /** May contain `${PORT}` for the preview server's port. */
  previewUrl: z.string().min(1).optional(),
});
export type ProjectScript = z.infer<typeof ProjectScript>;

export const ProjectSettings = z
  .object({
    scripts: z.array(ProjectScript).default([]),
    worktreeSetup: z.string().min(1).optional(),
    /** May contain `${PORT}`. */
    defaultPreviewUrl: z.string().min(1).optional(),
    sharedPaths: z.array(SharedPath).default([]),
    prompts: z.array(ProjectPrompt).max(50).default([]),
  })
  .default({ scripts: [], sharedPaths: [], prompts: [] });
export type ProjectSettings = z.infer<typeof ProjectSettings>;
