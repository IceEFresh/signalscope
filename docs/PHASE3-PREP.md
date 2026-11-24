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

## P3-0g: price-history backfill (Chris, 2026-11-24; ahead of P3-0e and P3-0f)

**Goal:** rebuild the price-only snapshot features for the past 2 years, so Phase 3 can test bar and STP features now. The rebuild has no look-ahead because each day uses only bars up to that day.

Branch `plan/p3-0g-price-backfill`.

1. **Script:** `scripts/backfill-snapshot.ts`, run by hand on the NAS (`--years 2`, `--symbols` optional).
   - Fetch 2 years plus 120 days of warm-up daily bars per current universe member and SPY, with the existing chart code, retry and pacing.
   - Cache the raw bars on disk under `scripts/output/backfill-bars/`, so a rerun doesn't refetch.
   - **No new endpoint:** write the rows straight through Prisma from the harvester container.
2. **For each trading day D:** compute the 1a bar features and the STP states using **only bars ≤ D**, by slicing the array. Never compute on the full series and shift.
   - Assert this in code: the newest bar used for day D is dated D.
   - Write the result as `UniverseSnapshot` rows, with `features.backfill = true` and `features.backfill_version = 1`.
   - Leave sector and regime out (they depend on live inputs), unless rebuilding them is purely price-based and just as safe.
3. **Linking rows to a scan:** `UniverseSnapshot.scanId` is required. Create one synthetic `Scan` row per backfill run (`source: "backfill"` or a similar marker on an existing field), and attach every backfill row to it.
   - If `Scan` has no field that can carry the marker without a migration, stop and ask before adding one.
   - Live scans must never be overwritten. On a `(scanId, symbol)` conflict, skip.
4. **Harness:** `--dataset backfill`.
   - Outcomes come from the backfill rows' own later sessions; SPY is the benchmark.
   - Same rules as the other datasets, reported separately, and never pooled with live data.
   - The report header states the survivorship bias in plain words: current members only, delisted names missing, so results are optimistic.
   - The pre-registration gets the backfill dataset's candidate keys and comparison count **before** the first run.
5. **Scale:** about 1,500 symbols × 500 days, roughly 750K rows and 1.5 GB at about 2 KB per row.
   - Measure on 20 symbols first and report the projected size and run time.
   - If the projection is over 3 GB, store only the candidate keys in `features`, not every key.
6. **Tests:** prove with a planted future bar that no future bar is used for day D; check the STP state on a sliced fixture against the live computation for the same day; and test resume after a partial run.

Log only. No score or label changes. No new dependencies.

## P3-0e: liquid crypto universe, log only (Chris, 2026-11-24)

**Goal:** test whether bar features and STP carry over to liquid crypto, as a separate dataset. Insider, Congress, earnings, sector and options features don't exist for crypto, and none are faked.

Branch `plan/p3-0e-crypto-universe`.

1. **Weekly crypto universe**, rebuilt alongside the stock universe.
   - **Source:** CoinGecko's free `/coins/markets` (vs_currency=usd, order=market_cap_desc, per_page=250, pages 1–2), giving the top 500 candidates.
     - Respect the free rate limit: pace about 3 s between pages, plus retry.
     - An optional `COINGECKO_API_KEY` (demo key) is sent as `x-cg-demo-api-key` when it's set.
     - Save a real response from the NAS as a fixture before writing the parser.
   - **Exclude:** stablecoins, wrapped tokens, staked or liquid-staking tokens, and exchange IOUs. Use CoinGecko categories where the response has them, plus a short explicit denylist in code (USDT, USDC, DAI, FDUSD, USDe, TUSD, PYUSD, WBTC, WETH, stETH, wstETH, cbBTC, weETH and so on). Log every exclusion with its reason.
   - **Map** each token to a Yahoo symbol (`<SYMBOL>-USD`). Drop any token whose Yahoo chart is missing, stale (last bar more than 2 days old), or for a different asset. Check the name or price against CoinGecko's price within ±5%, and log mismatches.
   - **Filters:** reuse the stock rules where they make sense.
     - Market cap ≥ $500M.
     - 20-day median dollar volume ≥ $25M, from the Yahoo bars, not CoinGecko's volume.
     - ATR% ≥ 3% or HV20 ≥ 40%.
     - There's no price floor and no options-listed rule.
   - **Expected size:** about 100–200 members. Print the real number.
