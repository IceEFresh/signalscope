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
- **Entry location vs the normal move: SUPERSEDED by §1f (swing structure).** The text below is kept for history only. A late entry in a move has less room to reach 3R before the move ends. Measure it for each trade.

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

**No add on the entry day** (Chris, 2026-11-24). Add orders go live from the session after the fill. If the fill bar already reached an add level, that level is checked from the next session under the gap rule above: a next-day open through it is a skipped add, and the next level stays live. Test: a fill bar that trades through +2R adds nothing that day.

### 1f. Entry location by swing structure (Chris, 2026-11-25). Replaces the weekly/monthly `week_used` / `month_used` test in §1d.
Chris's selection rule: how far into a stock's *typical move* the entry sits. A late entry in a rally has less room to reach 3R before the rally ends. Measure it from each stock's own swing history.

1. **Swings, by an ATR zigzag:**
   - A swing high is confirmed once price falls `k × ATR14` from it, and a swing low once price rises `k × ATR14` from it.
   - ATR14 is Wilder's, on the bar where the leg starts.
   - **Run all three thresholds:** k = **1.5, 2 and 3**.
   - Use confirmed swings only. On the trigger day, the current leg's start is the last confirmed swing, so there's no look-ahead.
2. **Profile per stock**, from confirmed legs in the 250 sessions up to the trigger day (fewer than 4 legs of a kind means null):
   - **Up-legs (rallies) and down-legs (pullbacks):** median and 75th-percentile size, in ATR units and in %; median duration in bars.
3. **Entry scores for a long** (shorts mirrored: down-legs as the move, up-legs as the pullback):
   - `rally_used = (fill − last swing low) / median rally size`
   - `rally_age = bars since the last swing low / median rally bars`
   - `room_3r = (median rally size − (fill − last swing low)) / (3 × R)`: ≥ 1 means a typical rally still has room for 3R
   - `pullback_ratio`: the size of the most recent confirmed pullback before the leg, divided by the median pullback
4. **Pre-registered test,** replacing §1d's 2 comparisons: trades with `rally_used < 0.5` **and** `room_3r ≥ 1`, versus all trades of that direction.
   - One test per k (1.5, 2, 3) × direction (long, short): **6 comparisons per exit**.
   - Same KEEP rule, plus it must beat all trades of that direction.
5. **Descriptive,** for each k:
   - expectancy and 3R-hit rate by `rally_used` bucket (`< 0.25`, `0.25–0.5`, `0.5–0.75`, `0.75–1`, `> 1`);
   - the same by `room_3r` (`< 1`, `≥ 1`);
   - the same by `rally_age` (`< 0.5`, `0.5–1`, `> 1`);
   - the same by `pullback_ratio` (`< 0.5`, `0.5–1`, `> 1`).
   - Also the per-stock profile distribution across the universe: median rally and pullback in ATR, and bars.
6. **Code:** a pure module `src/lib/harvester/universe/swings.ts`.
   - `zigzag(bars, k)` returns confirmed pivots.
   - `swingProfile(bars, t, k)` and `entryLocation(bars, t, fill, R, dir, k)`.
   - Reused later for live logging in P3-0i2.
7. **Tests:**
   - zigzag pivots on synthetic bars at each k;
   - no pivot confirmed before the reversal bar (look-ahead);
   - profile medians and percentiles;
   - null with fewer than 4 legs;
   - `rally_used`, `room_3r`, `rally_age` and `pullback_ratio` on a worked example;
   - shorts mirrored.

**P3-0i2** (live logging) also logs `swing_k{1.5,2,3}_{rally_used,rally_age,room_3r_at_entry,pullback_ratio}`, plus the profile medians, into the features JSON. `room_3r` uses the STP trigger's entry and stop when there is one; otherwise null.

### 1g. The Stock Market Power Pyramid: position size by layer agreement (Chris, 2026-11-25)
STP stacks order flow in four layers, top to bottom:
1. the 3 major indices;
2. the 11 sectors;
3. the industry groups;
4. the stock itself.

The stock's trigger is the setup. The layers above it set the **size**:
- everything agrees: **full size (1.0)**;
- one layer disagrees: **half (0.5)**;
- both the market and the sector disagree: **half again (0.25)**.

**Layer state = opens AND trend** (Chris, 2026-11-24: the layers are about trend too, not just the opens). Both are computed on that layer's ETF on the trigger day, using completed bars only:
- **Opens:** `stp_htf_opens` (close vs the weekly and monthly opens).
- **Trend:** the MA trend STP's mechanicals use. Up = close > sma50 and sma20 > sma50. Down = the mirror. Anything else is neutral.
- **Agrees** (for a long): opens = +1 and trend up. **Disagrees:** opens = −1 and trend down. **Anything else is mixed**, and mixed is not a disagreement.
- Descriptive variants, same reports: opens-only and trend-only layer states.
- **Market:** SPY, QQQ and DIA, each scored separately. The market layer agrees if the majority (2 of 3) is on the trade's side.
- **Sector:** the stock's SPDR sector ETF (from `UniverseMember.sector`, through the P3-0d/1f map).
- **Industry:** the stock's industry ETF (the 1f map). Null when the industry is unmapped.

Shorts are mirrored.

**Reviewer's assumptions:**
- The size rule uses the **market and sector** layers: 0 disagreeing gives 1.0, 1 gives 0.5, 2 gives 0.25.
- The industry layer is reported alongside. A variant also counts industry, with the size halved for each disagreeing layer.
- Mixed counts as not disagreeing.
- Chris can correct any of these before the run.

**Simulation:**
- Fetch the ETF bars for the backfill: SPY (already there), QQQ, DIA, the 11 sector SPDRs, and the mapped industry ETFs. Cache them next to the stock bars, sliced to day D like everything else.
- Sector and industry use today's mapping (survivorship caveat).
- Each trade gets `size_mult` (1, 0.5 or 0.25) and `pyramid_layers` (market, sector and industry, each agree, mixed or disagree).
- Report **both** of these: unweighted R, the per-trade edge; and **size-weighted R** (R × size_mult), the portfolio effect of the sizing rule.
- **Pre-registered, +2 comparisons per exit:** "all agree" trades (market and sector both agree) vs all trades, long and short. Same KEEP rule.
- **Descriptive only:** expectancy and 3R-hit rate by size_mult (1, 0.5, 0.25), by each layer's state, and for the industry-included variant. Also total size-weighted R and max drawdown, with the sizing rule vs flat size.

**Live logging (P3-0i2):**
- `pyramid_market` with SPY, QQQ and DIA htf, plus the vote; `pyramid_sector` with the ETF and its htf; `pyramid_industry` with the ETF and its htf.
- `pyramid_size_long` and `pyramid_size_short`.
- Log only.

**Tests:**
- the 2-of-3 index majority;
- opens agree but trend down is mixed, not agree;
- mixed is not a disagreement;
- size 1, 0.5 and 0.25 cases;
- shorts mirrored;
- a null industry;
- ETF bars sliced to D (look-ahead).

### 1h. Fixed dollar risk per position (Chris, 2026-11-24)
Every position risks the same dollars. **Base risk = $100 × size_mult** (so $100, $50 or $25 after §1g).
- **Initial shares** = floor(base risk / (entry − stop)), shorts mirrored. **0 shares means no trade**: log it as `size_skip` and count it per pattern.
- **Each add** = floor(50% of current shares). 0 means no add. The add fills at its stop-limit level under §1e's gap rule.
- **Dollar P&L** = shares × price move per unit, summed over units, minus 0.10% per leg on the traded value.
- **R** stays defined as dollar P&L ÷ the initial base risk. With fixed risk, unweighted R is the per-trade view and dollar P&L (which already includes size_mult) replaces the separate "size-weighted R" in §1g.
- **Report:** total dollar P&L, max drawdown in dollars, trades per day, and the largest number of open positions and total open risk on any day (no cap is applied; this sizes the account the method needs).
- **Tests:** floor rounding, a wide stop giving 0 shares (`size_skip`), an add rounding to 0, a short.

### 1i. Chris's Finviz screens as candidate filters (Chris, 2026-11-24)
Definitions are in `docs/FINVIZ-SCREENS.md` (F01 to F28). All of them are computed from our own bars on day D. Nothing is pulled from Finviz.
- **New module `src/lib/harvester/universe/finviz-screens.ts`:** `screensOn(bars, D) → { base: bool, F03: bool, ... }`, using bars ≤ D only.
  - F01 and F02 need earnings dates (P3-0i3), so they're null until that lands.
  - F07 and F16–F19 need short float, which has no history, so they're null on the backfill and logged live only.
