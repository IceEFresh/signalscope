# Workflow: builder and reviewer sessions

Two Claude sessions work on this repo:

- **Builder**: the Claude Code session that writes code and opens PRs.
- **Reviewer**: Chris's planning session. It reviews each PR, then approves it or requests changes.

Chris is the decision-maker. Questions either session can't answer go to him.

## Item order

1. Network check (report only, no PR)
2. `sec-insider.ts` investigation: what `pl=50` does, plus the https switch (small PR)
3. PR 1-0: liquid volatile universe and graduation watch
4. PR 1a: bar-feature module
4b. PR 1g: STP daily signals (spec: docs/STP-SIGNALS.md)
4c. PR 1h: full option chains from Cboe (options data is a priority)
5. PR 1b: days to earnings (implied volatility moved to 1h)
6. PR 1c: market regime fields
7. PR 1f: sector and industry rotation
8. PR 1d: AI model update and prompt caching
9. PR 1e: Yahoo fetch resilience
10. Phase 2 item 2a (finish the open review)
11. **S1: security fixes** (spec: docs/SECURITY-S1.md). Do this before 2b.
12. Phase 2 items 2b to 2e (done 2026-11-24; 2b-2 dropped, 2d deferred to Phase 3)
13. **P3-0a: harvest health report** (spec: docs/PHASE3-PREP.md)
14. **P3-0b: validation harness and pre-registration** (spec: docs/PHASE3-PREP.md). Built on fixtures now; run on real data from week 6.
15. **P3-0c: universe-wide daily snapshot** (spec: docs/PHASE3-PREP.md). Has a migration, so Chris merges. Do it right after P3-0b: data only accumulates once it's deployed.
16. **S2: source resilience for Capitol Trades and StockTwits** (spec: docs/PHASE3-PREP.md). Retries merged (#36); the Financial Datasets fallback is on hold.
17. **P3-0d: sector features for the universe snapshot** (spec: docs/PHASE3-PREP.md). Has a migration, so Chris merges.

18. **S3: typecheck `scripts/` in CI.** `tsconfig.json` excludes `scripts/`, so a duplicate `const` in `run-harvest-remote.ts` passed CI on #37 and would have crashed the harvester. Add `tsconfig.scripts.json`, which extends the base config and includes `scripts/**/*.ts`, and run `npx tsc --noEmit -p tsconfig.scripts.json` in `ci.yml`. Fix whatever it finds. No runtime change.
18b. **P3-0g: price-history backfill, runs before P3-0e and P3-0f** (spec: docs/PHASE3-PREP.md). No migration.
19. **P3-0e: liquid crypto universe, log only** (spec: docs/PHASE3-PREP.md). Has a migration, so Chris merges.
19b. **P3-0e2: CoinMarketCap as the second crypto-universe provider** (spec: P3-0e step 1b in docs/PHASE3-PREP.md). No migration.
20. **P3-0f: macro context fields, log only** (spec: docs/PHASE3-PREP.md). No migration: they go in `Scan.regimeFeatures`.
21. **P3-0h: harness fix, low-cardinality features are categorical** (spec: docs/PHASE3-PREP.md). No migration.
22. **P3-0i: STP trigger trade simulation on the backfill** (spec: docs/PHASE3-PREP.md). No migration. Pre-register before the first run.
22b. **P3-0i2: live rolling-open STP keys** (spec: P3-0i step 1c, live logging). No migration.
22b1. **P3-0i4**: max 3 adds, sector-profile fetch fix plus a backfill script, simulation outlier lines, rerun (PHASE3-PREP §P3-0i4). Before 22b2.
22b2. **P3-0i2b**: persistent bar store for the live swing keys (PHASE3-PREP §P3-0i2b). After #69.
22c. **P3-0i3: historical earnings dates from SEC EDGAR 8-K item 2.02** (spec: docs/PHASE3-PREP.md). No migration. Lets EGOP be simulated on the backfill.
22d. **P3-0j**: stock selection funnel, daily top-5 by R/R, pullback entry, macro-event and earnings rules (PHASE3-PREP §P3-0j). Pre-register its 10 comparisons in PHASE3-PREREG.md before any run.
## Builder loop, for each item

1. Branch from the latest `main`: `plan/<item-id>-<slug>`.
2. Before writing code, run `/plan-eng-review` on the plan item (target: its section of docs/PLAN.md) and fix the plan where it finds problems. Then implement the item, add tests, and run the four CI checks.
3. Open a PR titled `[<item-id>] <summary>`. The body covers:
   - the plan item and the plan section it implements
   - what changed and why
   - the migration SQL, if any
   - test evidence (commands run and their results)
   - known gaps
   - questions for Chris, under the heading `QUESTIONS FOR CHRIS`
4. Subscribe to the PR's activity, then stop and wait for review.
5. When the reviewer posts `REQUEST_CHANGES`, fix every point on the same branch, push, reply under the review, and wait again.
6. When the reviewer posts `APPROVED — NEXT: <item-id>`, start that item. Branch from `main` if the PR is merged. If it isn't merged yet, branch from the approved branch and say so in the new PR's body.

## Reviewer process

The reviewer runs `/plan-eng-review` (`.claude/skills/plan-eng-review/SKILL.md`) on every PR diff and posts its output as the PR review. The skill's final line is the verdict: `REQUEST_CHANGES` or `APPROVED — NEXT: <item-id>`.

## Merging

- The reviewer may squash-merge an approved PR when it has no migration and doesn't change labels.
- Chris merges PRs that add a migration or change labels, starting with PR 1-0, and any PR the reviewer flags.
- Deploying to the NAS is manual and done by Chris: `git pull && docker compose up -d --build`, after a `pg_dump` whenever the release includes a migration.

## Docs

Every planning doc lives in `docs/`. When a decision changes the plan, update `docs/PLAN.md` in the same PR or in a separate `docs:` PR.
