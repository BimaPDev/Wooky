# Kitchen rules: how work is delegated

Wooky is built by a head chef (the orchestrating agent) and several line cooks (worker
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

| Unit | Station (owned paths)                            | Cook                                                 | Reviewer                             | Status                                                          | Evidence                            |
| ---- | ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------- | ----------------------------------- |
| 0    | contracts, domain, seams, checks, rules          | head chef                                            | n/a                                  | merged                                                          | `pnpm check`                        |
| 1    | server core                                      | Opus 5.5                                             | Grok 4.6 (Cursor)                    | merged, 12 review fixes applied                                 | 240+ tests, e2e journey test        |
| 2    | git service                                      | Fable 5.2 failed (needs credits) → Opus 4.8 (Cursor) | GLM-5.3 Flash (OpenCode)             | merged, 10 review fixes applied                                 | real-git tests                      |
| 3    | Claude adapter                                   | Sonnet 5.5                                           | DeepSeek V4.1 Flash (OpenCode)       | merged, 8 review fixes applied                                  | real Haiku turns, approve + full    |
| 4    | web UI                                           | Grok 4.7 stalled → Opus 5.5                          | head chef (browser render)           | merged                                                          | build + live server + browser       |
| 5    | Codex adapter                                    | Gemini 4 Carbon (Cursor)                             | Composer 2.5 (Cursor CLI)            | merged, 8 review fixes NOT applied (Codex not installed here)   | fake app-server tests only          |
| 6    | desktop shell + dev runner                       | Haiku 5.5                                            | Big Pickle (OpenCode)                | merged, review fixes applied                                    | 23 tests; window not launched       |
| 7    | Cursor adapter                                   | Composer 2.5 via `cursor-agent` CLI                  | Haiku 5.5, head chef (real stream)   | merged, 16 fixes applied                                        | real stream replay                  |
| 8    | Wooky overhaul check fixes: server               | Sonnet 5.5                                           | Grok 4.7 (Cursor)                    | merged, 1 review fix applied (cmd.exe fallback reachable)       | `pnpm check` green                  |
| 9    | Wooky overhaul check fixes: web                  | Opus 5.5                                             | Sonnet 5.5                           | merged, 2 review fixes applied (sign-in line, hatch scope)      | `pnpm check` green                  |
| 10   | Codex adapter review findings                    | Opus 4.8 (Cursor) → Sonnet 5.5                       | Gemini 4 Carbon (Cursor) → Opus 5.5  | merged after 3 review rounds, 15 findings applied               | 59 fake app-server tests            |
| 11   | P0 contracts, reducer, seams (Station 0)         | Opus 5.5                                             | Grok 4.7 (Cursor), Sonnet 5.5        | merged after 3 review rounds                                    | legacy-log replay test              |
| 12   | P0 orchestration + runner (Station 1)            | Grok 4.7 (Cursor)                                    | Composer 2.5 (Cursor)                | merged, 4 low findings deferred                                 | e2e journey on demo provider        |
| 13   | P0 provider adapters (Station 2)                 | Sonnet 5.5 → Composer 2.5 (Cursor)                   | Grok 4.7 (Cursor), 3 security rounds | merged; plan-file reads confined (O_NOFOLLOW, fstat, inode pin) | 236 provider tests, attack scripts  |
| 14   | Workspace file search (Station 3)                | Sonnet 5.5                                           | Grok 4.7 (Cursor)                    | merged, no findings                                             | real-git tests                      |
| 15   | P0 web UI (Station 4)                            | Composer 2.5 (Cursor)                                | Grok 4.7 (Cursor)                    | merged after 3 review rounds                                    | fixture screenshots                 |
| 16   | Anywhere W1: Windows tree-kill + CI              | Composer 2.5 (Cursor)                                | Gemini 4 Hydrogen (Antigravity)      | merged after 2 review rounds, 11 findings applied               | `pnpm check`; Windows CI not run    |
| 17   | Anywhere S0: contracts, domain, spec             | Grok 4.7 (Cursor)                                    | Composer 2.5 (Cursor)                | merged, 9 review fixes applied                                  | `pnpm check`, 1391 tests            |
| 18   | Anywhere G1: commit, push, PR                    | Composer 2.5 (Cursor)                                | Grok 4.6 (Cursor)                    | merged, 13 review fixes applied                                 | real git + fake gh tests            |
| 19   | Anywhere M1: `wooky mcp` stdio bridge            | Grok 4.7 (Cursor)                                    | Composer 2.5 (Cursor)                | merged, 9 review fixes applied (no full mode by default)        | demo e2e via MCP transcript         |
| 20   | Anywhere I1: one-command installer               | Gemini 4 Neon (quota) → Composer 2.5 (Cursor)        | Grok 4.7 (Cursor)                    | merged, 14 review fixes applied                                 | local install 0.0.1→0.0.4, dry-runs |
| 21   | Anywhere T1: real PTY terminal (node-pty, xterm) | Grok 4.6 (Cursor)                                    | Composer 2.5 (Cursor)                | merged, 10 review fixes applied                                 | replay with ANSI, env-leak test     |

Open items: the 19 server tests that fail on Windows (CRLF, path separators, POSIX
signals) are unverified, because nobody has run them on Windows yet. A thrown effect is
recorded as `retired`; a real `failed` status needs an event-store migration. P0 deferred: Codex
rewind, questions and plan mode (protocol shapes missing); G2 guard ignores isolate-pending threads;
stale `session.rewind` rows after back-to-back reverts. No real provider turn has exercised P0 yet.