2. **Additive migration:**
   - Add `assetClass` (TEXT, nullable, default null) to `UniverseMember` and `UniverseSnapshot`. Null means a stock, for older rows; new rows write `"stock"` or `"crypto"`.
   - Add `coingeckoId` (nullable) on `UniverseMember`.
   - Show the SQL.
3. **Daily features:** crypto members go through the existing bar-feature and STP code on daily bars.
   - Yahoo crypto daily bars run 00:00–24:00 UTC, 7 days a week. Treat a bar as complete only once its UTC day has ended.
   - STP's weekly and monthly opens use the UTC Monday 00:00 bar and the first UTC day of the month.
   - `spy_*` and `rs_vs_spy_*` become `btc_*` and `rs_vs_btc_*` for crypto rows. Don't compute a SPY comparison on crypto.
   - The regime stays stock-only.
4. **Snapshot:** crypto rows are written to `UniverseSnapshot` with `assetClass: "crypto"`.
   - `sessionDate` is the UTC date.
   - Weekend bars exist, but the harvest runs on weekdays only. Each Monday row describes Sunday's bar; Saturday's and Sunday's own bars aren't stored. Document this.
   - Don't change the cron.
5. **Harness:** `--dataset crypto`.
   - Outcomes are the token's own later snapshots, keyed by `sessionDate`.
     - The 1-, 3- and 7-day horizons count snapshot sessions, which are weekdays, so the dataset's calendar matches its rows.
     - Write that definition into the pre-registration.
   - The benchmark is BTC, from the BTC row.
   - Same split, folds, verdict rules and look-ahead refusal as the stock datasets. Reported separately and never pooled.
   - Add its candidate keys and comparison count to `docs/PHASE3-PREREG.md` before any real run.
6. **Health report:** a crypto line with member count, rows per snapshot and feature null rates.
7. **Tests:**
   - the exclusion list;
   - the CoinGecko-to-Yahoo mapping, including a mismatch;
   - liquidity filters on fixture bars;
   - UTC day completion;
   - weekly and monthly opens across a weekend;
   - the BTC benchmark;
   - the harness look-ahead refusal on crypto rows.

Log only: no score, stage, label or recommendation reads crypto rows, and crypto never enters `ValidatedTicker`. No new dependencies.

## P3-0f: macro context fields, log only (Chris, 2026-11-24)

Scan-level fields, stored in `Scan.regimeFeatures` under a `macro` key, so no migration is needed. That makes them one value per day: they're for conditioning other features in Phase 3+, and they can't be tested alone before about 6–12 months of data.

Branch `plan/p3-0f-macro-context`.

1. **New Yahoo daily charts**, through the existing chart cache and retry. Verify each symbol on the NAS and save fixtures first.
   - `DX-Y.NYB`, the US dollar index. Fall back to `UUP` if that returns no data.
   - `HYG` and `LQD`, high-yield and investment-grade corporate bonds.
   - `^TNX` and `^IRX`, the 10-year and 13-week Treasury yields. Note the scale Yahoo quotes them in, and document it.
   - `BTC-USD`, if P3-0e hasn't already loaded it.
   - GLD and DBB are already fetched for sector rotation. Reuse those bars.
2. **Fields**, all computed on completed bars only:
   - `dxy_close`, `dxy_return_20d`, `dxy_vs_sma50`
   - `credit_ratio` (HYG/LQD close) and `credit_ratio_change_20d`. A rising ratio means spreads are tightening, a risk-on sign.
   - `yield_10y`, `yield_3m`, `curve_10y_3m` (in percentage points) and `curve_change_20d`
   - `copper_gold_ratio` (DBB/GLD) and `copper_gold_change_20d`
   - `btc_return_20d` and `btc_vs_sma50`
   - `macro_bar_date`, the latest common completed session
3. **Missing data:** a failed series gives null fields and a warning. It never fails the harvest.
4. **Health report:** add the `macro` keys to the scan-level section.
5. **Harness:** expose the `macro.*` keys to the universe and crypto datasets as **conditioning columns only**. Don't add them to the pre-registered candidate list now; a later pre-registration update adds them once there are 6+ months of scans.
6. **Tests:** real fixtures for each symbol, exact values on synthetic bars, a missing series gives null, and the yield-scale handling.

Log only. No score, stage or label changes. No new dependencies.

## Not in scope
- Changing any rule or score. That's Phase 3 proper, one PR per rule, after the harness runs on real data.
- 2d (paid options flow). It's decided by the harness results.
