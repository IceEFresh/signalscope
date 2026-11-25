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

## P3-0h: harness fix, low-cardinality features are categorical (reviewer, 2026-11-25)

**Bug found in the first backfill run:** `stp_well_bid` takes the values −1, 0 and +1. Quintile cuts on it collapse into 2 buckets. Its "q1" held 167,590 test rows, that is −1 and 0 together, against "q4/q5" (+1). So the KEEP compares "not well bid" with "well bid", not well-offered with well-bid. The same applies to every STP state key (`stp_htf_opens`, `stp_ma_state`, `stp_well_bid`, `stp_size_factor`) and to any integer key with few values (`consecutive_up_days`).

Branch `plan/p3-0h-categorical-lowcard`.

1. **Rule:** a numeric key with **≤ 7 distinct non-null values in the training rows** is treated as categorical. Each value is its own bucket, with the same 100-row minimum and the same held-out and fold rules. Above 7 distinct values, quintiles as before.
2. **Report:** label the buckets by value (`=-1`, `=0`, `=1`), not `q1`.
3. **Pre-registration:** add this as an amendment dated 2026-11-25, stating plainly that it was found **after** the first backfill run and is a bug fix, not a new hypothesis. The comparison counts don't change.
4. **Tests:**
   - a 3-valued feature produces 3 buckets;
   - an 8-valued feature uses quintiles;
   - a planted effect in the −1 category alone comes out KEEP for `=-1`.
5. Rerun the backfill dataset on the NAS after merge. Both runs stay in the log; the old row is kept.

**Not in this fix:** the backfill showed a U-shape in `return_20d`, `rsi14_max_20d` and `sma20_vs_sma50`, where both extremes beat the middle. That points to volatility or beta, not direction. Testing it would be a **new hypothesis** (for example, excess return vs a beta-adjusted benchmark, or |feature| buckets). It gets pre-registered separately and tested on the live universe dataset, not on the backfill that suggested it.

## P3-0i: STP trigger trade simulation (Chris, 2026-11-25)

**Why:** the backfill run tested STP *states* against plain 7-day returns, and all 4 came out DROP. STP is traded as a **trigger**, with a stop-order entry, a stop, targets and exits. This item tests that, as trades measured in R.

Branch `plan/p3-0i-stp-trade-sim`.

### 1. Pre-register first
Add a section to `docs/PHASE3-PREREG.md`, **merged before the first real run**, that fixes everything below: the rules, metrics, KEEP rule, cost assumption and comparison count.

### 1b. Trend criteria per pattern (Chris, 2026-11-25)
STP finds entries **after** a stock meets its trend criteria. Each pattern has its own criteria, and `computeStp` already applies them. **The triggers as computed are the primary population. No extra gate.**
- **Inside candle and U-turns (BUTN/BRUTN):** the trend is price against **both** the weekly and the monthly open (`trendDirection ≥ 1`, or `trendDirection[3]` for U-turns).
- **Mechanical I and II:** the trend comes from the moving averages (sma20 vs sma50, then the price or sma10 cross).
- **EGOP:** a catalyst trade (the earnings gap), with no trend gate.

**Descriptive only, no verdicts:** split the Mechanical and EGOP results by `stp_htf_opens` alignment (aligned, partial, against), to see whether the weekly/monthly opens add anything on top of each pattern's own criteria.

### 1c. Rolling opens as a second trend definition for inside and U-turn (Chris, 2026-11-25)
Besides the calendar weekly and monthly opens, test **rolling** opens for the two patterns that use them, inside candles and U-turns:
- **Stocks:** the rolling "week" open is the open of the bar **5 trading sessions** back, counting today as session 1, so bar t−4. The rolling "month" open is the open of the bar **20 sessions** back (t−19).
- **Crypto:** **7** and **30** daily bars (t−6 and t−29).
- `stp_htf_opens_rolling` uses the same formula as `stp_htf_opens` (±1 or ±0.5), with the rolling opens in place of the calendar ones. U-turns use the value at t−3, exactly as the calendar version does.

**Simulation.** Run the inside and U-turn triggers twice, once per trend definition, under the same trade rules and control.
- This adds pre-registered comparisons: rolling inside long and short, rolling U-turn long and short. Add them to the count.
- Also report the overlap between the two definitions: how many triggers both fire, and how many only one fires.

**Live logging, log only, no migration.**
- Add `stp_htf_opens_rolling`, `stp_trigger_rolling` and `stp_trigger_type_rolling` (inside and U-turn only) to the STP features stored in `UniverseSnapshot.features` and the ticker features JSON.
- Use 5/20 for stocks and 7/30 for crypto rows.
- The `StpSignal` table and the calendar-based trigger stay unchanged.
- **Tests:** 5/20 vs 7/30 window selection by asset class; a rolling open exactly at the window edge; U-turn at t−3.