- **Simulation:** each trade gets `finviz_base` and `finviz_screens` (the list of IDs passing on D).
- **Pre-registered:** the base filter vs all trades, long and short: +2 per exit. Base = avg vol > 2M and ATR > $1.50.
- **Per-screen, pre-registered** (directions set 2026-11-24 in FINVIZ-SCREENS.md): screen ∩ trades vs all trades of that direction.
  - On the backfill: 20 one-direction OHLCV screens, plus F28 long and short. That's **+22 per exit**, so **51 per exit** in total. At a nominal 5%, about 2–3 KEEPs could come from chance before the fold rule.
  - F01 and F02 add 4 (long and short) once P3-0i3 lands. They're pre-registered now.
  - Short-float screens (F07, F16–F19) are live only, with no backfill verdict. Screens with fewer than 30 trades per fold are reported, never judged.
- **Caveat:** ATR > $1.50 is in dollars, so it favours high-priced stocks. Report the base filter's median price vs all trades.
- **Live (P3-0i2):** log `finviz_base` and `finviz_screens` per ticker per harvest, including the short-float and earnings screens.
- **Tests:** each filter on a hand-built series at its edge (≥2% vs 1.99%, a new 20-day high on exactly the 20th bar); the cross-below-sma20 case; a null short float gives null, not false; and look-ahead (a planted D+1 bar changes nothing).

### 1j. Sizing and adds as in Chris's Pine script (Chris, 2026-11-24). Supersedes conflicting lines in §1e, §1g and §1h
**Adds (replaces "every 2R" in §1e):**
- Add levels are at fill ± n × 2 × ATR14, for n = 1, 2, 3, ..., where ATR14 is taken at the trigger bar D (the Pine `addShares = highPlusFF + atrFactor × ATR`, with `atrFactor = 2` at 3R).
- Each add is 50% of the current shares, rounded down.
- The breakeven after an add is the size-weighted average cost (the Pine `moveSL = (2·entry + add)/3` for the first add).
- No add on the entry day (§1e). The gap rule is unchanged.

**Profit target:**
- 3R is the primary: the trail starts once 3R is touched (§1e).
- **Descriptive variant, the "choppy" rule:** the trail starts at 2R and adds every 1 × ATR (Pine `atrFactor = 1` when RR = 2). It's run on all trades and reported split by the market layer (agree vs mixed or disagree), because Chris sets RR by hand and there's no objective "choppy" flag yet.

**Size:**
- Size = **stock factor × pyramid factor, floored at 0.25.**
- **Stock factor,** from the Pine `shareSizeFactor` with its absolute-value bug fixed (Chris: "the MAs should knock it down to half"). Full size (1) for a long needs both:
  - `stp_htf_opens = +1`;
  - MAs stacked in the trade's direction: close > sma20, close > sma50 and sma20 > sma50.
  
  Otherwise it's 0.5. Shorts are mirrored. Opens of −1 or MAs stacked against the trade are 0.5, not 1.
- **Pyramid factor:** §1g (1, 0.5 or 0.25 from the market and sector layers).
- Example: a stock at 0.5 with a pyramid at 0.25 gives 0.125, floored to **0.25**. Chris never enters at less than 1/4 size.

**Risk:**
- **Base risk = $200 × size** (it was $100 in §1h).
- Shares = floor(base risk / (entry − stop)). **No max-trade-size cap** in this test.

**Reports and pre-registration:**
- The §1g "all agree" comparisons stay as they are.
- Descriptive additions: expectancy by stock factor (1, 0.5), by combined size (1, 0.5, 0.25), and the floor-hit count. Also the share of trades where the old `abs()` rule would have given full size but the fixed rule gives half.
- The live `stp_size_factor` keeps the Pine `abs()` formula for parity. P3-0i2 adds `stp_size_factor_long` and `stp_size_factor_short` (fixed rule) and `size_combined_long` and `size_combined_short`.

**Tests:**
- adds at 2 × ATR(D), not 2R;
- the second add at 4 × ATR;
- opens +1 with bearish-stacked MAs on a long gives 0.5;
- 0.5 × 0.25 floors to 0.25;
- shares at $200;
- the choppy variant adds at 1 × ATR and trails from 2R.

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

## P3-0i4: max 3 adds, sector profiles, rerun (reviewer, from the first P3-0i run, 2026-11-25)
**1. Max 3 adds** (Chris, 2026-11-25). This amends §1e and §1j.
- Exits B and C stop adding after the 3rd add, so the largest position is 1 × 1.5³ = 3.375 units. The stop still moves to the size-weighted breakeven after each add.
- Why: in the first run, ASST (rolling, 2025-04-29) added 40 times, reached 130 × 1.5⁴⁰ shares, and lost $11.0B on a gap through its breakeven. ABVX added 12 times for −$36k (≈ −180R).
- Report "add cap reached" counts per group.
- Test: a 6-level run fills 3 adds and no 4th.
- The pre-registration is unchanged (49). Add one line to PHASE3-PREREG.md, before the rerun, saying the cap was set after the first run's blow-up, not tuned on results.

**2. Sector and industry profiles are empty.** The universe from 2026-11-24 has 0 of 1,485 stocks with a sector, even though `quoteSummary('AAPL', {modules:['assetProfile']})` works on the NAS.
- `fetchSectorIndustry` swallows every error (`catch { /* non-fatal */ }`), so the cause is invisible.
- **Fix:**
  - Count failures and log the first 3 error messages plus `[universe] profiles: n/m fetched`.
  - Add a pause between batches and respect `withYahooRetry` backoff on 429s.
  - Warn when fewer than 80% are fetched.
- **One-off script, `scripts/backfill-profiles.ts`:** fills `sector`/`industry` on the latest universe's members where null. It updates existing rows only; no schema change. Show the run's summary line in the PR.
- **Tests:** a stub that throws for some symbols gives correct counts and logged messages; a 429 is retried; the script only updates null rows.

**3. Simulation outlier visibility.**
- The report lists the 5 largest dollar losses and gains per exit (symbol, date, adds, shares, dollar P&L, R).
- Any trade beyond ±50R gets a WARNING line.

**4. Rerun.** After 1–3 are merged, Chris runs `backfill-profiles.ts`, then `simulate-stp.ts`.

## P3-0j: stock selection funnel, daily top 3–5, pullback entry, event and earnings rules (Chris, 2026-11-25)
**Why.** P3-0i showed that taking every STP trigger loses money. On held-out data, all trades made −0.25R against −0.07R for random-day entries with the same management. Long random-day entries under STP management made +0.04R, and +0.14R when market and sector agree. Chris: "The real trick with the STP stuff is stock selection… if it's a bad idea to begin with, there is nothing we can do to dress it up."

This item models the method as Chris trades it:

```
universe ──► 1. selection gates ──► 2. STP trigger ──► 3. R/R ranking ──► top 5 per day ──► 4. entry ──► 5. size ──► 6. exits
```

**1. Selection gates.** A stock-day is a candidate only if every gate passes. Each gate is computed on D with completed bars only.
- **Finviz base:** avg vol > 2M and ATR > $1.50 (§1i).
- **Direction allowed by the market.** Longs are always allowed. Shorts are allowed in any market, but sized down by step 5. Chris: "why would we take shorts in a roaring bull market unless the R/R is unbelievable". A counter-trend short (market layer agrees with long) also needs R/R ≥ 4 at step 3; the normal gate is 3.
- **No own earnings within 5 sessions** after D. EDGAR dates (P3-0i3) on the backfill; Yahoo's calendar live.
- **Macro events don't block entries** (Chris, 2026-11-25). They change size and stops instead; see steps 5 and 6. The calendar is checked in at `src/lib/harvester/macro-calendar.json`. Each event has its date, release time (ET) and a source URL (federalreserve.gov, bls.gov, bea.gov, census.gov), and is tagged:
  - **out-of-hours** (can gap against us at the open): CPI, PPI, the jobs report (NFP), PCE, the GDP advance estimate and retail sales, all at 08:30 ET. Weekly jobless claims are excluded; they come every Thursday and would halve every trade.
  - **in-hours:** FOMC statement days (14:00 ET) and any release between 09:30 and 16:00 ET.
  
  The health report warns when the calendar has less than 60 days left.
- **Live only, no history:** social sentiment and insider buys are logged per candidate and not gated in the backfill. They become candidates for the next pre-registration once there are ≥ 6 months of live data.

**2. STP trigger:** the calendar `computeStp` triggers, as in P3-0i.

**3. Risk/reward from nearby support and resistance.**
- For a long, the levels above the entry are:
  - zigzag swing highs (k = 2) from the last 250 sessions;
  - sma20, sma50 and sma200;
  - the weekly and monthly opens;
  - the 20- and 60-session highs.
- **Room** = the nearest level above entry minus entry. **R/R** = room ÷ (entry − stop). Shorts are mirrored.
- Levels within 0.25 ATR of the entry are ignored, because a level that close is one the breakout is already through.
- No level within 10 ATR gives R/R = room to 10 ATR, flagged `open_air`.
- Gate: R/R ≥ 3, or ≥ 4 for a counter-trend short.
- **Rank** each day's candidates by R/R, ties broken by §1f `rally_used` (lower first). Take the **top 5**.
- Variants: top 3, and all candidates passing the gates. Each variant is descriptive.

