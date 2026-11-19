import type { AccountInfo, ModelInfo, Options, query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_AUTH_UNKNOWN_NOTE,
  CLAUDE_SIGNED_OUT_PROBLEM,
  accountAuthenticated,
  claudeModelOptions,
  probeClaudeAuth,
} from "./probe-auth.ts";

type Params = Parameters<typeof query>[0];

type IterableProbe = {
  yielded: unknown[];
  finished: Promise<void>;
};

type AuthProbeSession = {
  initializationResult: () => Promise<unknown>;
  tracked?: IterableProbe | null;
};

function trackIterable(prompt: Params["prompt"]): IterableProbe | null {
  if (typeof prompt === "string") return null;
  const yielded: unknown[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  void (async () => {
    try {
      for await (const message of prompt) yielded.push(message);
    } finally {
      resolveFinished();
    }
  })();
  return { yielded, finished };
}

function fakeQueryForAuthProbe(
  probe: { account?: AccountInfo; delayMs?: number } | "hang" | "error",
  models: ModelInfo[] | "throw" | "hang" | "absent" = "absent",
) {
  const calls: Params[] = [];
  const iterableProbes: Array<{ abort?: AbortController }> = [];
  let lastSession: AuthProbeSession | undefined;
  const close = vi.fn<() => void>(() => {
    for (const tracked of iterableProbes) {
      const controller = tracked.abort;
      if (controller && !controller.signal.aborted) controller.abort();
    }
  });

  const fake = ((params: Params) => {
    calls.push(params);
    const tracked = trackIterable(params.prompt);
    if (tracked) iterableProbes.push({ abort: params.options?.abortController });

    const initializationResult = () => {
      if (probe === "error") return Promise.reject(new Error("sdk init failed"));
      if (probe === "hang") return new Promise(() => undefined);
      if (probe.delayMs) {
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                account: probe.account,
                commands: [],
                agents: [],
                models: [],
                output_style: "",
                available_output_styles: [],
              }),
            probe.delayMs,
          ),
        );
      }
      return Promise.resolve({
        account: probe.account,
        commands: [],
        agents: [],
        models: [],
        output_style: "",
        available_output_styles: [],
      });
    };

    const gen = async function* () {
      if (false as boolean) yield undefined;
      await new Promise<never>(() => undefined);
    };
    const supportedModels = () => {
      if (models === "throw") return Promise.reject(new Error("models failed"));
      if (models === "hang") return new Promise(() => undefined);
      return Promise.resolve(models);
    };
    const session = Object.assign(gen(), {
      initializationResult,
      ...(models === "absent" ? {} : { supportedModels }),
      close,
      tracked,
    }) as AuthProbeSession;
    lastSession = session;
    return session;
  }) as unknown as typeof query;

  return { fake, calls, close, lastSession: () => lastSession };
}

describe("accountAuthenticated", () => {
  it("treats oauth token source as signed in", () => {
    expect(accountAuthenticated({ tokenSource: "oauth" })).toBe(true);
  });

  it("treats explicit none sources as signed out", () => {
    expect(accountAuthenticated({ tokenSource: "none", apiKeySource: "none" })).toBe(false);
  });

  it("treats a claude.ai login (account fields, no token source) as signed in", () => {
    expect(
      accountAuthenticated({
        email: "someone@example.com",
        organization: "Org",
        subscriptionType: "Claude Pro",
        apiProvider: "firstParty",
      }),
    ).toBe(true);
  });

  it("treats a third-party backend as signed in", () => {
    expect(accountAuthenticated({ apiProvider: "bedrock" })).toBe(true);
  });

  it("treats a missing or empty first-party account as signed out", () => {
    expect(accountAuthenticated(undefined)).toBe(false);
    expect(accountAuthenticated({ apiProvider: "firstParty" })).toBe(false);
  });
});

describe("probeClaudeAuth prompt", () => {
  it("passes an async iterable prompt instead of a string", async () => {
    const { fake, calls } = fakeQueryForAuthProbe({ account: { tokenSource: "oauth" } });
    await probeClaudeAuth(fake, {}, 5_000);
    const prompt = calls[0]?.prompt;
    expect(typeof prompt).not.toBe("string");
    expect(prompt && typeof prompt === "object" && Symbol.asyncIterator in prompt).toBe(true);
  });

  it("does not yield user messages before initialization settles", async () => {
    const { fake } = fakeQueryForAuthProbe({ account: { tokenSource: "oauth" }, delayMs: 50 });
    let initResolved = false;
    const wrapped = ((params: Params) => {
      const session = fake(params) as AuthProbeSession;
      const init = session.initializationResult.bind(session);
      session.initializationResult = async () => {
        const value = await init();
        initResolved = true;
        expect(session.tracked?.yielded).toEqual([]);
        return value;
      };
      return session;
    }) as typeof query;
    await probeClaudeAuth(wrapped, {}, 5_000);
    expect(initResolved).toBe(true);
  });

  it("lets the prompt iterable finish after a successful probe", async () => {
    const { fake, lastSession } = fakeQueryForAuthProbe({ account: { tokenSource: "oauth" } });
    await probeClaudeAuth(fake, {}, 5_000);
    await expect(lastSession()?.tracked?.finished).resolves.toBeUndefined();
  });

  it("lets the prompt iterable finish after a timeout", async () => {
    const { fake, lastSession } = fakeQueryForAuthProbe("hang");
    const result = await probeClaudeAuth(fake, {}, 50);
    expect(result).toEqual({
      authenticated: null,
      problem: CLAUDE_AUTH_UNKNOWN_NOTE,
      models: [],
    });
    await expect(lastSession()?.tracked?.finished).resolves.toBeUndefined();
  });
});