### 1d. Changes from Chris, 2026-11-25 (these replace anything below that conflicts)
- **Target is 3R** for exit A as well. Exit A is now: stop, **3R target**, time exit at session 10. Exit B keeps 3R.
- **Gaps fill at the open, on both sides:**
  - **superseded by §1e:** a gap through the entry does NOT fill (stop-limit, day order);
  - a gap through the **target** exits at the **open** (the better price, which a resting limit order gets);
  - a gap through the stop exits at the open (already the rule).
- **Entry location vs the normal move (a selection rule).** A late entry in a move has less room to reach 3R before the move ends. Measure it for each trade.

  **Reviewer's working definition (Chris to correct):**
  - The normal weekly move `W` is the mean high−low range of the prior 10 completed calendar weeks.
  - The normal monthly move `M` is the same over the prior 6 completed calendar months.
  - **Long:**
    - `week_used = (fill − lowest low since the week's open) / W`
    - `month_used = (fill − lowest low since the month's open) / M`
  - **Short:** mirrored, using the highest high.
  - **Room to 3R:** `room_w = (W × (1 − week_used)) / (3R distance)`, so a value ≥ 1 means a normal week still has room for 3R.
  - **Pre-registered test (adds 2 comparisons per exit):** trades with `week_used < 0.5` **and** `month_used < 0.5` versus all trades, long and short. KEEP needs the same rule as the other groups, and also to beat all trades of that direction.
  - **Descriptive only:** expectancy and 3R-hit rate by bucket (`< 0.25`, `0.25–0.5`, `0.5–0.75`, `0.75–1`, `> 1`) for both measures, and by `room_w` (`< 1`, `≥ 1`).
  - No look-ahead: W, M and the lows/highs use completed bars up to the trigger day, plus the fill bar's price only.
- **Exit B:** confirmed, see §1e (no longer on hold).

### 1e. STP trade management, confirmed by Chris 2026-11-25 (replaces §1d's gap rules and exit-B hold; overrides anything below that conflicts)

**Orders**
- **Entries are stop-limit orders, good for the day (D+1 only).**
  - **Long:** fills at `entry` only if D+1 opens **at or below** the entry and trades up through it.
  - **If D+1 opens above the entry, there's no fill.** The setup is cancelled and counted as `gap_skip`. Mirrored for shorts.
  - The same rule applies to the add order.
- **Exits are market orders.** A stop touched intraday fills at the stop. A gap through the stop fills at the **open**.

**Exit B: STP management. This is now the PRIMARY exit and the one that gets KEEP verdicts.**
1. **Start:** 1 unit at `entry`. Stop = trigger-bar `low − fudge` (shorts: `high + fudge`). `R = entry − stop`.
2. **Adds (Chris, 2026-11-25, replaces the single 2 ATR add): pyramid every 2R.**
   - Add levels: `entry + 2R`, `entry + 4R`, `entry + 6R`, and so on. Shorts mirrored.
   - Each add buys **50% of the current position size**: 1 → 1.5 → 2.25 → 3.375 units, and so on.
   - Each add is a stop-limit order with the same no-gap-fill rule. If a bar opens above an add level, that add is skipped, and the next level stays live.
   - If the stop and an add level are both touched on one bar, the stop wins and that add doesn't happen.
   - There's no limit on the number of adds. Report the add count per trade, and the maximum.
3. **After every add,** the stop for the **whole** position moves to its breakeven: the size-weighted average cost of all units held, plus nothing for costs.
   - It moves only if that's tighter than the current stop.
   - From then on, the stop is the **greater** of the current breakeven and any trailing stop, for longs. The stop never loosens.
4. **Before 3R is reached** (a high ≥ `entry + 3R`), the stop is the initial stop, or BE once the add has filled. No trailing, and no exit at the target.
5. **Once 3R has been touched,** trail on each completed bar and apply the new stop from the next bar. The stop only tightens, and never goes below BE (or the initial stop if there was no add):
   - **Mechanical trades (mech1, mech2): mX only, as documented in docs/STP-SIGNALS.md.** When the close crosses below sma20, or sma10 crosses below sma20, stop = that bar's `low − fudge`. No bar stop.
   - **All other trades: pmX, with the bar stop in its place when price is extended.**
     - If `close − sma10 > 1 × ATR14` (the 10-day SMA is more than 1 ATR away), stop = that bar's `low − fudge` (the bar stop).
     - Otherwise, pmX: when the trend direction on the prior bar is ≥ 1 and the close crosses below sma10, stop = that bar's `low − fudge`.
   - Shorts mirror all of the above.
