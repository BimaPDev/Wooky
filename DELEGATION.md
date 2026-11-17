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

| Unit | Station (owned paths)                   | Cook      | Reviewer | Status | Evidence     |
| ---- | --------------------------------------- | --------- | -------- | ------ | ------------ |
| 0    | contracts, domain, seams, checks, rules | head chef | —        | done   | `pnpm check` |
