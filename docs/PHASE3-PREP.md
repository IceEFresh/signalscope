# Phase 3 prep: build the tools before the data arrives

Phase 3 can't start until there are about 6 weeks of post-1-0 scans. These two items are built now on fixtures, so that the first NAS weeks are checked as they arrive and the test rules are fixed **before** anyone sees results. Both are log-only or offline. Neither changes scores, stages, labels or rules, and neither adds a migration.

## P3-0a: harvest health report

Branch `plan/p3-0a-harvest-health`. A script, `scripts/harvest-health.ts`, plus one ingest-side log line.

- For each of the last N scans (default 5), report per feature family:
  - row count, and the null rate of each key
  - min, median and max of each numeric key
  - The feature families are `bar_*`, `stp_*`, earnings, `regime`, `sectorRotation`, `opt_*`, `alp_*`, `politician_*`, `reddit_*`, `insider_class` and the AI shadow score.
- Flag:
  - any key that's 100% null in the latest scan
  - any key whose null rate jumped by more than 30 points against the median of the previous scans
  - any family missing entirely
  - a universe size outside 300–1,500 (a guess; print the real number)
- Output a plain-text table to stdout plus a JSON file. Exit 0 unless the DB is unreachable. This is a report, not a gate.
- Read-only Prisma queries, bounded to the last N scans (no unbounded scans of `features`).
- Tests use seeded fixture rows: a healthy scan, a scan with a dropped family, and a null-rate jump.
- Chris runs it on the NAS after each of the first week's harvests:
  `docker compose --profile harvest run --rm harvester npx tsx scripts/harvest-health.ts`

## P3-0b: validation harness and pre-registration

Branch `plan/p3-0b-validation-harness`.

1. **`docs/PHASE3-PREREG.md`, written and merged before any real results are viewed.** It fixes these rules, taken from PLAN.md Phase 3:
   - a time split, with the newest 30% held out
   - a 3-fold walk-forward
   - the primary metric: 7-day hit rate and mean excess return vs SPY
   - secondary metrics: 1-day and 3-day returns
   - keep a feature only if it improves the held-out metric **and** holds in at least 2 of 3 folds
   - no rule change for any bucket with fewer than 100 held-out rows
   - every run logged in `scripts/backtesting-experiments.md`
   It also lists the candidate features up front (every `*_` key family above), and states how many comparisons are being made, so a chance result can be judged against that count.
2. **`scripts/validate-features.ts`**
   - Builds a feature × outcome table from `TickerScan.features` joined to `TickerPerformance`. Each row is a ticker-scan with 1-, 3- and 7-day returns and SPY's return over the same window.
   - Outcomes must be strictly after the scan time. Assert this; one look-ahead leak voids the test.
   - For each feature, buckets numeric features into quintiles on the **training** folds only, and applies those cut points to the test fold. Categorical features keep their own categories.
   - Reports hit rate and mean excess return per bucket, for each fold and for the holdout, with row counts.
   - Marks each feature as KEEP, DROP or INSUFFICIENT (fewer than 100 rows) under the pre-registered rule.
   - Writes a markdown report and appends a summary entry to `scripts/backtesting-experiments.md`.
3. **Tests** on a synthetic fixture where the answer is known:
   - one planted feature with a real edge, which must come out KEEP
   - one pure-noise feature, which must come out DROP or fail the 2-of-3 test
   - one feature with too few rows, which must come out INSUFFICIENT
   - one row whose outcome date is before its scan, which must make the harness refuse to run
4. No new dependencies; plain TypeScript statistics. Ask first if you need a library.

## Not in scope
- Changing any rule or score. That's Phase 3 proper, one PR per rule, after the harness runs on real data.
- 2d (paid options flow). It's decided by the harness results.