**4. Entry**, two arms on the same top-5 list:
- **(a) Stop entry:** P3-0i as is.
- **(b) Pullback entry:** a limit order at the trigger bar's **midpoint**, good for day D+1 only. Same stop (low − fudge), so the risk is smaller and the shares larger at the same dollar risk. A bar that gaps below the stop at D+1's open isn't filled. A bar that trades through both the limit and the stop on D+1 is filled and stopped the same day, at −1R plus costs; that's conservative.
- Descriptive variant: a limit at the trigger bar's low + fudge.

**5. Size:** §1j, stock factor × pyramid, **× 0.5 when an out-of-hours event falls within the 5 sessions after D**, floored at 0.25, at $200. The report shows the share of trades halved and their results. This already matches Chris's counter-trend rule:
- a short in a strong uptrend, with the market disagreeing and the sector disagreeing, gets 0.25;
- if the sector or the MAs agree with the short, it gets 0.5.

The report shows the size distribution of counter-trend shorts.

**6. Exits:** §1e and §1j management (adds every 2 × ATR, max 3, breakeven, trail after 3R), **plus the in-hours event rule and the earnings rule.**
- **Event stop rule** (Chris, 2026-11-25). It applies to open positions before **any** macro event, in-hours or out-of-hours.
  - Out-of-hours (08:30 ET) releases: set at the close of the session **before** the release, so it's live at the release day's open.
  - In-hours releases (FOMC 14:00 ET and other market-hours releases): set at the close of the session before, so it's live all of event day.
  
  Open profit is measured at that close (close − fill for a long, mirrored for a short):
  - profit ≥ **2R** → the stop becomes the **bar stop** (prior bar low − fudge);
  - **1 ATR** ≤ profit < 2R → the stop moves to **breakeven** (the size-weighted average cost);
  - profit < 1 ATR → **leave the stop as is**.
  
  The stop only ever tightens: if the trail or the add-breakeven is already tighter, keep it. Count trades by tier (`event_bar`, `event_be`, `event_hold`) and how each exited.
- **Never hold through earnings.** From 2 sessions before the stock's next earnings session E, the stop becomes the bar stop (prior bar low − fudge) if that's tighter.
- At the close of E−1, any open position is sold at market (`exit_reason = earnings`).
- On the backfill, E comes from EDGAR, which is a mild look-ahead: dates are usually announced 2–4 weeks ahead. The report counts trades whose E was less than 10 sessions after entry.

**Evaluation.**
- Backfill exit B management, the newest 30% held out, plus 3 walk-forward folds, with the existing KEEP rule. Each comparison uses its own matched random-day control.
- Account view: peak open positions and open risk under "top 5 new per day". No position cap is applied; the peak is reported.
- **Pre-registered, 4 per entry arm, 8 in all:**
  1. funnel top-5 vs all trades, long;
  2. the same, short;
  3. funnel top-5 vs its matched random-day control, long;
  4. the same, short.
  
  Plus **2 arm comparisons**: pullback vs stop entry on the funnel top-5, long and short. **10 in all.**
- **Honesty note for PREREG:** the funnel rules are Chris's existing method, stated before these results. The pullback entry was proposed **after** seeing P3-0i's control gap, so its backfill verdict is provisional. A KEEP on it only counts once it's confirmed on ≥ 6 months of live universe data.

**Live logging (log-only):**
- `funnel_pass` and its gate reasons (`gate_finviz`, `gate_earnings5`, `gate_rr`), `event_half` (an out-of-hours event within 5 sessions), `event_today_inhours`, plus `rr`, `rr_level` (which level), `open_air`, `funnel_rank`, and `countertrend`;
- `next_event` and `next_event_days`, and `days_to_earnings` (Yahoo);
- `sentiment_*` and `insider_*`, copied from the existing Phase 2 sources onto candidate rows.

**Tests:**
- each gate at its edge (earnings exactly 5 sessions out vs 6);
- an out-of-hours event 5 vs 6 sessions out halves the size or doesn't, and 0.5 × 0.25 still floors at 0.25;
- the event stop rule at each tier edge (profit just under and at 2R, just under and at 1 ATR), set on the session before for both in-hours and out-of-hours events, and it never loosens an already tighter stop;
- R/R: the nearest level, the 0.25 ATR ignore rule, `open_air`, and a short mirrored;
- the ranking tie-break, and top-5 truncation;
- pullback: filled at the midpoint; no fill; gap below the stop; limit and stop on the same bar give −1R;
- the earnings rule: the bar stop from E−2 and the forced exit at the close of E−1;
- the counter-trend short gate at 4R and its size;
- calendar look-ahead: an event dated after D+5 doesn't halve D;
- the calendar-expiry warning.

No migration; the macro calendar is a JSON file. No dependency.


## P3-0j3: fixes from the first funnel run (reviewer, 2026-11-25)
The first `simulate-funnel` run (2026-11-25) turned up one bug, one control problem and two gaps in the reports. Pre-registration is unchanged at 10 comparisons; each change below goes into PHASE3-PREREG.md with its date, **after** the first run.

**1. Pullback sizing bug (confidence 9/10).**
- In `limitEntryOnNextBar`, when D+1 opens below the limit the fill is the open and `risk: fill − stop`. An open a cent above the stop gives risk ≈ $0.01, so shares ≈ $200 / 0.01. That's how `all / pullback` reached −$211.7M and −27.9R per trade.
- A real limit order's share count is fixed when the order is placed.
- **Fix:**
  - shares = floor(base risk / (limit − stop));
  - the R unit is (limit − stop);
  - a fill at a better open keeps the same shares, with real risk (fill − stop) × shares, never more than planned;
  - the add levels, the 3R trail trigger and the event tiers use the planned R unit from the actual fill.
  - Same for `pullback_low` and for the pullback controls.
- **Tests:**
  - an open 1 cent above the stop: the share count comes from the limit risk, and a gap through the stop the next day loses ≤ 1R plus costs;
  - an open at the limit is unchanged.
- **Every pullback verdict from the first run is void.**

**2. Matched controls taken before the trigger are biased.**
- The control split shows inside-bar controls at **+0.38R before the trigger (n = 569) vs −1.08R after (n = 570)**, and mech2 at +0.30 vs −0.25.
- A control day before the trigger is chosen knowing a trigger comes later. The trend criteria require price above the opens, so pre-trigger days sit inside the run-up that produced them. This is the same look-ahead as EGOP (P3-0j2), in milder form.
- **Fix:** for **all** patterns, draw controls only from sessions after the trigger (c > i, within 20 sessions).
  - Verdicts use the after-only control.
  - Reports also show the ±20 control, descriptive, so the change is visible.
- **Honesty note for PREREG:** this was changed after the first P3-0i and P3-0j results, as a validity fix. Any KEEP that appears only under the after-only control is **provisional** and needs live confirmation.
- Applies to `matchedControl` (P3-0i) and `funnelControl` (P3-0j).

**3. Event stop rule counterfactual.**
- The tier groups (`event_bar` +3.05R, `event_be` +1.03R) are selected on open profit, so they can't show whether the rule helps.
- **Fix:** rerun every top-5 trade with the event rule off, and report per tier: R with the rule, R without, and the difference. Descriptive.

**4. R/R ranking diagnostics.**
- 476 of the 567 top-5/stop trades are `open_air`, so the ranking mostly rewards a tight stop on a stock with no level within 10 ATR.
- **Fix (descriptive only; the ranking rule itself is unchanged, since changing it now would be fitting):**
  - top-5 results by `open_air` and by R/R quintile;
  - the median stop distance in ATR, top-5 vs all;
  - a variant ranking with `open_air` excluded.

**Rerun:** `simulate-funnel.ts`, then `simulate-stp.ts --dataset backfill`.

## P3-0k: aligned-trend setups, the primary track (Chris, 2026-11-25)
Chris: "We really need to focus on finding good stocks near an optimal entry with at least 3:1 risk reward." **EGOP isn't a primary entry**, and it's descriptive from here on.

**Alignment, one definition for every layer** (stock, its industry ETF, its sector SPDR, and the market by a 2-of-3 vote of SPY, QQQ and DIA), on completed bars ≤ D:
- **Opens green** for a long: close > the **monthly** open, the **weekly** open, the **rolling 20-session** open and the **rolling 5-session** open. Shorts mirrored. Crypto rows use 30 / 7.
- **MAs stacked and sloped** for a long:
  - close > sma10 > sma20 > sma50 > sma200;
  - each of the four MAs rising: today's value above its value 5 sessions ago.
  
  Shorts mirrored.
- A layer is **aligned** when both hold, **against** when both hold the other way, and **mixed** otherwise.

**Candidate (stock-day):**
- the Finviz base (avg vol > 2M, ATR > $1.50);
- the stock is aligned in the trade's direction;
- no earnings within 5 sessions.

**Entry:**
- An STP trigger in that direction, either calendar or rolling (inside, U-turn, mech1 or mech2).
- **R/R ≥ 3** to the nearest level (§P3-0j step 3).
- **Optimal entry:** the stop is at most 0.5 ATR beyond the nearest support below the entry. Support means sma10, sma20 or sma50, a confirmed k = 2 swing low, or the weekly or monthly open. Shorts mirrored. That is, the trade is entered off support, not in the middle of a move.