6. **No target exit.** A safety time cap of **60 sessions** exits at that close. Report how many trades hit it.
7. **P&L in R:** total P&L over all units divided by the initial 1-unit risk R. Costs are 0.10% of notional per leg (the entry, every add and the exit), converted into R. Also report the R of the initial unit alone, so the pyramid's effect can be seen separately.
8. **Same-bar order:** when a bar touches both the stop and a level, the stop comes first (conservative).

**Exit A: secondary reference, no verdicts.** A fixed 3R target as a limit order (a gap through it fills at the open), the stop, and a 10-session time exit. Same entry and gap rules, no add.

**Metrics** for exit B, in addition to step 4:
- the add rate and the add-count distribution;
- the share of trades that reach 3R;
- the share that exit at BE;
- average R for trades that reached 3R and for those that didn't;
- average holding sessions;
- the 60-session cap count;
- `gap_skip` and add-gap-skip counts.

The control uses the same management.

**Tests**, in addition to step 7:
- the stop-limit gap skip for the entry and the add;
- adds at 2R and 4R, each 50% of the current size, with the stop moving to the new size-weighted breakeven after each;
- a gapped-over add is skipped and the next level stays live;
- the stop and the add on the same bar;
- no trailing before 3R;
- the bar stop when sma10 is more than 1 ATR away;
- mX for a mech trade and pmX for an inside trade;
- the stop never drops below BE;
- the 60-session cap;
- R across a pyramided position, and initial-unit R.

### 2. Trades
Simulate from the backfill bars: the on-disk cache `scripts/output/backfill-bars/`, or the DB backfill rows if the cache is gone. Same survivorship caveat as the backfill.

- **Trigger:** run `computeStp` on the bars up to and including day D (the same slicing as P3-0g). Every `stp_trigger ≠ 0` is one setup, using the trigger's own `entry` and `stop`. Record its `triggerType` and `firedRules`.
- **Entry:** a stop order valid for **1 session** (D+1).
  - **Long:** fills if the D+1 high ≥ entry, at `max(entry, open)`, so a gap through the entry fills at the open (the worse price).
  - **Short:** mirrored.
  - If it isn't filled on D+1, the setup is cancelled. Count cancellations.
- **Risk:** `R = |fill − stop|`. Skip a setup if the gap leaves R ≤ 0 or the open is past the stop. Count those.
- **Exit A (primary): fixed.**
  - Stop at the stop level, target at 2R, and a time exit at the close of session 10 after the fill.
  - **Same-bar ambiguity:** if one bar touches both the stop and the target, take the stop (conservative). That includes the fill bar.
  - **Gaps:** a gap through the stop exits at the open.
- **Exit B (secondary): the STP exits from docs/STP-SIGNALS.md.**
  - The mechanical exit, profit-maximizer trailing and the bar stop, as specified there.
  - Initial stop as in exit A, a 3R target, and a 20-session time exit.
  - Same conservative rules for ambiguity and gaps.
- **Costs:** charge 0.10% of price round trip, converted into R for each trade (`0.001 × fill / R`). Report both gross and **net**. Net is primary.
- **One position per ticker at a time:** a new trigger while a trade is open on the same ticker is skipped. Count those.

### 3. Control: does the trigger beat the mechanics alone?
For each filled trade, build a **matched control**: the same ticker, a random non-trigger session within ±20 sessions, and the same direction. Its entry is `high + fudge` (or `low − fudge` for shorts) and its stop is the mirror level, from that control bar. Then run the same fill, exit and cost rules.

Use a fixed RNG seed and write it into the pre-registration. The trigger's edge is **trigger net expectancy minus control net expectancy**.

### 4. Metrics, per group
- trades, fill rate, win rate;
- average R and median R (net);
- expectancy and profit factor;
- average holding sessions;
- max drawdown in R, on equal-R sequential trades;
- the matched-control expectancy, and the difference.

Groups:
- all trades;
- by direction (long, short);
- by `triggerType` (inside, butn, brutn, mech1, mech2, egop);
- by direction × type;
- by market regime on the trigger day: SPY above or below its SMA20, from the backfill SPY rows;
- by calendar quarter, for stability.

### 5. Split and verdict
The same time split and folds as the harness: the newest 30% of trigger dates held out, plus 3 walk-forward folds.

**KEEP for a group**, only when all three hold:
- net expectancy > 0 **and** above its matched control in the held-out split;
- the same is true in at least 2 of 3 folds;
- there are ≥ 100 held-out trades.

Fewer than 100 trades is INSUFFICIENT.

