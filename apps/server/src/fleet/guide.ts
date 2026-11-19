import { FLEET_LIMITS, type ProviderKind, type ProviderStatus } from "@wooky/contracts";

export interface UsableAgent {
  provider: ProviderKind;
  label: string;
  models: { id: string; label: string }[];
}

/** Providers a worker can run on now: installed, not signed out, not disabled, with models. */
export function usableAgents(
  providers: readonly ProviderStatus[],
  disabled: readonly ProviderKind[] = [],
): UsableAgent[] {
  return providers
    .filter(
      (entry) =>
        entry.kind !== "demo" &&
        entry.installed &&
        entry.authenticated !== false &&
        entry.problem === null &&
        !disabled.includes(entry.kind) &&
        entry.models.length > 0,
    )
    .map((entry) => ({
      provider: entry.kind,
      label: entry.label,
      models: entry.models.map((model) => ({ id: model.id, label: model.label })),
    }));
}

export function formatAgents(agents: readonly UsableAgent[]): string {
  if (agents.length === 0) return "No signed-in agents are available. Ask the user to sign one in.";
  return agents
    .map((agent) => {
      const models = agent.models.map((model) =>
        model.label && model.label !== model.id
          ? `  ${model.id}  (${model.label})`
          : `  ${model.id}`,
      );
      return [`--provider ${agent.provider}  (${agent.label})`, ...models].join("\n");
    })
    .join("\n\n");
}

/**
 * The playbook `wooky agents guide` prints. The session prompt only points here, so every
 * agent gets the full instructions when it is about to delegate, with the live agent list.
 */
export function fleetGuide(agents: readonly UsableAgent[]): string {
  const { maxLiveWorkers, maxAgentsWaitMs, maxReportSummary } = FLEET_LIMITS;
  return `# Running several agents in AGE

You are a coding agent running inside AGE. You can hand work to other coding agents
(workers) and coordinate them. Each worker is a separate agent session with its own git
worktree and branch, made from the project's current state. Workers run in parallel, and
the user can watch every one of them on the agent board.

## When to use workers

Use them when the work splits into pieces that do not depend on each other:
- Independent subtasks in different files or packages (a server change and a UI change,
  tests for several modules, a migration across separate folders).
- Research or review in parallel (read three subsystems at once, review a diff from
  several angles).
- A second opinion: give the same task to two different providers and compare results.

Do the work yourself when it is small, when each step needs the previous one, or when the
pieces would edit the same lines. Coordination costs time and the user's quota.

## Agents you can use now

${formatAgents(agents)}

Run \`wooky agents providers\` to refresh this list. Pick a strong model for hard or vague
work and a fast one for mechanical work. Mixing providers is fine.

## Workflow

1. Plan. Split the task into pieces with clear boundaries. Decide which files each worker
   owns so two workers never edit the same file.
2. Write one brief per worker. A worker starts with none of your context: it has not seen
   this conversation, the user's request, or what you have read. Everything it needs must
   be in the prompt (see "Writing a brief").
3. Spawn every independent worker before waiting on any of them:
     wooky agents spawn --provider <kind> --model <id> --title "<short title>" --prompt-file brief-1.md
   It prints the worker's thread id. Write long briefs to a file outside the repo (for
   example under $TMPDIR) and pass --prompt-file, or pipe them with --prompt-file -.
4. Keep working on your own part while they run. When a worker finishes, its report arrives
   in this thread as a follow-up message. To block instead:
     wooky agents wait <id> <id> ...      (exit 0: all finished, exit 2: timeout, wait again)
5. Review each result:
     wooky agents result <id>             (status, summary, diff stat, worktree path)
     git -C <worktree> status
     git -C <worktree> log --oneline
     git -C <worktree> diff
   Check the work against the brief. Run the project's checks in the worktree.
6. Integrate. Bring the changes you accept into your workspace (cherry-pick the worker's
   commits or apply its diff), resolve conflicts, and run the checks again. Or tell the user
   which workers to merge from the agent board. Do not merge work you have not read.
7. Report to the user: what each worker did, what you kept, what you rejected and why.

## Writing a brief

A good brief reads like a ticket for a capable engineer who just joined:
- Goal: what to change and why, in the user's terms.
- Context: what you already know. Relevant files and symbols with paths, how the code is
  laid out, decisions already made, and anything you tried that failed.
- Scope: the files or folders it owns, and what it must not touch.
- Rules: point at the project's instructions (AGENTS.md, CLAUDE.md, contributing docs) and
  restate the conventions that matter for this piece.
- Done: concrete acceptance criteria and the exact commands that must pass.
- Report: ask it to finish with a short summary of what it changed, how it verified it,
  and anything left open. Reports longer than ${maxReportSummary} characters are cut.

## Commands

  wooky agents providers [--json]
  wooky agents spawn --provider <kind> --model <id> [--title <text>] [--runtime-mode approve|auto-edits|full] [--prompt-file <path>|-] -- <prompt>
  wooky agents list [--json]
  wooky agents wait [--timeout <seconds>] <threadId>...
  wooky agents result <threadId> [--json]
  wooky agents guide

--runtime-mode defaults to yours. With approve, the user must approve each gated action in
the worker's thread, so prefer auto-edits for unattended work unless the user wants control.

## Limits

- At most ${maxLiveWorkers} workers may be live at once (working, waiting, or idle).
- Workers cannot spawn workers. Only you coordinate.
- A wait lasts at most ${maxAgentsWaitMs / 1000} seconds. Call it again to keep waiting.
- Workers spend the user's quota on their provider. Spawn only what the task needs.
`;
}
