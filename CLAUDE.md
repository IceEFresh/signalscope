# CLAUDE.md: SignalScope fork (IceEFresh/signalscope)

Read `docs/PLAN.md`, `docs/BOOK-IMPROVEMENTS.md` and `docs/WORKFLOW.md` before starting any work.

## Rules

- Work one plan item at a time, in the order given in `docs/WORKFLOW.md`. Each item gets one branch named `plan/<item-id>-<slug>` and one PR.
- Phase 1 and 2 PRs only log data. They never change scores, stages or labels. PR 1-0 is the only exception.
- Never change `RECOMMENDATION_RULE_PATHS`, the opportunity score or the recommendation thresholds without a matching entry in `scripts/backtesting-experiments.md`. PR 1-0's changes to the opportunity score are a scope decision rather than a tested result, but they still get an entry recording what changed and why.
- Tests use saved fixtures under `src/__tests__/fixtures/`, never live network calls.
- Before opening a PR, `npx tsc --noEmit`, `npm run lint`, `npm test` and `npm run build` must all pass, the same checks as `ci.yml`.
- Show any Prisma migration in the PR body. Migrations must only add things (new nullable columns or tables). Never drop or rename.
- Ask before adding a dependency.
- Never push to `main`.
- Never commit `.env` or any secret.

## Environment notes

- Upstream harvest cadence is one run per weekday at 8:30 AM ET. Don't change it.
- Production is a Synology DS1815+ (Atom C2538, 16 GB RAM) running `docker compose`. Keep the image buildable there.