**Size:** full (1.0) when the industry, the sector and the market are all aligned with the stock. Each mixed or against layer halves it, with a floor of 0.25. Out-of-hours events × 0.5 and the event stop rule as in §P3-0j. $200 base risk.

**Management:** exit B (adds every 2 × ATR, max 3, breakeven, trail after 3R) plus the event and earnings rules.

**Pre-registered, 4 comparisons, after P3-0j3 merges:**
1. aligned candidates with an optimal entry vs all STP trades, long;
2. the same, short;
3. aligned candidates with an optimal entry vs their matched **after-trigger** control, long;
4. the same, short.

Same KEEP rule.

**Descriptive:**
- results by size (1, 0.5, 0.25);
- without the optimal-entry gate;
- opens-only and MAs-only alignment;
- stop entry vs pullback (after the P3-0j3 sizing fix);
- counts per layer state.

**Expect a small sample.** All 8 conditions on 4 layers at once is strict, so the report prints the funnel counts at each gate. An INSUFFICIENT result means wait for more data, not a rule change.

**Live keys (log-only):** `align_stock`, `align_industry`, `align_sector`, `align_market` (aligned, mixed or against, per direction), `optimal_entry`, `p3k_candidate`, `p3k_size_long`, `p3k_size_short`.

**Tests:**
- each of the 4 opens and 4 MAs at its edge;
- a slope that's flat over exactly 5 sessions isn't rising;
- the 2-of-3 market vote;
- the optimal-entry edge at 0.5 ATR;
- the size halving per mixed layer, with the floor;
- crypto at 7 / 30;
- look-ahead.

## P3-0k4: moves, not legs. Replaces the P3-0k3 room gate (Chris, 2026-11-26)

