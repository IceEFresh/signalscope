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
5. PR 1b: days to earnings and implied volatility
6. PR 1c: market regime fields
7. PR 1f: sector and industry rotation
8. PR 1d: AI model update and prompt caching
9. PR 1e: Yahoo fetch resilience
10. Phase 2 items 2a to 2c

## Builder loop, for each item

1. Branch from the latest `main`: `plan/<item-id>-<slug>`.
2. Implement the item, add tests, and run the four CI checks.
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

## Reviewer checklist (engineering review)

- **Plan fit.** Does the PR implement the plan item and nothing else? Phase 1 and 2 PRs must not change scores or labels.
- **Architecture.** Where does the new logic live, and does it follow the existing harvester patterns (`sources/*`, `index.ts` aggregation)?
- **Data flow.** What happens when a fetch fails or returns null? A failure must never stop a harvest; nulls are stored as null, never as 0.
- **Database.** Migrations only add nullable columns or tables. JSONB feature keys are named consistently. Indexes exist for new query paths.
- **Performance.** Count the requests each scan adds against the Yahoo rate limits. Check the effect on runtime on the NAS.
- **Tests.** Fixtures cover the happy path, empty or null data, and a malformed response.
- **Point-in-time correctness.** No feature may use data from after the scan time. Look-ahead bias breaks every Phase 3 test.
- **Security.** No secrets in code or logs.

## Merging

- The reviewer may squash-merge an approved PR when it has no migration and doesn't change labels.
- Chris merges PRs that add a migration or change labels, starting with PR 1-0, and any PR the reviewer flags.
- Deploying to the NAS is manual and done by Chris: `git pull && docker compose up -d --build`, after a `pg_dump` whenever the release includes a migration.

## Docs

Every planning doc lives in `docs/`. When a decision changes the plan, update `docs/PLAN.md` in the same PR or in a separate `docs:` PR.
