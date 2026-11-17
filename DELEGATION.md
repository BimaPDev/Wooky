# Kitchen rules: how work is delegated

AGE is built by a head chef (the orchestrating agent) and several line cooks (worker
agents on different models and harnesses). The method:

1. **Mise en place first.** The head chef writes the contracts, the reducer, the seams
   (`ProviderAdapter`, `GitService`), the rules and the checks before any worker starts.
   Workers build against fixed interfaces, so they can work in parallel.
2. **One station per worker.** Every brief lists the files the worker owns. Anything
   outside that list, especially `packages/contracts`, `packages/domain`, `AGENTS.md` and
   `scripts/`, is off limits. If a contract change is needed, the worker stops and says so
   in its hand-back instead of editing it.
3. **Isolated stations.** Each worker runs in its own git worktree on its own branch.
4. **Acceptance criteria up front.** Each brief states what "done" means, including the
   tests that must exist.
5. **The pass.** Nothing is merged until it passes `pnpm check` on the head chef's machine
   and a review by a model other than the one that wrote it. Findings go back to the
   original cook or are fixed by the chef if small.
6. **Ledger.** Every dish is recorded below: who cooked it, who reviewed it, the evidence.

## Ledger

| Unit | Station (owned paths)                                      | Cook                                        | Reviewer                                       | Status    | Evidence                                                       |
| ---- | ---------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- | --------- | -------------------------------------------------------------- |
| 0    | contracts, domain, seams, checks, rules                    | head chef (Opus 5.5)                        | —                                              | merged    | `pnpm check`                                                   |
| 1    | server core: store, orchestrator, effects, transport, demo | Opus 5.5                                    | Grok 4.6 (Cursor)                              | in review | 58 tests; manual `AGE_LISTENING` + `/healthz`                  |
| 2    | git service                                                | Fable 5.2 → reassigned to Opus 4.8 (Cursor) | —                                              | cooking   | Fable 5.2 needed usage credits                                 |
| 3    | Claude Code adapter                                        | Sonnet 5.5                                  | DeepSeek V4.1 Flash (OpenCode)                 | in review | 55 tests; real Haiku turns in full + approve mode              |
| 4    | web UI                                                     | Grok 4.7 (Cursor)                           | —                                              | cooking   |                                                                |
| 5    | Codex adapter                                              | Gemini 4 Carbon (Cursor)                    | —                                              | cooking   |                                                                |
| 6    | desktop shell + dev runner                                 | Haiku 5.5                                   | Big Pickle (OpenCode)                          | in review | 23 tests                                                       |
| 7    | Cursor adapter                                             | Composer 2.5 via `cursor-agent` CLI         | head chef (real-stream replay), then Haiku 5.5 | in review | 5 defects found by replaying a real stream, fixed by the cook  |
| 8    | head-chef fixes                                            | head chef                                   | reviewers above                                | merged    | DNS-rebinding guard, symlink-aware paths, Cursor sign-in probe |