describe("probeClaudeAuth auth", () => {
  it("reports signed in when tokenSource is set", async () => {
    const { fake } = fakeQueryForAuthProbe({ account: { tokenSource: "oauth" } });
    await expect(probeClaudeAuth(fake, {}, 5_000)).resolves.toEqual({
      authenticated: true,
      problem: null,
      models: [],
    });
  });

  it("reports signed in when apiKeySource is set", async () => {
    const { fake } = fakeQueryForAuthProbe({ account: { apiKeySource: "ANTHROPIC_API_KEY" } });
    await expect(probeClaudeAuth(fake, {}, 5_000)).resolves.toEqual({
      authenticated: true,
      problem: null,
      models: [],
    });
  });

  it("reports signed out when the SDK account has no token or API key source", async () => {
    const { fake, close } = fakeQueryForAuthProbe({
      account: { tokenSource: "none", apiKeySource: "none" },
    });
    await expect(probeClaudeAuth(fake, {}, 5_000)).resolves.toEqual({
      authenticated: false,
      problem: CLAUDE_SIGNED_OUT_PROBLEM,
      models: [],
    });
    expect(close).toHaveBeenCalled();
  });

  it("leaves auth unknown on SDK initialization timeout", async () => {
    const { fake, calls } = fakeQueryForAuthProbe("hang");
    await expect(probeClaudeAuth(fake, {}, 50)).resolves.toEqual({
      authenticated: null,
      problem: CLAUDE_AUTH_UNKNOWN_NOTE,
      models: [],
    });
    const options = calls[0]?.options as Options;
    expect(options).toMatchObject({ persistSession: false, tools: [] });
  });

  it("leaves auth unknown when initialization fails", async () => {
    const { fake } = fakeQueryForAuthProbe("error");
    await expect(probeClaudeAuth(fake, {}, 5_000)).resolves.toEqual({
      authenticated: null,
      problem: CLAUDE_AUTH_UNKNOWN_NOTE,
      models: [],
    });
  });
});

const info = (value: string, displayName = ""): ModelInfo => ({
  value,
  displayName,
  description: "",
});

describe("claudeModelOptions", () => {
  it("maps value and display name, falling back to a prettified id", () => {
    expect(claudeModelOptions([info("opus", "Opus"), info("claude-opus-5-5"), info("")])).toEqual([
      { id: "default", label: "Default" },
      { id: "opus", label: "Opus" },
      { id: "claude-opus-5-5", label: "Claude Opus 5 5" },
    ]);
  });

  it("carries the resolved model and the effort levels the SDK reports", () => {
    const [, opus] = claudeModelOptions([
      {
        ...info("opus", "Opus"),
        resolvedModel: "claude-opus-5-5",
        supportedEffortLevels: ["low", "high"],
        supportsFastMode: true,
      },
    ]);
    expect(opus).toEqual({
      id: "opus",
      label: "Opus",
      resolvedModel: "claude-opus-5-5",
      efforts: ["low", "high"],
      fastMode: true,
      ultracode: true,
    });
    expect(claudeModelOptions([{ ...info("haiku", "Haiku"), supportsEffort: false }])[1]).toEqual({
      id: "haiku",
      label: "Haiku",
    });
  });

  it("orders default, then aliases, then explicit ids and 1M variants, stably", () => {
    const ids = claudeModelOptions([
      info("claude-sonnet-5-5"),
      info("opus[1m]"),
      info("haiku", "Haiku"),
      info("default", "Default"),
      info("claude-opus-5-5"),
      info("sonnet", "Sonnet"),
      info("haiku", "Duplicate"),
    ]).map((model) => model.id);
    expect(ids).toEqual([
      "default",
      "haiku",
      "sonnet",
      "claude-sonnet-5-5",
      "opus[1m]",
      "claude-opus-5-5",
    ]);
  });

  it("labels a 1M variant readably and returns nothing for an empty list", () => {
    expect(claudeModelOptions([info("opus[1m]")]).find((m) => m.id === "opus[1m]")?.label).toBe(
      "Opus (1M)",
    );
    expect(claudeModelOptions([])).toEqual([]);
  });
});

describe("probeClaudeAuth models", () => {
  const oauth = { account: { tokenSource: "oauth" } };

  it("returns the SDK models from the same idle session", async () => {
    const { fake, calls } = fakeQueryForAuthProbe(oauth, [
      info("opus", "Opus"),
      info("default", "Default"),
    ]);
    const result = await probeClaudeAuth(fake, {}, 5_000);
    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      authenticated: true,
      problem: null,
      models: [
        { id: "default", label: "Default" },
        { id: "opus", label: "Opus" },
      ],
    });
  });

  it("keeps auth and returns no models when supportedModels throws, hangs or is empty", async () => {
    for (const models of ["throw" as const, "absent" as const, [] as ModelInfo[]]) {
      const { fake } = fakeQueryForAuthProbe(oauth, models);
      await expect(probeClaudeAuth(fake, {}, 5_000)).resolves.toEqual({
        authenticated: true,
        problem: null,
        models: [],
      });
    }
    const { fake } = fakeQueryForAuthProbe(oauth, "hang");
    await expect(probeClaudeAuth(fake, {}, 50)).resolves.toEqual({
      authenticated: true,
      problem: null,
      models: [],
    });
  });
});
