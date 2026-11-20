import { z } from "zod";

const ScriptId = z.string().min(1).max(128);

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
  })
  .default({ scripts: [] });
export type ProjectSettings = z.infer<typeof ProjectSettings>;