The KEEP rule applies only to the primary groups:
- all trades;
- long;
- short;
- each `triggerType` × direction.

That's about 14 comparisons, and the pre-registration states the exact count. The regime and quarter groups are descriptive only.

### 6. Output
`scripts/simulate-stp.ts --dataset backfill [--exit A|B]` writes:
- a report to `scripts/output/`;
- one experiment-log row per exit;
- a trades CSV: ticker, dates, direction, type, fill, stop, exit, R gross and net, exit reason, control R.

It's read-only on the DB. Use the same NAS command pattern as validate-features (volume mounts, `GIT_COMMIT`, heap flag).

### 7. Tests (fixtures only)
- The fill rules: no fill, normal fill, a gap through the entry, a gap past the stop.
- Ambiguous stop-and-target on the same bar, including the fill bar.
- The time exit, and each STP exit rule (B) on synthetic bars.
- Cost conversion into R.
- One position per ticker.
- The control is deterministic with the seed.
- **No look-ahead:** a planted future bar can't change whether a trigger fires, and the entry decision uses only D+1's own bar.
- The KEEP and INSUFFICIENT verdicts.

Log only. No score, stage, label or rule changes. A KEEP leads to a Phase 4 paper-trading proposal, not a live rule.

## P3-0i3: historical earnings dates from SEC EDGAR (Chris, 2026-11-25)

**Why:** EGOP needs earnings dates, and the backfill has none. Yahoo gives only the next date. The NAS can't use TradingView (no API, and its terms forbid it). SEC EDGAR is free and complete: a US company's earnings release is furnished on **Form 8-K, Item 2.02** ("Results of Operations"), usually the same day or the next.

Branch `plan/p3-0i3-edgar-earnings`.

1. **Source:**
   - `https://data.sec.gov/submissions/CIK##########.json` per company (plus the `filings.files[]` older pages when 2 years need them).
   - Take the rows where `form == "8-K"` and `items` contains `2.02`. Record `filingDate` and `acceptanceDateTime`.
   - Ticker → CIK comes from `https://www.sec.gov/files/company_tickers.json`.
   - Use `SEC_USER_AGENT`, stay ≤ 8 requests per second, cache per CIK on disk, and use the shared retry helper.
2. **Before or after the open:** an acceptance time before 09:30 ET means the release came before the open, so the gap is that day. At or after 16:00 ET, the gap is the next session. Anything in between counts as during the session and is flagged.
3. **Output:** a per-ticker list of earnings sessions, written next to the backfill bar cache (`scripts/output/backfill-earnings/`). `simulate-stp` feeds it to `computeStp` as `earningsTs`, so EGOP can fire on the backfill.
4. **Coverage:** foreign filers (20-F / 6-K) and some ADRs don't file 8-K 2.02. Report the share of the universe with earnings dates, and leave the others null. Don't guess.
5. **Tests:** saved fixtures for the submissions JSON and the ticker map; parsing item lists; the before/after-open mapping across DST; older pages; a missing CIK.
6. **Live use, optional and log only:** keep Yahoo's next date for `days_to_earnings`, and add `last_earnings_session` from EDGAR to the features.

After it merges, rerun `simulate-stp`. The EGOP groups then get real trades.

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
1b. **Provider choice (Chris, 2026-11-24): CoinGecko or CoinMarketCap.** Both keys are in the NAS `.env`.
   - `CRYPTO_UNIVERSE_PROVIDER` = `coingecko` or `coinmarketcap`, default `coingecko`.
   - Keys:
     - `COINGECKO_API_KEY`, a demo key, sent as `x-cg-demo-api-key`.
     - `COINMARKETCAP_API_KEY`, sent as `X-CMC_PRO_API_KEY` to `/v1/cryptocurrency/listings/latest?limit=500&convert=USD`.
     - If Chris used different variable names in `.env`, use his names and document them in `.env.example`.
   - **Fallback:** if the chosen provider fails after retries, use the other one when its key is set, and log `[crypto-universe] provider=<x> (fallback from <y>)`.
   - **One normalized shape** feeds the rest of the pipeline: `{ id, symbol, name, marketCap, price, tags[] }`.
     - Tags for exclusions come from CMC `tags` (`stablecoin`, `wrapped-tokens`, and the staking or liquid-staking tags) or from CoinGecko categories, plus the explicit denylist.
     - Store the provider's id in `coingeckoId` for CoinGecko; for CMC, store `cmc:<id>` in the same field. No extra column.
   - Save a real response from **both** providers on the NAS as fixtures before writing either parser.
   - **Tests:** each parser, both directions of the fallback, and exclusions working the same on both fixtures.
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