**Why:** the k = 2 ATR zigzag pivots at every pause, so its median (about 3.6 ATR) is one push, not a move. 3R from an STP entry (about 3.6–4.5 ATR) is larger than one push, which is why the P3-0k3 room gate passed 3 longs and 1 short. Chris: "the rallies will have a push and a pause several times through a 'move'. Ideally we are finding a pause in the move once it's started and optimal entry is during a pullback (BUTN, mechanical) or a contraction in volatility (inside day)." **Set after the second P3-0k3 run (#100), so everything here is provisional.**

**Move detector** (per stock, long; shorts mirrored; bars ≤ D only). One move active at a time; start signals during an active move are ignored.
- **Start**, the first of:
  1. **swing low:** a confirmed k = 2 swing low above the previous confirmed swing low (start date = the swing low's bar, known from its confirmation bar on);
  2. **U-turn:** a rolling or calendar butn trigger (start = trigger bar);
  3. **range breakout:** close > the highest high of the prior 20 sessions, where that 20-session range (max high − min low) ≤ 3 × ATR14, **and** the stock passes F25 (New 20-Day High) or F22 (20 Day Breakout 75% Volume) that day (Chris, 2026-11-26: "the finviz 20-day high scan is a good filter for breakouts").
- **Move low** = the lowest low from the start bar back to the last confirmed swing high (for a breakout, the range low). Gains are measured from it.
- **End**, the first of (end date = the bar the end is known):
  1. **bearish U-turn on volume:** a brutn trigger (rolling or calendar) whose bar volume > its 20-session average volume (Chris, 2026-11-26: "reversal candle on higher than average volume");
  2. **mX / pmX broken:** when the mX rule (close crosses below sma20, or sma10 crosses below sma20) or the pmX rule (trendDirection[t−1] ≥ 1 and close crosses below sma10) fires on bar t, it arms level low[t] − fudge(t) (`trailCandidate`, same rules). The move ends on the first later close below the armed level. A newer signal replaces the level; a close at a new move high disarms it. Reviewer's reading of "pmX or mX would also likely signal the end": the signal sets the stop, breaking it ends the move, the way it works in a trade.
  3. **structure:** a lower confirmed swing high followed by a close below the last confirmed swing low;
  4. **failed breakout:** for a range-breakout start, a close back below the range low.
- **Per completed move, record:** start type, end type, size = (move high − move low) ÷ ATR14 at the start, legs (pushes between confirmed k = 2 pivots inside the move), duration in sessions, depth of each pause in ATR. A move under 1 ATR is a **failed start**: counted, excluded from the size profile.

**Move profile** (the input that replaces the swing profile in the gate): the stock's completed moves whose **end date** ≤ D within the last 750 sessions, at least 3 of them; median and 75th-percentile size, median legs. Moves still open at D never enter the profile (look-ahead). No profile → no candidate (counted).

**Position at entry**, for the move active at D:
- `pauses_so_far` = confirmed k = 2 swing highs inside the move before the trigger bar, plus 1 if the trigger bar is an inside day or a pullback (mech1/mech2, butn) below the move high. 0 means the trigger is on the first push.
- `move_used` = (entry − move low) ÷ ATR14(D) ÷ median move size.
- No active move at D → not a candidate (counted, and reported as its own row).

**Gate (replaces "room to 3R"; everything else in P3-0k3 unchanged):** an active move, `pauses_so_far` ∈ {1, 2}, `move_used` ≤ 0.5. **Chosen before any P3-0k4 run** from Chris's words; the report must not be used to move these cutoffs without a new provisional amendment.

**Descriptive, printed before the gated results:**
1. universe move profile: median/75th size, legs per move, duration; start-type and end-type mix; failed-start rate per start type;
2. P3-0k3 trades (gate off) grouped by `pauses_so_far` (0, 1, 2, 3, 4+) and `move_used` quintile;
3. end-rule variants: pmX/mX **firing** ends the move (no arming); bearish U-turn without the volume condition; structure only. Legs per move under each, so a too-tight end rule shows up as ~1 leg per move;
4. range width 2 / 3 / 4 ATR; breakout without the Finviz filter;
5. the old room gate side by side.

**Pre-registered:** the 4 P3-0k3 comparisons with this gate in place of the room gate, labelled `p3k4`. KEEP rule as P3-0k; provisional.

**Live keys (log-only):** `move_active`, `move_start_type`, `move_pauses`, `move_used`, `move_profile_median_atr`, `p3k4_candidate`.

**Tests:** each start type (incl. range > 3 ATR rejected, no F25/F22 rejected); a start during an active move ignored; each end type; brutn at or below average volume doesn't end; mX/pmX arm → break ends, arm → new high disarms; failed start < 1 ATR excluded from profile; a move ending after D excluded from D's profile; < 3 moves → no candidate; `pauses_so_far` 0/1/2/3 edges; `move_used` 0.5 edge; short mirror; no look-ahead (shift future bars, profile unchanged).

**As built (P3-0k4 PR):** readings where the spec left a choice. None of them moves a gate cutoff.
- **Same-bar ties:**
  - starts are checked in the listed order (swing low, U-turn, breakout);
  - ends are checked in the listed order (U-turn on volume, mX/pmX break, structure, failed breakout);
  - a move's end rules apply from the bar after its start is known;
  - a new move can start from the bar after an end.
- **U-turn triggers** (start and end) come from STP on every bar of the history, not only the scanned backfill window, so the 750-session profile isn't missing them. STP only runs on bars with the U-turn candle shape. A U-turn counts even when STP's single reported trigger on that bar is another type (`firedRules`).
- **Move low:** with no confirmed swing high before the start, the move low falls back to the lowest low of the 20 sessions up to the start bar.
- **Breakout:** the 20-session range is checked against ATR14 on the breakout bar. Shorts use F08/F13, the mirrors of F25/F22.
- **mX/pmX:** mX is close × sma20 or sma10 × sma20; pmX is trend[t−1] ≥ 1 and close × sma10, both against the move. The armed level is low − fudge of the bar that fired, and it applies from the next bar. The exit-B "extended" bar-stop rule isn't part of it.
- **Structure:** the first swing high confirmed inside the move is compared with the last confirmed swing high before the move.
- **Legs and pauses:**
  - legs = confirmed pauses + 1;
  - a pause is a confirmed swing high followed by the next confirmed swing low, both inside the move and confirmed by its end;
  - pause depth is in ATR14 at the start.
- **`pauses_so_far`:** "below the move high" applies to every pause trigger (inside, mech1, mech2, and the U-turn in the trade direction, so brutn for shorts). It compares the trigger bar's high with the move's high before that bar.
- **Verdicts:** the held-out cut is computed over the P3-0k3 runs plus p3k4, the same basis as P3-0k3. The benchmark is `p3k3_all`.
- **Live keys:**
  - the move is the one in the entry trigger's direction, or with no trigger, the active one (long first);
  - `move_pauses`, `move_used` and `p3k4_candidate` need an entry trigger and are null without one;
  - the keys are computed from the bar store history (at least 60 bars).

## P3-0k5: 5-year backfill window (Chris, 2026-11-26)

**Why:** P3-0k3 without the room gate gives 149 trades in 2 years, about 45 held out against the 100 KEEP needs. 5 years gives roughly 375 / 110 at the same rate, and enough completed moves per stock for the P3-0k4 profile.
- `backfill-snapshot.ts --years 5` (the flag exists; check warmup, the bar store and memory on the NAS). ETF bars (sector, industry, SPY/QQQ/DIA) to the same window.
- EDGAR earnings and Form 4, FINRA short interest and short volume, House PTRs: extend to 5 years where the source has it; where it doesn't, the field is null before its first date, never 0. Print each source's first date in the report.
- Macro calendar: add 2021-11 → 2024-11 FOMC, CPI, PPI, NFP (reviewer adds to `macro-calendar.json` on a docs branch).
- **Survivorship:** today's universe only, so delisted losers are missing and the bias grows with the window. Every P3-0k3/0k4 report prints results for years 1–3 and years 4–5 separately; a KEEP needs both halves positive on the primary metric.
- Held-out and folds keep their definitions (newest 30%, 3 walk-forward folds) over the longer window.
- Tests: `--years 5` window math with warmup; null-before-first-date for a source with shorter history.

**As built (P3-0k5 PR):**
- **Window:** `backfillWindow` holds the shared window math: fetch from 5 × 365 + warm-up days back, and backfill from 5 × 365 days back.
- **Stale caches:** a chart cached for a shorter window (the existing 2-year cache) is refetched by `backfill-snapshot` and by `simulate-stp`'s ETF cache. It's kept when it reaches the window start within 10 days, or starts at the symbol's first trade (a later IPO).
- **Source coverage, checked 2026-11-26.** Every source reaches back 5 years:
  - EDGAR (earnings 8-K and Form 4): 2001 on;
  - FINRA: `CNMSshvol20211129` and `shrt20211115` both exist;
  - House PTRs: 2008 on.
- **Coverage gaps:** "null before the first date" still holds when a source was built with fewer years than the simulation:
  - the earnings gate is unknown (null) before the earnings file's `from`;
  - `ins_*` and `cong_*` are null before their `from`;
  - `si_*` and `sv_*` are null until their first file.
  - The report prints each source's first date and whether it covers the window.
- **Survivorship check:**
  - years 1–3 run from the window's first session to its 3-year anniversary, and years 4–5 run after that;
  - the primary metric is the selection's net expectancy (R) over all its trades in each half;
  - a KEEP with either half ≤ 0 becomes DROP, with the reason;
  - a window of 3 years or less has no years 4–5, so the check is n/a and doesn't block a KEEP.
  - It's applied to the P3-0k3 and P3-0k4 comparisons.
- **Macro calendar:** 2021-11 → 2024-11 is left to the reviewer, as the spec says. The coverage table has a macro-calendar row (first event vs window start). When the calendar starts after the window start, the report and the console print a warning: before that date the simulation sees "no event", not "unknown", so event sizing and stops don't fire.
- **Run on the NAS, in order:**
  1. `backfill-snapshot.ts --years 5`;
  2. `simulate-stp.ts --years 5` (ETFs);
  3. `backfill-earnings.ts --years 5`, `backfill-form4.ts --years 5`, `backfill-finra.ts --years 5`, `backfill-house-ptr.ts --years 5`;
  4. `simulate-aligned.ts --years 5`.

## P3-0l: smart-money and sentiment watchlist, the second track (Chris, 2026-11-25)
Chris: "The smart money tips its hand at some point, and we want to be ready to follow along." These names often fail the P3-0k criteria, and that's expected. They're watched, not filtered out.

**Watchlist (live, log-only).** A ticker is on the watchlist for 10 sessions after any of these fire, using the sources the harvester already has:
- Reddit, StockTwits or X/Twitter mention spikes;
- an SEC Form 4 insider **buy**;
- a congressional **buy**;
- a volume spike (`volume-spike.ts`);
- options flow with net premium in one direction;
- a Polymarket event tied to the ticker.

Each row logs `watch_sources` (the list), `watch_first_seen`, and `watch_direction` (bullish or bearish, from the source).

**Entry readiness (no criteria gates):**
- `watch_entry_ready` is true when an STP trigger in the watch direction appears with **R/R ≥ 3** (Chris: every trade needs at least 3:1).
- The Finviz base, the alignment and the opens aren't required.
- Size follows the P3-0k layer rule, so a name moving against its sector or market gets ½ or ¼ automatically.
- Log the P3-0k layer states next to it, so we can see later whether alignment still matters for these.

**Evaluation:**
- **Volume spikes** have price history, so the "volume spike → STP trigger with R/R ≥ 3 within 10 sessions" population can be backfilled now. That's descriptive, not pre-registered, until P3-0k has run.
- Social, insider, congress, options and Polymarket have no usable history here. They're judged after **6 months of live data**, per source and pooled, against the same after-trigger control. The comparisons will be pre-registered before that read.
- **Source health:** Reddit and StockTwits were fragile on day 1 (DATA-SOURCES.md). The harvest health report shows each watch source's hit count per run, and warns when one has zero hits for 3 runs in a row.

**Tests:**
- the 10-session watch window, at its edge;
- direction per source (an insider sale isn't a buy signal);
- `watch_entry_ready` needs R/R ≥ 3 and the matching direction;
- a source with no data is null, not false;
- the zero-hit health warning.

## P3-0k3: aligned trend v2, with looser stock criteria and more sizing inputs (Chris, 2026-11-25)

**Entry triggers (Chris, 2026-11-25): "We just want inside day, U-turn and both mechanicals for entries."** That means rolling inside, rolling U-turn (butn/brutn), mech1 and mech2. EGOP and every other trigger type are excluded from P3-0k3, **and from live P3-0l `watch_entry_ready`.** That key currently takes any calendar trigger, EGOP included, and needs the same four-trigger set. Test: an EGOP-only or calendar-only inside trigger never sets `p3k3_candidate` or `watch_entry_ready`.
**Set after the first P3-0k run** (2026-11-26 12:xx UTC, INSUFFICIENT, aligned long −0.62R held out). Chris defined it from the criteria alone, before seeing that report's gate or size breakdowns. It's a new hypothesis, so a backfill KEEP is **provisional** until it's confirmed on live data. P3-0k stays as it was; this one runs beside it.

**Stock candidate (gates), for a long; shorts mirrored:**
- **MAs:** close > sma20 > sma50 > sma200 **or** close > sma50 > sma20 > sma200. Put another way, close > max(sma20, sma50) and min(sma20, sma50) > sma200. **sma10 isn't used.**
  - Reviewer's assumption: Chris restated the MA rule without slopes, so the slope requirement is dropped from the gate. A descriptive variant keeps "sma50 and sma200 rising over 5 sessions".
- **Opens:** close > the **weekly** open **or** > the **rolling 5-session** open (crypto: weekly or rolling 7). Chris, 2026-11-25.
- **Chris's named Finviz screens replace the plain Finviz base.** The stock must pass at least one screen in the trade direction on D. Each screen includes the base filter. The mapping to FINVIZ-SCREENS.md IDs was confirmed by Chris on 2026-11-25:

  | Chris's name | Long | Short (mirror) |
  |---|---|---|
  | Double Volume | F28 (relvol > 2) | F28 |
  | Above SMA20 | F26 (up ≥ 2% from open, close > sma20) | F10 (down ≥ 2%, close < sma20) |
  | New 20-Day High | F25 (up on the day, up ≥ 2% from open, new 20-day high; confirmed by Chris) | F08 (down ≥ 2% from open, new 20-day low) |
  | Month up Week up | F23 (up ≥ 2%, 4-wk and 1-wk perf up) | F12 (down ≥ 2%, 4-wk and 1-wk perf down) |
  | 20 Day Breakout 75% Volume | F22 (relvol > 0.75, up from open, new 20-day high) | F13 (relvol > 0.75, down from open, new 20-day low) |
  | Strong Stock Weak Close | F21 (down ≥ 2% from open, 4-wk up, above sma20 and sma50) | F14 (up ≥ 2% from open, 4-wk down, below sma20 and sma50) |
  | Short Interest 20-day high | F19 (short float > 20%, new 20-day high) | n/a |
  | Short Interest over 20 or 50 SMA | F18 (short float > 20%, close > sma20 and sma50) | n/a |
  | Setting up for The Mechanical | F04 (up from open, crossed above sma20, sma50 < sma20) | F03 (down from open, crossed below sma20, sma50 > sma20) |

  F18 and F19 need short float, which has no history, so they're **live only**. On the backfill, the candidate set is the other 7 screens. The report shows trades and results per screen (descriptive).
- Unchanged:
  - no earnings within 5 sessions;
  - an STP trigger. **Calendar inside and U-turn triggers are dropped** (Chris, 2026-11-25, before any P3-0k3 run). Inside, butn and brutn use the **rolling** 5/20 version only. mech1 and mech2 take their trend from the MAs, not the opens, so they're unaffected and stay in.
  - R/R ≥ 3;
  - optimal entry, with the stop ≤ 0.5 ATR beyond the nearest support.
- **The industry ETF is not part of alignment.**

- **Room to 3R, early in the leg** (Chris, 2026-11-25, added before any P3-0k3 run): "We want to be sure we are near the optimal entry, i.e. early into a developing rally."
  - Use the stock's §1f swing profile at k = 2: the last 250 sessions, ≥ 4 legs, confirmed pivots ≤ D only.
  - **Leg so far** = |entry − the lowest low since the last confirmed k = 2 swing high| ÷ ATR14(D) (shorts: the highest high since the last confirmed swing low). Corrected by Chris on 2026-11-26 after the first run; it was "|entry − the last confirmed swing low|", which measured a fresh leg from the prior leg's low.
  - **Room left** = median rally (ATR) − leg so far.
  - **Gate:** room left ≥ 3 × (entry − stop) ÷ ATR14(D). The stock's typical move has to leave room for 3R from this entry.
  - No swing profile (fewer than 4 legs) means no candidate, and it's counted.
  - This gate sits alongside the R/R ≥ 3 resistance check; it doesn't replace it.
  - Descriptive variants: the 75th-percentile rally in place of the median; without the room gate; results by `rally_used` (leg so far ÷ median rally) quintile.

**Size:** start at 1.0 and halve for each of these, with a floor of 0.25:
1. the stock's **monthly** open or **rolling 20-session** open isn't green in the trade direction (one halving if either fails);
   - **Rolling triggers (Chris chose B, 2026-11-25):** rolling inside days and U-turns already require the close beyond both the rolling 5 and rolling 20 opens to fire, so for them this input reduces to the monthly open. Mechanicals don't use the opens to trigger, so for them both the monthly and the rolling 20 count. No separate code path is needed; add a test that a rolling inside trade's size depends only on the monthly open.
2. the **sector** layer isn't aligned (the P3-0k definition, unchanged);
3. the **market** layer isn't aligned (P3-0k, 2-of-3 vote of SPY, QQQ and DIA, unchanged);
4. the **industry** layer isn't aligned (the P3-0k layer definition, used for sizing only). **No industry ETF, or no data, is neutral and doesn't halve.** In P3-0k, 429 of the 1,229 candidates (35%) had no industry data. Reviewer's default; Chris didn't object.

Then × 0.5 for an out-of-hours event within 5 sessions, still floored at 0.25. Base risk is $200.

**Building from ¼** (Chris: "I'm ok entering early at 1/4 size and building a position from there"):
- **Primary (unchanged):** adds of 50% of the current shares at +2, +4 and +6 ATR (max 3), so a ¼ start grows to 0.84 of full at most.
- **Descriptive variant, "build to layer size":** at each add level, recompute the size from that day's layers (monthly and rolling-20 opens, sector, market, industry). The add is the larger of 50% of the current shares and the shares needed to reach that size, never beyond full (1.0). The stop still moves to the size-weighted breakeven after each add. Report it next to the primary, along with the size reached at exit.

**Management:** as P3-0k (exit B, adds every 2 × ATR, max 3, the event and earnings rules). Fudge stays at 11%, with a descriptive variant at 23% on entry and stop (see the P3-0k2 sweep).

**Pre-registered, 4 comparisons**, the same shape as P3-0k:
1. `p3k3` vs all STP trades, long;
2. the same, short;
3. `p3k3` vs its after-trigger control, long;
4. the same, short.

The P3-0k KEEP rule applies, and any KEEP is marked provisional (defined after a P3-0k run).

**Descriptive:**
- gate counts, step by step;
- per named screen, and "any screen" vs the plain Finviz base;
- results by size (1 / 0.5 / 0.25) and by each sizing input separately (monthly + rolling 20 green or not; sector, market and industry aligned or not);
- the order 20 > 50 vs the order 50 > 20;
- with the slope variant;
- fudge 23%;
- stopped within 3 sessions;
- side by side with P3-0k;
- the room-left gate's count and "room gate fail" results;
- "build to layer size" vs the primary adds.

**Live keys (log-only):** `p3k3_candidate`, `p3k3_size_long`, `p3k3_size_short`, `p3k3_ma_order` (`20>50` / `50>20`).

**Required check before the run (bug suspect):** P3-0k reported **0** rolling-trigger trades among `p3k` (`aligned + optimal, rolling trigger: 0`), even though earlier runs had about 22k rolling-only triggers. Find the cause (likely the calendar/rolling dedup, or the rolling setups' type or opens fields), fix it in P3-0k as well, and add a test that a rolling-only trigger passing every gate becomes a candidate. The report prints calendar vs rolling counts at each gate.

**Tests:**
- both MA orders pass;
- sma20 = sma50 counts as one order (`>` is strict, so ties fail);
- close below either of the two MAs fails;
- the weekly-or-rolling-5 edges (either alone passes, neither fails);
- the screen gate: at least one screen in the trade direction, with F18/F19 null on the backfill;
- monthly or rolling-20 not green halves the size, and only once;
- industry affects size, never the gate; no industry data doesn't halve;
- the floor at 0.25 after 4 halvings and the event;
- crypto 7;
- look-ahead;
- room left at the 3R edge (just under vs at), no profile means no candidate, and the short mirror;
- build to layer size: an add that reaches the day's layer size, the cap at full, and the breakeven after the add.

## P3-0m: wider Yahoo options-flow coverage, log-only (Chris, 2026-11-25)
**Why:** the Yahoo options-flow source scans a fixed list of 89 large caps (`SCAN_SYMBOLS`). The universe, the P3-0k3 candidates and the watchlist's off-universe names (often small caps, where insiders show up) never get scanned, so options hits rarely line up with our candidates.

**Amendment (Chris, 2026-11-26, as built in #91):** the premise above was wrong. Since PR 1-0 options-flow has scanned the whole universe (`prep.scanSymbols`); the 89 `SCAN_SYMBOLS` were only the fallback when no universe loads, so priorities 2 and 3 were already covered and the 89 weren't scanned at all. Chris chose to re-scope and add the 89. What shipped:
- universe snapshot rows get the `opt_*` keys from this run's cached chains (no new requests);
- `watch_only` names (cap 150, `WATCH_ONLY_CAP`) are fetched for the `opt_*` keys only, with no `OPTIONS_FLOW` Signal rows;
- the 89 `SCAN_SYMBOLS` outside the universe are back in the options-flow scan and **do** create `OPTIONS_FLOW` signals, as before PR 1-0 (a scoring input, Chris's explicit choice); volume-spike still scans the universe only;
- the cap-300 priority list below is dropped;
- `opt_unusual_n` counts calls and puts meeting vol/OI ≥ 3, volume ≥ 1,000, OI ≥ 100 (OTM is a flag in `options-flow.ts`, not a filter); `opt_sweep` is unusual calls on 3+ strikes of one expiry; `opt_net_premium`, `opt_call_premium_ratio` and `opt_top_type` are null when no contract traded.

The original text follows, superseded where it conflicts with the amendment.

**Coverage, per harvest, with a priority order and a cap of 300 symbols:**
1. names on the P3-0l watchlist (universe and `watch_only`);
2. today's `p3k3_candidate` stocks and any named Finviz screen hits (§P3-0k3);
3. universe members ranked by 20-session average **dollar** volume;
4. the existing 89 `SCAN_SYMBOLS`, always included and outside the cap.

The same chain fetch, thresholds and batching as `options-flow.ts`: vol/OI ≥ 3, volume ≥ 1,000, OI ≥ 100, OTM ≥ 10%, sweep ≥ 3 strikes, batches of 5 with a 2 s delay. About 300 extra requests and 2–3 minutes. A failed ticker never stops the harvest.

**Log-only, no scoring change:**
- The expanded symbols **don't create `OPTIONS_FLOW` Signal rows**. Those feed SignalScope's scores, and the 89-symbol behaviour stays exactly as it is.
- Results are written as features on the stock's row, either the snapshot row or the `watch_only` row:
  - `opt_scanned` (true);
  - `opt_unusual_n` (contracts meeting the thresholds);
  - `opt_sweep` (bool);
  - `opt_net_premium` (calls − puts, $);
  - `opt_call_premium_ratio`;
  - `opt_top_type` (Call or Put by premium).
- Null means not scanned or failed, never 0.
- **P3-0l watchlist:** an options hit now also comes from these features (`opt_unusual_n ≥ 1`), with direction from the net premium's sign, as today. Still flagged as unreliable: the side (bought or sold) is unknown.

**Health:** `[options-ext] scanned n/m, unusual hits h, failed f, 429s r`. Warn when more than 20% fail.

**Tests:**
- the priority order and the cap;
- the 89 stay in and outside the cap;
- no Signal rows for expanded symbols;
- feature keys on the right row;
- null on failure;
- the watchlist reads `opt_unusual_n`;
- a 429 is retried with the existing backoff.

No migration, no dependency.

## P3-0o: IBKR options via a local IB Gateway (Chris, 2026-11-25). **DEFERRED: Chris will say when to start**
**Why:** Yahoo's chains carry no trade side, and Alpaca's free feed is indicative. IBKR's OPRA Top of Book is USD 1.50/month for a non-professional and gives real-time option quotes and trades for every US option exchange. With the bid and ask at each print, the side can be inferred: at or above the ask is a buy, at or below the bid is a sell, anything else is unknown.

**Setup (Chris, once; see the runbook in the PR):**
- An IB Gateway container (`ghcr.io/gnzsnz/ib-gateway:stable`) under a new compose profile, `ib`.
- **Paper login only** (`TRADING_MODE=paper`, `READ_ONLY_API=yes`), with the live account's market data shared to the paper user.
- Credentials live only in `.env`, never committed.
- **No host port:** the harvester reaches `ib-gateway:4004` on the compose network.
- **Known limit:** a paper user sharing live data gets **no data** while the live user is logged in on another device. The harvest runs at 08:30 ET (05:30 PT). The client must detect "no data" and log it, never write zeros.

**Client:**
- One TypeScript TWS-API client. The candidate is `@stoqey/ib`: **a new dependency, so Chris approves it first.**
- Per scanned name (the P3-0m list, capped at 300), for the prior session:
  - option trades with bid and ask, via historical ticks for the top contracts by volume;
  - side-classified premium.

**Features (log-only):**
- `ib_call_buy_prem`, `ib_call_sell_prem`, `ib_put_buy_prem`, `ib_put_sell_prem`, `ib_unknown_prem`;
- `ib_net_bullish_prem`: call buys + put sells − call sells − put buys;
- `ib_large_buys_n` (≥ $100k bought);
- `ib_ok` (false when no data or not connected).

The P3-0l watchlist's options hit and direction switch to `ib_net_bullish_prem` when `ib_ok`, and fall back to Yahoo otherwise.

**Health:** `[ib] connected, n/m names with data, no-data reason`. Warn when not connected for 2 runs.

**Tests:**
- side classification at bid, ask and mid;
- a no-data session gives null, not 0;
- not connected skips with a warning and doesn't stop the harvest;
- the watchlist falls back to Yahoo.

**No orders, ever:** read-only API, paper mode, and no order code in the client.

## P3-0p: congress trades from the House Clerk, official and free (Chris, 2026-11-25)
**Why:** Capitol Trades hit 429s on day 1. The House Clerk publishes every member's disclosures, with yearly downloads from 2008 onward.

**Source:**
- The yearly ZIP index (XML) of filings from `disclosures-clerk.house.gov`. Filter to Periodic Transaction Reports (PTRs).
- For each new PTR, fetch its PDF and parse the transactions: asset, ticker, type (purchase, sale or exchange), date, amount range, owner.
- The PDFs vary: unparsed lines are logged and counted, never guessed.
- A Senate eFD source is a follow-up, out of scope here.

**Timing:** the signal date is the PTR's **filing date**, mapped to the next session, not the transaction date (members have up to 45 days to file).

**History:** backfill 2 years, cached raw under `scripts/output/house-ptr/`, at ≤ 2 req/s.

**Features:** `cong_buy_n_30d`, `cong_buy_amt_mid_30d` (range midpoints), `cong_sell_n_30d`, `cong_members_30d`. Log-only.

The P3-0l congress hit uses these. Capitol Trades stays as a fallback, with a health line comparing the two.

**Tests:**
- an index XML fixture;
- 2 PTR PDF fixtures: a clean table, and a messy one with unparsed lines counted;
- filing-date mapping;
- ticker extraction;
- amount-range midpoints.

**As built (P3-0p PR):**
- **PDF text:** `unpdf` 1.9.1 (pdf.js, pure JS), approved by Chris on 2026-11-26: the newest release whose engines allow Node 22 (2.x needs Node ≥ 24; CI and the images run 22).
- **Paper filings:** scanned paper PTRs (DocIDs not starting with 2; 66 of 515 PTRs in 2025) have no text layer. They're counted and never OCR'd.
- **Unparsed rows:** a row split by a page break (its "(TICKER) [ST]" lands after the repeated table header) is counted as unparsed. In a 55-filing sample from 2025–26 this was 7 of 676 transaction lines (1%).
- **Signal session:** the first session strictly after the filing date. The index has no filing time.
- **Ticker rows:**
  - only rows with a ticker become events;
  - bonds, Treasuries, funds and LLCs have no ticker, so they're counted in the coverage line but produce no event;
  - share classes are normalised (BRK.B → BRK-B).
- **Window:** `cong_*_30d` covers 30 calendar days.
- **`cong_members_30d`:** distinct members with a purchase or sale in the window.
- **P3-0l congress hits:** purchases filed on or after the last completed session, direction bullish. Capitol Trades hits are used only when the House source fails this run. Capitol Trades still creates its own `CONGRESS` signals, unchanged.
- **Health lines:**
  - `[house-ptr] N PTRs (paper, failed); transactions parsed (with a ticker), unparsed`;
  - `[house-ptr] new purchase tickers: House Clerk a, Capitol Trades b, both c`.
- **Live cost:**
  - one index ZIP per harvest (about 70 KB);
  - the new PTR PDFs from the last 45 days, at ≤ 2 requests per second;
  - parses are cached under `scripts/output/house-ptr/`, bind-mounted into the harvester.

## P3-0q: Reddit mentions from ApeWisdom (Chris, 2026-11-25)
**Why:** direct Reddit scraping was DNS-blocked and is fragile. ApeWisdom offers a free public REST API with no authentication (rate-limited) for Reddit and 4chan mention counts.

**Source:** the ApeWisdom public API, per filter (`all-stocks`, `wallstreetbets`, `all-crypto`). Mentions, upvotes, rank, and the mentions 24 h ago. One harvest call per filter, paged.

**Verify first:** one review says programmatic access is a paid tier. The builder tests the free endpoint, and if it needs a key, stops and reports back. No key is to be bought without Chris.

**Features:**
- `aw_mentions`, `aw_mentions_24h_ago`, `aw_rank`;
- `aw_spike`: mentions ≥ 3 × 24 h ago and ≥ 20 mentions.

The P3-0l Reddit hit uses `aw_spike`, and the existing Reddit scraper becomes the fallback.

**History:** none beyond the API's window, so this is live-only.

**Tests:** a fixture response, the spike rule at its edge, pagination, a rate-limit backoff, and missing gives null.

**As built (P3-0q PR):**
- **Access check (2026-11-26):** the free endpoint needs no key. `all-stocks` returned 847 tickers over 9 pages, `wallstreetbets` 669 over 7, and `all-crypto` 146 over 2. No rate-limit headers are sent. Requests are paced at 1 per second, and 429s and 5xx responses back off with the shared retry.
- **Null 24 h-ago counts:** `mentions_24h_ago` is null for tickers that weren't ranked a day earlier (147 of 847). The key stays null, but the spike rule counts it as 0, so a new name with 20 or more mentions is a spike.
- **Missing values:**
  - a ticker not on the list gets null `aw_*` keys;
  - a failed filter leaves the keys off the rows;
  - a later page that fails keeps the pages already read.
- **Rows:**
  - stock rows read `all-stocks`, plus an extra key, `aw_wsb_mentions`, from r/wallstreetbets;
  - crypto rows read `all-crypto` (BTC.X → BTC-USD);
  - share classes are dashed.
- **P3-0l Reddit hits:** `aw_spike` tickers from `all-stocks`, with no direction (as before). The Reddit scraper's hits are used only when `all-stocks` fails. The scraper's `REDDIT` signals are unchanged.
- **Health line:** `[apewisdom] all-stocks n (pages), wallstreetbets …, all-crypto …; spikes s; Reddit scraper tickers r, both k`. It warns when a filter fails.

## P3-0n: free history backfills for insider buys and short interest (Chris, 2026-11-25)
**Why:** insider buys and short interest are live-only today, so the smart-money track (P3-0l) and screens F18/F19 can't be tested for 6 months. These are free official sources with history.

**1. SEC EDGAR Form 4: insider transactions, 2 years**
- **Source:** the per-company submissions JSON (already used by P3-0i3), then each Form 4 XML. The same `SEC_USER_AGENT`, ≤ 8 req/s, and a raw-file cache under `scripts/output/edgar-form4/`, so reruns are free.
- **Parse:** the filer's role (officer, director, 10% owner), transaction code, shares, price, and the acquired/disposed flag.
  - **Open-market buys are code `P`. Sales are `S`.** Grants, options exercises, gifts and the like are kept but tagged non-signal.
  - Amendments (4/A) replace the original.
- **Timing:** the signal date is the **filing** acceptance time, mapped to a session like P3-0i3 (after 16:00 ET → next session), never the transaction date. Otherwise it's look-ahead, because insiders have up to 2 business days to file.
- **Features per stock-day (backfill and live):**
  - `ins_buy_n_30d`, `ins_buy_usd_30d`, `ins_buyers_30d` (distinct insiders);
  - `ins_cluster` (≥ 2 distinct insiders buying within 10 sessions);
  - `ins_officer_buy` (bool);
  - `ins_sell_usd_30d`.
- **The live** OpenInsider/EDGAR source keeps running. A health line compares the two, as the count of P-code buys each found that day.

**2. FINRA equity short interest, 2 years**
- **Source:** FINRA's published short interest files, twice a month. Each settlement date has a known **publication** date, about 7 business days later, and the data is used only from that date.
- **Features:**
  - `si_shares`;
  - `si_pct_float`: shares ÷ float, using float from Yahoo's current profile, so it's an approximation, flagged;
  - `si_days_to_cover` (shares ÷ avg daily volume);
  - `si_change_pct` (vs the prior report);
  - `si_high` (`si_pct_float` > 20%, the Finviz `sh_short_high` threshold).
- **Backfills F18/F19:** with `si_high` historical, those two screens become testable on the backfill. They're descriptive until pre-registered.

**3. FINRA Reg SHO daily short-sale volume**
- **Source:** FINRA's daily short-sale volume files (CNMS, consolidated), free with history.
- **Features:** `sv_ratio` (short volume ÷ total volume), `sv_ratio_20d` (20-session mean), `sv_z` (today vs 20 sessions).
- **Caveat in the docs:** daily short volume includes market-maker hedging. It isn't short interest, and it's logged only as a crowding input.

**Everything is log-only and descriptive.** No score, stage or label changes, and no new pre-registered comparisons. Any test on these comes as its own pre-registered item after the backfill exists. New files go in the cache folders, with no migration if the features ride on existing snapshot rows. If a table is needed, it's additive only, and the migration SQL is shown in the PR.

**Tests (fixtures, no network):**
- Form 4 XML parse, P vs S vs A codes, a 4/A replacing the original;
- filing-time session mapping;
- the cluster rule at the 10-session edge;
- the FINRA publication-date rule (not usable before publication);
- `si_pct_float` null without float;
- the short-volume ratio and z-score;
- look-ahead.

**Run (NAS):** `scripts/backfill-form4.ts`, `scripts/backfill-finra.ts`. One-time, then live daily.

**As built (#P3-0n PR):** choices the spec left open, all on the conservative side.
- **Form 4 joint filings:** an insider and their fund reporting the same shares count as one buyer (the first reporting owner, with every owner's role), so a joint filing can't fake a cluster or double the dollars.
- **4/A:** it replaces the original (same owners and period of report, filed on its `dateOfOriginalSubmission`), and the amended rows take the **4/A's** acceptance session. A correction is never back-dated.
- **Windows:**
  - the `_30d` keys use 30 calendar days of signal sessions;
  - `ins_buy_n_30d` counts buys per filing, not per row;
  - `ins_cluster` uses the 10 sessions ending on the row's session.
- **Short interest:**
  - FINRA has no file listing, so each half-month's settlement is found by trying the 11th–15th and the month's last 5 weekdays, newest first;
  - a report is used from the 7th session after settlement, which matches FINRA's published dates (2024-11-15 → 2024-11-26);
  - `si_change_pct` uses the file's own previous-report column;
  - `si_pct_float` divides by Yahoo's current float from `scripts/output/finra/floats.json`, written by `backfill-finra.ts`; rerun with `--refresh-floats` to update it;
  - an extra key, `si_settlement`, records which report a row used.
- **Short volume:** `sv_ratio_20d` and `sv_z` use the 20 sessions **before** the row (today never enters its own baseline), and need at least 15 of them with data.
- **Caches:**
  - raw files are gzipped in `scripts/output/edgar-form4/` and `scripts/output/finra/raw/`, bind-mounted into the harvester so live and backfill share them;
  - per-symbol backfill output goes to `scripts/output/backfill-form4/` and `scripts/output/backfill-finra/`.
- **Live cost per harvest:**
  - one SEC ticker map;
  - one submissions JSON per universe issuer (≤ 8/s, about 75 s for 600 issuers), plus each new Form 4 XML;
  - one new short-volume file;
  - a few short-interest probes.

## OPS-1: harvest dead-man's switch (Chris, 2026-11-26)
**Why:** a failed or skipped harvest is silent until someone looks. An external check alerts Chris's phone when no successful harvest has arrived by its deadline.

**Service:** healthchecks.io, free tier, or any server with the same ping API (Uptime Kuma push monitors work too). Chris creates the check: a daily schedule, `CRON_TZ=America/New_York`, `30 8 * * 1-5`, with a 1-hour grace period.

**Harvester (`run-harvest-remote.ts`):**
- New optional env `HEALTHCHECK_URL`. If it's unset, nothing happens: no warning spam, one info line at startup.
- `GET {url}/start` when the run begins, `GET {url}` on success, and `GET {url}/fail` when the run throws or the health report has a FAIL-level flag. Each request has a 10 s timeout, and a ping failure only logs a warning; it never fails the harvest.
- Each ping carries a short body (≤ 2 KB): the health report's summary lines, so the alert says what broke.
- Never put secrets in the body. The URL itself is a secret: it lives in `.env`, is never logged in full (print host only), and is never committed.

**Tests (no network, injected fetch):**
- unset → no calls;
- start + success;
- a throw → `/fail` is sent and the original error is rethrown;
- a ping timeout doesn't fail the run;
- the body is trimmed to 2 KB;
- the URL isn't printed in full.

No migration, no dependency.

## P3-0i2b: persistent bar store for the live swing keys (Chris chose option D, 2026-11-25)
The live swing profiles need 250 sessions, but the harvest chart has about 63. Keep a local daily-bar history on the NAS: seed it once from the backfill cache, then append each harvest's chart. That adds no requests in steady state.

**Store**
- One JSON file per symbol, in the same format as `scripts/output/backfill-bars`, at `data/bar-store/<symbol>.json`.
- Bind-mount it into the harvester: `./data/bar-store:/app/data/bar-store` in `docker-compose.yml`. Add `data/` to `.gitignore`. Show the compose diff in the PR body.
- Keep the last **600 sessions**.

**Seed**
- `scripts/seed-bar-store.ts` copies `scripts/output/backfill-bars/*.json` into the store. It skips symbols already present, so it's safe to rerun. Run it once on the NAS.

**Append (each harvest, after the chart fetch)**
- Merge the chart bars by date, keeping **completed sessions only**: dates before the run's session date. The harvest runs before the open, so the newest bar is yesterday's.
- A date in both the store and the chart takes the chart's values.
- **Split and dividend check:** on dates in both, if any close differs by more than 1%, Yahoo has re-adjusted the history. Fetch a 2-year chart for that symbol and rewrite its file. That's one request, and rare.
- **New universe members with no file:** fetch a 2-year chart once. That's a few dozen requests on weekly rebuild days.
- A failed write or fetch logs a warning and never stops the harvest.

**Live swing keys**
- `swing_k*` from P3-0i2 read the store's bars plus this run's chart, deduped by date and causal (≤ D).
- Indicators that only need 63 bars keep using the chart alone, so they stay identical to the backfill.

**Health line**
- `[bar-store] n/m members with ≥250 sessions, x re-adjusted, y seeded new, z write errors`.
- Warn when fewer than 80% of members have ≥250 sessions.

**Tests (fixtures, no network)**
- merge and dedupe;
- an unfinished day isn't stored;
- the 600-session cap;
- the 1% mismatch triggers a refetch, the rewrite replaces the file, and the stub fetch is called once;
- a new member triggers one fetch;
- a write error keeps the harvest going;
- swing keys turn non-null once the store has ≥250 sessions with ≥4 legs;
- look-ahead: a stored bar dated after D is ignored.

No migration and no dependency.

## P3-0i3: historical earnings dates from SEC EDGAR (Chris, 2026-11-25)

**Why:** EGOP needs earnings dates, and the backfill has none. Yahoo gives only the next date. The NAS can't use TradingView (no API, and its terms forbid it). SEC EDGAR is free and complete: a US company's earnings release is furnished on **Form 8-K, Item 2.02** ("Results of Operations"), usually the same day or the next.

Branch `plan/p3-0i3-edgar-earnings`.

1. **Source:**
   - `https://data.sec.gov/submissions/CIK##########.json` per company (plus the `filings.files[]` older pages when 2 years need them).
   - Take the rows where `form == "8-K"` and `items` contains `2.02`. Record `filingDate` and `acceptanceDateTime`.
   - Ticker → CIK comes from `https://www.sec.gov/files/company_tickers.json`.
   - Use `SEC_USER_AGENT`, stay ≤ 8 requests per second, cache per CIK on disk, and use the shared retry helper.
2. **Before or after the open:** an acceptance time before 09:30 ET means the release came before the open, so the gap is that day. At or after 16:00 ET, the gap is the next session. Anything in between counts as during the session and is flagged. **During-session releases are excluded from EGOP** (Chris answered this open question from #74 on 2026-11-25 at 13:51 PT, after the first EGOP backfill run (13:31 PT). It's a definition fix: EGOP trades the opening gap, and a release during the session can't produce one. It wasn't chosen on results.) The P3-0j earnings gate and exit rule still use them.
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
