import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAcpModel,
  type AcpAgentConfig,
  type DeviceSettings,
  type ProviderEvent,
  type ProviderStatus,
} from "@wooky/contracts";
import { resolveCommand } from "../../process/resolve-command.ts";
import type { ProviderAdapter, TurnInput } from "../types.ts";
import { AcpClient, AcpMethodNotFound, acpDebug } from "./client.ts";
import { childEnv } from "./env.ts";
import { InitializeResult, initializeParams } from "./protocol.ts";
import { loadSettings, settingsFor } from "./settings.ts";
import { agentLabel, runAcpTurn, type AcpTurnSpec } from "./turn.ts";

const PROBE_TIMEOUT_MS = 4_000;

export const ACP_FAKE_AGENT_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-acp-agent.mjs",
);

const CAPABILITIES = { rewind: false, questions: false, planMode: false, queue: true };

export interface AcpAdapterOptions {
  /** Read at probe and turn time. Defaults to empty device settings. */
  settings?: () => DeviceSettings;
  onDebug?: (message: string) => void;
  killGraceMs?: number;
  maxLineBytes?: number;
  probeTimeoutMs?: number;
}

export function createAcpAdapter(options: AcpAdapterOptions = {}): ProviderAdapter {
  return {
    kind: "acp",
    probe: () => probeAcp(options),
    runTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
      return runConfiguredTurn(options, input);
    },
  };
}

async function* runConfiguredTurn(
  options: AcpAdapterOptions,
  input: TurnInput,
): AsyncGenerator<ProviderEvent> {
  const settings = loadSettings(options.settings);
  const provider = settingsFor(settings, "acp");
  const parsed = parseAcpModel(input.model);
  if (!parsed) {
    yield {
      type: "done",
      status: "failed",
      error: "The model id is not an ACP agent.",
    };
    return;
  }
  const agent = settings.acpAgents.find((candidate) => candidate.id === parsed.agentId);
  if (!agent) {
    yield {
      type: "done",
      status: "failed",
      error: `No ACP agent named ${parsed.agentId} is configured.`,
    };
    return;
  }
  if (!agent.enabled) {
    yield {
      type: "done",
      status: "failed",
      error: `The ACP agent ${agent.name} is disabled.`,
    };
    return;
  }
  const spec: AcpTurnSpec = {
    command: agent.command,
    args: [...agent.args, ...provider.extraArgs],
    env: childEnv(input.threadId, [agent.env, provider.env]),
    missingCommand: `Could not find ${agent.name} (${agent.command}).`,
    ...(parsed.modelId ? { modelId: parsed.modelId } : {}),
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
    ...(options.maxLineBytes !== undefined ? { maxLineBytes: options.maxLineBytes } : {}),
    ...(options.onDebug ? { onDebug: options.onDebug } : {}),
    noticeWhenSilent: true,
  };
  yield* runAcpTurn(spec, input);
}

async function probeAcp(options: AcpAdapterOptions): Promise<ProviderStatus> {
  const settings = loadSettings(options.settings);
  const provider = settingsFor(settings, "acp");
  const enabled = settings.acpAgents.filter((agent) => agent.enabled);
  const base = {
    kind: "acp" as const,
    label: "ACP agent",
    capabilities: CAPABILITIES,
    modelsSource: "custom" as const,
  };
  if (enabled.length === 0) {
    return {
      ...base,
      installed: false,
      authenticated: null,
      version: null,
      models: [],
      problem: "No ACP agents are enabled.",
    };
  }
  const results = await Promise.all(
    enabled.map((agent) => probeAgent(agent, provider.extraArgs, provider.env, options)),
  );
  const problems = results.flatMap((result) => (result.problem ? [result.problem] : []));
  const versions = results.flatMap((result) => (result.version ? [result.version] : []));
  const auths = results
    .filter((result) => result.initialized)
    .map((result) => result.authenticated);
  let authenticated: boolean | null = null;
  if (auths.length > 0 && auths.every((value) => value === true)) authenticated = true;
  else if (auths.some((value) => value === false)) authenticated = false;
  return {
    ...base,
    installed: results.some((result) => result.found),
    authenticated,
    version: versions.length > 0 ? versions.join(", ") : null,
    models: results.flatMap((result) => result.models),
    problem: problems.length > 0 ? problems.join(" ") : null,
  };
}

interface AgentProbe {
  found: boolean;
  initialized: boolean;
  authenticated: boolean | null;
  version: string | null;
  models: ProviderStatus["models"];
  problem: string | null;
}

async function probeAgent(
  agent: AcpAgentConfig,
  extraArgs: string[],
  providerEnv: Record<string, string>,
  options: AcpAdapterOptions,
): Promise<AgentProbe> {
  const models = modelsFor(agent);
  const env = childEnv(null, [agent.env, providerEnv]);
  const resolved = resolveCommand(agent.command, env);
  if (!resolved) {
    return {
      found: false,
      initialized: false,
      authenticated: null,
      version: null,
      models,
      problem: `Could not find ${agent.name} (${agent.command}).`,
    };
  }
  const debug = options.onDebug ?? acpDebug;
  const client = new AcpClient({
    command: resolved.command,
    args: [...resolved.prefixArgs, ...agent.args, ...extraArgs],
    cwd: resolve("."),
    env,
    onDebug: debug,
    onNotification: (method) => {
      if (method !== "session/update") debug(`acp: ignored notification ${method.slice(0, 200)}`);
    },
    onRequest: (method) => Promise.reject(new AcpMethodNotFound(method)),
    killGraceMs: 500,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const init = await Promise.race([
      client.request("initialize", initializeParams(), InitializeResult),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    const version = agentLabel(init);
    if (init.protocolVersion !== 1) {
      return {
        found: true,
        initialized: false,
        authenticated: null,
        version,
        models,
        problem: `${agent.name} speaks ACP protocol ${init.protocolVersion}.`,
      };
    }
    const methods = init.authMethods ?? [];
    return {
      found: true,
      initialized: true,
      authenticated: methods.length === 0 ? true : null,
      version,
      models,
      problem: null,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "timeout";
    return {
      found: true,
      initialized: false,
      authenticated: null,
      version: null,
      models,
      problem: timedOut
        ? `${agent.name} did not answer in time.`
        : `${agent.name} failed to start.`,
    };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close();
  }
}

function modelsFor(agent: AcpAgentConfig): ProviderStatus["models"] {
  if (!agent.models || agent.models.length === 0) {
    return [{ id: agent.id, label: agent.name, modelsSource: "custom" }];
  }
  return agent.models.map((modelId) => ({
    id: `${agent.id}/${modelId}`,
    label: `${agent.name}/${modelId}`,
    modelsSource: "custom",
  }));
}
