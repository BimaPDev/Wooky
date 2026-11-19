import { z } from "zod";

/** Slug used in ACP thread models: `<id>` or `<id>/<modelId>`. */
export const AcpAgentId = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,31}$/,
    "ACP agent id: lowercase letters, digits and hyphens, 1–32 characters",
  );
export type AcpAgentId = z.infer<typeof AcpAgentId>;

const MODEL_ID_MAX = 200;

const CliArg = z.string().max(4_096);

const ModelId = z.string().min(1).max(MODEL_ID_MAX);

/**
 * Passed to the child process as-is. Not a shell environment. At most 20 entries.
 * Callers must not write these values to logs or to the event log.
 */
const CliEnv = z
  .record(z.string().min(1).max(256), z.string().max(16_384))
  .refine((env) => Object.keys(env).length <= 20, "At most 20 environment variables");

/**
 * One user-defined ACP agent. `command` and `args` are argv, never a shell line.
 * `env` is stored in local settings.json only.
 */
export const AcpAgentConfig = z.object({
  id: AcpAgentId,
  name: z.string().min(1).max(40),
  command: z.string().min(1).max(200),
  args: z.array(CliArg).max(20).default([]),
  env: CliEnv.default({}),
  /** Model ids this agent accepts (the segment after `<agentId>/`). Omitted means the user listed none. */
  models: z.array(ModelId).max(50).optional(),
  enabled: z.boolean(),
});
export type AcpAgentConfig = z.infer<typeof AcpAgentConfig>;

/**
 * Options for one provider CLI. `extraArgs` are appended to the argv the adapter
 * already builds. `env` is merged into the child environment and must not be logged.
 */
export const ProviderSettings = z.object({
  binaryPath: z.string().min(1).max(500).optional(),
  defaultModel: ModelId.optional(),
  customModels: z.array(ModelId).max(50).default([]),
  extraArgs: z.array(CliArg).max(20).default([]),
  env: CliEnv.default({}),
});
export type ProviderSettings = z.infer<typeof ProviderSettings>;

export type ParsedAcpModel = {
  agentId: string;
  modelId?: string;
};

/**
 * Split a thread model on the ACP provider. The first `/` separates the agent id
 * from the model id; further slashes stay in the model id. Returns null when the
 * agent id is not an `AcpAgentId` or the model id is empty or longer than 200 characters.
 */
export function parseAcpModel(model: string): ParsedAcpModel | null {
  const slash = model.indexOf("/");
  const agentId = slash === -1 ? model : model.slice(0, slash);
  if (!AcpAgentId.safeParse(agentId).success) return null;
  if (slash === -1) return { agentId };
  const modelId = model.slice(slash + 1);
  if (!ModelId.safeParse(modelId).success) return null;
  return { agentId, modelId };
}
