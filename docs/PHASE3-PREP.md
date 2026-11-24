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

## P3-0c: universe-wide daily snapshot (Chris, 2026-11-24)

**Why:** the first NAS scan had 45 signal tickers. At that rate, 6 weeks gives about 400 held-out rows, roughly 80 per quintile, under the 100-row minimum. Almost every feature would come out INSUFFICIENT. The bar, STP, sector and regime features already exist for every universe member (about 1,485) on every run, so recording them for the whole universe gives those features about 30 times more rows.

Branch `plan/p3-0c-universe-snapshot`.

1. **Additive migration:** a new table, `UniverseSnapshot`.
   - Columns: `id`, `scanId` (FK to Scan), `symbol`, `sessionDate` (the bar date the features describe), `close` (Float), `features` (JSONB, nullable).
   - `@@unique([scanId, symbol])`, `@@index([symbol, sessionDate])`.
   - Show the SQL in the PR body.
2. **What gets written each run:** one row per universe member (plus watch symbols, if they're already in the bar set).
   - **The features:**
     - the bar features (1a);
     - the STP state for that symbol (states only, the same fields `StpSignal` stores);
     - the sector features (1f, `tickerSectorFeatures`).
   - Regime stays on `Scan`, so it isn't duplicated per row.
   - Use data the harvester already computed this run. **No new network requests.**
   - Send it to the web side in the existing ingest payload, in batches if the payload limit needs it, and write it with `createMany` in chunks of about 500.
   - Measure the payload size and the DB time on the fixture, and report both in the PR.
3. **Outcomes come from later snapshots; no new fetches.** For a row at session D, the 1-day, 3-day and 7-day returns are the closes from the snapshots whose `sessionDate` is the 1st, 3rd and 7th trading session after D. SPY's close is taken the same way, either from the SPY row (add SPY to the snapshot) or from the regime bar. Holidays and missed runs leave the outcome null; never interpolate.
4. **Harness (P3-0b).**
   - Add a second dataset, `--dataset universe`, that builds `EvalRow`s from `UniverseSnapshot` with these outcomes.
   - The same split, folds, verdict rules and look-ahead assertion apply: the outcome's `sessionDate` must be later than the row's.
   - Report the two datasets separately, never pooled.
   - Add the universe dataset's candidate keys to the pre-registration *before* the first real run.
5. **Storage estimate:** about 1,500 rows × about 2 KB per weekday is roughly 3 MB a day, under 1 GB a year. That's fine on the NAS. Add the table to the health report: row count, plus feature null rates for the latest snapshot.
6. **Tests:**
   - outcome alignment across a weekend and a holiday;
   - a missed run leaves the outcome null;
   - the look-ahead refusal;
   - batched writes;
   - the health-report coverage line.

Log only: nothing reads the snapshot for a score, stage or label.

## S2: source resilience for Capitol Trades and StockTwits (Chris, 2026-11-24)

On the first NAS run, Capitol Trades returned 429 and the StockTwits TrendSpider mirror returned 502. Each source made one attempt and then logged 0 for the whole day.

Branch `plan/s2-source-resilience`.

1. **Retries:** wrap both fetches in the shared retry helper.
   - Rename `withYahooRetry` to `withRetry` and keep `withYahooRetry` as an alias, so the 1e call sites don't change.
   - Use labels `capitoltrades` and `stocktwits`.
   - On a 429, honour `Retry-After` when it's present, up to 60 s.
2. **Congress fallback:** when Capitol Trades still fails after retries, fetch House trades from Financial Datasets.
   - `FINANCIAL_DATASETS_API_KEY` is already in the NAS `.env`.
   - Its politician-trades data covers the House only, not the Senate.
   - Map each trade to the same `CONGRESS` signal shape, with `office: "house"`, and tag `source_detail: "financialdatasets"` in the metadata.
   - **First** save a real response from the NAS as a fixture, and confirm the endpoint, the auth header and the field names from it. Don't guess them.
   - Skip quietly when the key is missing.
3. **StockTwits:** no fallback source. Retry only.
4. **Logging:** the `[sources]` line marks a fallback, for example `congress=12 (fallback: financialdatasets)`.
5. **Tests:** fixture tests covering 429-then-200, 502-then-200, retries used up, the fallback path, a missing key, and the log line.

No migration, and no change to score, stage or label.

## P3-0d: sector features for the universe snapshot (Chris, 2026-11-24)

Chris approved storing each universe member's Yahoo sector and industry at the weekly build. That's one company-profile call per member, about 1,485 a week. It goes in two nullable `UniverseMember` columns, and the daily snapshot then adds the 1f sector features at no daily cost. Branch `plan/p3-0d-universe-sector`, stacked on P3-0c. It has a migration.

## S2 status
Parts 1, 3 and 5 (the retries) are merged in #36. The Financial Datasets House fallback (part 2) is **on hold (Chris, 2026-11-24)**: the account has no credits, and no real response has been saved yet.

## Not in scope
- Changing any rule or score. That's Phase 3 proper, one PR per rule, after the harness runs on real data.
- 2d (paid options flow). It's decided by the harness results.
