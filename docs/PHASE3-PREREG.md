# Phase 3 pre-registration

**Written and merged before any real results were viewed (2026-11-24).** Nothing in this file may change after the first run of `scripts/validate-features.ts` on real data, except through its own PR that is logged in `scripts/backtesting-experiments.md` and explains why. The code that applies these rules is `src/lib/eval/` (P3-0b).

## Data
- **Rows:** one per ticker per scan, from `ValidatedTicker` joined to `TickerPerformance`, for scans that used the liquid universe (PR 1-0 onward).
- **Eligible:** the ticker was in the scan's universe, has a performance row, and has no corporate action detected.
- **Outcomes:** the 1-, 3- and 7-day returns from the detection price.
- **Benchmark:** SPY over the same window, from SPY's last completed close before the scan to its last completed close before each return's snapshot. For an 08:30 ET scan, that's the prior session's close, the same price the detection used.
- **Excess return** = return − SPY return.
- **Look-ahead guard:** every outcome must be snapped strictly after its scan. If any isn't, the harness refuses to run. It doesn't drop the row, because one leak voids the test.
- **Scan-time inputs only:** features come from `ValidatedTicker.features` and the scan's `regimeFeatures`. Returns are never inputs.

## Rules
1. **Split by time, never randomly.** The newest 30% of scans are held out, and a scan is never split.
2. **Walk-forward:** 3 expanding folds. Scans are cut into 4 time blocks, and fold *i* trains on blocks 1…*i* and tests on block *i*+1.
3. **Metrics:**
   - Primary: 7-day hit rate (excess return > 0) and 7-day mean excess return.
   - Secondary, reported only: the same at 1 and 3 days.
4. **Testing one feature:**
   - **Numeric:** quintile cut points from the training rows only, applied unchanged to the test rows.
   - **Categorical:** each category is a bucket. A feature with more than 12 categories is skipped.
   - **Missing values:** reported as their own bucket, never selected.
   - **Bucket choice:** the bucket tested is the one with the highest training mean excess return among buckets with at least 30 training rows. It's chosen without looking at test rows.
5. **"Beats the baseline"** means higher mean excess return **and** higher hit rate than all eligible test rows in the same window.
6. **KEEP** only if the chosen bucket beats the baseline on the held-out set **and** in at least 2 of the 3 folds.
   - **Each fold tests that same bucket. A fold never picks its own best bucket.** For a categorical feature, that's the same category. For a numeric feature, it's the same quintile rank (for example q5), with the cut points recomputed from that fold's own training rows. "Holds in 2 of 3 folds" therefore means the same effect held in at least 2 later periods. It doesn't count a feature that won with q5 in one period and q1 in another.
   - **INSUFFICIENT** if the chosen bucket has fewer than **100** held-out rows. No verdict and no rule change.
   - [Assumption] A fold whose chosen bucket has fewer than 30 test rows counts as a failed fold.
   - **DROP** otherwise.
7. **Overlapping windows.** Daily scans with 7-day returns overlap: the same ticker on consecutive scans shares about 6 days of outcome. So 100 held-out rows are not 100 independent observations. The rule stays as written. The report shows the number of distinct tickers beside n for every bucket and for the chosen held-out bucket. Read a KEEP whose rows come from a few tickers as weaker evidence.
8. **Log every run, kept or not,** in `scripts/backtesting-experiments.md`. Each run appends one summary row and writes a full per-bucket report to `scripts/output/phase3-validation-<date>.md`.
9. **A KEEP is a reason to open a rule-change PR, not the change itself.** Each rule change is its own PR with its own experiment entry, as `CLAUDE.md` requires.

## Candidate features: 94 comparisons
Every logged key below is tested once, on its own. That is **94 comparisons**.
- **What chance alone produces:** at a nominal 5% false-positive rate per comparison, about 4–5 KEEPs could come from chance alone, before the 2-of-3 fold rule. The fold rule cuts that further, but by an amount the fold correlation determines, which isn't known in advance.
- **How to read a result:** judge any KEEP against that count. A single KEEP in a family that otherwise all DROPs is weak evidence.

| Family | n | Keys |
|---|---|---|
| bar (1a) | 22 | atr14_pct, close_location, close_vs_month_open, close_vs_sma20, close_vs_sma50, close_vs_week_open, consecutive_up_days, hv20, nr4, nr7, pct_above_high_20d, pct_above_high_60d, range_vs_avg10, return_20d, rs_vs_spy_20d, rsi14, rsi14_max_20d, rsi14_min_20d, sma20_slope_5d, sma20_vs_sma50, spy_return_20d, volume_ratio_50d |
| stp (1g) | 1 | stp_htf_opens |
| earnings (1b) | 5 | days_to_earnings, earnings_date_is_estimate, earnings_window_days, earnings_within_5d, options_flow_near_earnings |
| sector (1f) | 7 | industry_etf, industry_ticker_count, rs_vs_industry_20d, rs_vs_sector_20d, sector_etf, sector_rank_20d, sector_rank_change_4w |
| regime (1c, scan-level) | 10 | regime.spy_close_vs_sma20, regime.spy_above_sma20, regime.spy_sma20_slope_5d, regime.spy_distribution_days_25, regime.vix_close, regime.vix_vs_sma20, regime.vix_change_5d, regime.tlt_close_vs_sma20, regime.tlt_sma20_slope_5d, regime.tlt_above_sma20 |
| opt (1h) | 10 | opt_atm_iv_30d, opt_atm_iv_near, opt_call_premium, opt_iv_hv20_ratio, opt_iv_term_slope, opt_pc_oi_ratio, opt_pc_volume_ratio, opt_put_premium, opt_skew_25d, opt_unusual_contracts |
| alp (2e) | 19 | alp_call_premium_0_7, alp_call_premium_8_30, alp_call_premium_31_60, alp_call_volume_0_7, alp_call_volume_8_30, alp_call_volume_31_60, alp_put_premium_0_7, alp_put_premium_8_30, alp_put_premium_31_60, alp_put_volume_0_7, alp_put_volume_8_30, alp_put_volume_31_60, alp_trades_0_7, alp_trades_8_30, alp_trades_31_60, alp_contracts, alp_large_prints, alp_large_print_premium, alp_large_print_calls |
| insider (2a) | 4 | insider_class, insider_opportunistic_count, insider_routine_count, insider_unclassified_count |
| politician (2b) | 7 | politician_count, politician_members, politician_offices, politician_value_total, politician_min_reporting_gap_days, politician_max_reporting_gap_days, politician_only_catalyst |
| reddit (2c) | 6 | reddit_comment_count, reddit_dd_count, reddit_dd_max_upvotes, reddit_dd_max_words, reddit_hype_count, reddit_other_count |
| shadow_ai (1d) | 3 | shadow_ai_score, shadow_ai_raw_score, shadow_ai_sentiment |

**Excluded, never tested** (`EXCLUDED_KEYS` in `src/lib/eval/features.ts`):
- **Version stamps and bases:** `features_version`, `opt_features_version`, `alp_version`, `regime.regime_version`, `insider_class_basis`, `reddit_post_type_basis`.
- **Dates and names:** `bar_date`, `regime.spy_bar_date`, `earnings_date`, `industry`, `shadow_ai_model`.
- **Raw price levels, not comparable across tickers:** `close`, `week_open`, `month_open`, `atr14`, `regime.spy_close`.
- **Data-quality flags:** `alp_snapshots_capped`, `alp_trades_capped`.
- **Expiry-choice bookkeeping:** `opt_near_days`, `opt_far_days`.

**Expected skips:** `industry_etf` has about 33 categories, so the more-than-12 rule will mark it INSUFFICIENT, and its result shouldn't be read.

**Not covered here:**
- STP triggers. They live in the `StpSignal` table, not in `features`, so they need their own pre-registered entry before they're tested.
- The current Buy and Strong Buy labels. `scripts/calibrate-recommendation.ts` evaluates those.

## Universe dataset (P3-0c, P3-0d): 43 comparisons, reported separately
`scripts/validate-features.ts --dataset universe` runs the same rules on `UniverseSnapshot`: one row per universe member per session, about 1,485 a day. The two datasets are never pooled. Each gets its own report and its own experiment-log row.
- **Outcomes:** the 1-, 3- and 7-day returns use the symbol's own snapshot closes at the 1st, 3rd and 7th trading session after the row's session, on the SPY trading calendar. SPY over the same sessions is the benchmark.
- **Missing outcomes:** a session with no snapshot for that symbol leaves the outcome null. That covers a missed run or a symbol that dropped out. Nothing is interpolated.
- **Look-ahead:** a row's session must be on or before its scan's date, and every outcome session must be strictly after the row's session. Either violation stops the run.
- **Duplicates:** if two scans recorded the same session for a symbol, the earliest scan's row is kept.
- **Keys tested** (other keys aren't in the snapshot):

| Dataset family | n | Keys |
|---|---|---|
| universe: bar (1a) | 22 | atr14_pct, close_location, close_vs_month_open, close_vs_sma20, close_vs_sma50, close_vs_week_open, consecutive_up_days, hv20, nr4, nr7, pct_above_high_20d, pct_above_high_60d, range_vs_avg10, return_20d, rs_vs_spy_20d, rsi14, rsi14_max_20d, rsi14_min_20d, sma20_slope_5d, sma20_vs_sma50, spy_return_20d, volume_ratio_50d |
| universe: stp states (1g) | 4 | stp_htf_opens, stp_ma_state, stp_well_bid, stp_size_factor |
| universe: sector (1f, P3-0d) | 7 | sector_etf, industry_etf, rs_vs_sector_20d, rs_vs_industry_20d, sector_rank_20d, sector_rank_change_4w, industry_ticker_count |
| universe: regime (1c, scan-level) | 10 | regime.spy_close_vs_sma20, regime.spy_above_sma20, regime.spy_sma20_slope_5d, regime.spy_distribution_days_25, regime.vix_close, regime.vix_vs_sma20, regime.vix_change_5d, regime.tlt_close_vs_sma20, regime.tlt_sma20_slope_5d, regime.tlt_above_sma20 |

**43 comparisons.** At a nominal 5%, about 2 KEEPs could come from chance before the fold rule.
- **Overlap is worse here.** The same about 1,485 tickers recur every session, so rows overlap more than in the signals dataset, and distinct tickers per bucket matter more.
- **Regime values repeat.** The regime keys take one value per scan. Their buckets are really buckets of days, so expect fewer effective observations than n.
- **Sector features (P3-0d)** use each member's sector and industry from the weekly universe build. The sector values change only weekly, and a member without a stored profile has null sector features. `industry_ticker_count` here counts universe members in the industry, not signal tickers as in the signals dataset, so the two aren't comparable. As in the signals dataset, `industry_etf` (about 33 categories) will come out INSUFFICIENT under the more-than-12 rule.

## Backfill dataset (P3-0g): 26 comparisons, reported separately
`scripts/validate-features.ts --dataset backfill` runs the same rules on the `UniverseSnapshot` rows that `scripts/backfill-snapshot.ts` rebuilt from about 2 years of daily bars (`features.backfill = true`). It's never pooled with the signals or universe datasets, and it gets its own report and experiment-log row.
- **Survivorship bias:** only today's universe members were rebuilt. Names that were delisted, acquired or dropped out over the 2 years are missing, so results are optimistic. Every backfill report states this in its header, and its log row says so.
- **Rows:** one per member per session, built from the bars dated on or before that session only, cut to the same 3-month window a live run fetches. Each session has its own synthetic scan (`backfill-v1-YYYY-MM-DD`), so the time split and folds work on sessions.
- **Outcomes and benchmark:** as in the universe dataset (1st, 3rd and 7th session after the row's, on the SPY calendar), using the backfill's own SPY rows.
- **Look-ahead:** the backfill script refuses any session whose newest bar isn't dated that session; the harness keeps the universe dataset's two refusals.
- **Keys tested:** the 22 bar keys and 4 STP-state keys of the universe dataset, listed above. Sector and regime are not rebuilt, and `backfill`, `backfill_version` and `snapshot_version` are bookkeeping, not features.

**26 comparisons.** At a nominal 5%, about 1 KEEP could come from chance before the fold rule.
- **More rows, same overlap problem.** About 1,500 tickers over about 500 sessions, so n will be large; the 7-day windows overlap heavily, and distinct tickers and the fold rule matter more than n.

## Crypto dataset (P3-0e): 26 comparisons, reported separately
`scripts/validate-features.ts --dataset crypto` runs the same rules on the `UniverseSnapshot` rows with `assetClass = "crypto"`: one row per crypto universe member per harvest. It's never pooled with the signals, universe or backfill datasets, and it gets its own report and experiment-log row.
- **Sessions:** a crypto row's `sessionDate` is the UTC date of the last complete daily bar (00:00–24:00 UTC). The harvest runs on weekdays at 8:30 AM ET, so Monday's row describes Sunday's bar, Tuesday's describes Monday's, and so on to Friday's, which describes Thursday's. Friday's and Saturday's bars are never stored.
- **Calendar and horizons:** the calendar is the BTC row's sessions. The 1-, 3- and 7-day horizons count snapshot sessions (5 per week), not calendar days: a 7-day outcome is the 7th later stored session, about 9–10 calendar days.
- **Outcomes and benchmark:** the token's own close at that later session. BTC over the same sessions is the benchmark, from the BTC row; BTC itself is not a test row.
- **Missing outcomes, look-ahead, duplicates:** as in the universe dataset. A row's session must be on or before its scan's ET date, and every outcome session must be strictly after it.
- **Keys tested:** the 22 bar keys of the universe dataset, with `spy_return_20d` and `rs_vs_spy_20d` replaced by `btc_return_20d` and `rs_vs_btc_20d`, plus the 4 STP-state keys. There are no sector, regime, insider, Congress, earnings or options features for crypto.

**26 comparisons.** At a nominal 5%, about 1 KEEP could come from chance before the fold rule.
- **Small universe.** About 40 members on the first dry run (95 CoinGecko coins clear $500M, and about 25 of those are stablecoins, wrapped, staked, gold or fund tokens), so expect INSUFFICIENT for months: 100 held-out rows in one bucket needs about 500 held-out rows.
- **Correlated rows.** Most tokens move with BTC, so rows within a session are far from independent even after subtracting BTC.
- **Weekday bars only in the calendar,** but the bar features themselves use all 7 daily bars (SMA20 covers 20 calendar days, not 4 weeks of sessions). `hv20` on crypto rows annualizes with √365 (crypto trades every day; Chris, PR #45), in both the feature and the universe filter. Stock rows keep √252. The datasets are never pooled, so the two scales are never compared.

## Macro context (P3-0f): conditioning columns, not candidates
Each scan stores macro fields under `Scan.regimeFeatures.macro`: the dollar index, HYG/LQD, the 10-year and 3-month yields and the curve between them (in percentage points), copper/gold (DBB/GLD) and BTC. The harness exposes them on every dataset's rows as `macro.<key>`, as conditioning columns only. `candidateKeys` skips `macro.*`, so they add no comparisons to any count above. A later pre-registration update adds them as candidates once there are 6+ months of scans.

The stock regime (`regime.*`) is not attached to crypto rows. The regime is stock-only, which matches the crypto dataset's 26 comparisons.

## Amendment 2026-11-25 (P3-0h): low-cardinality numeric keys are bucketed by value
**Found after the first backfill run. This is a bug fix, not a new hypothesis.** In that run `stp_well_bid` (values −1, 0, +1) was cut into quintiles. The cuts collapsed −1 and 0 into one "q1" bucket (167,590 held-out rows), so its KEEP compared "not well bid" with "well bid", not well-offered with well-bid. Every STP state key (`stp_htf_opens`, `stp_ma_state`, `stp_well_bid`, `stp_size_factor`) and small-integer keys such as `consecutive_up_days` had the same problem.

- **Rule:** a numeric key with **7 or fewer distinct non-null values in the held-out split's training rows** is treated as categorical. Each value is its own bucket, labelled by value (`=-1`, `=0`, `=1`). It's decided once per feature and used for the held-out split and every fold. Above 7 distinct values, quintiles apply as before.
- **Unchanged:** the 100-row held-out minimum, the 30-row fold minimum, the bucket chosen on training data, the same bucket tested in every fold, and KEEP needing the held-out pass plus 2 of 3 folds. **No comparison count changes:** each key is still one comparison.
- **Log:** both backfill runs stay in `scripts/backtesting-experiments.md`. The first run's row is kept, and the rerun after this fix gets its own row.
- **Not covered by this amendment:** the U-shape the first backfill run showed in `return_20d`, `rsi14_max_20d` and `sma20_vs_sma50` (both extremes beat the middle). Testing that would be a new hypothesis, such as beta-adjusted excess or |feature| buckets. It needs its own pre-registration and a test on the live universe dataset, not on the backfill that suggested it.

## STP trigger trades (P3-0i): 19 comparisons, exit A only (exit B on hold)
Fixed before the first run. `scripts/simulate-stp.ts --dataset backfill` simulates STP triggers as trades on the P3-0g backfill bars, the chart cache in `scripts/output/backfill-bars/`. It runs on every cached symbol except SPY, with trigger dates in the backfill's last 2 years of SPY sessions. The survivorship bias is the same as the backfill's: current members only, so results are optimistic.

**Setups.** `computeStp` on each day D's live-window slice, the same slicing as P3-0g: bars dated on or before D, after D minus 3 months. Every `trigger ≠ 0` is one setup, with its own `entry`, `stop`, `fudge`, `triggerType` and `firedRules`. The backfill has no earnings dates, so `egop` never fires, and its groups will be INSUFFICIENT.

**Entry.** A stop order valid for session D+1 only.
- Long fills if the D+1 high is at or above the entry, at max(entry, open); short is mirrored.
- Not filled on D+1 means cancelled (counted).
- An open at or past the stop, or R = |fill − stop| ≤ 0, skips the setup (counted).

**Exits.** Both exits use the trigger's stop and these bar rules, in this order on each bar:
1. From the bar after the fill: a gap through the stop exits at the open. A gap through the target also exits **at the open**, the better price a resting limit order gets (§1d, Chris 2026-11-25).
2. A bar that touches both the stop and the target exits at the stop. This includes the fill bar.
3. Otherwise the target.
4. Otherwise the time exit at that session's close.

If the data ends first, the trade exits at the last close (`end_of_data`). Exit-specific rules:
- **Exit A (the registered test):** target **3R** (§1d), time exit at the close of the 10th session after the fill.
- **Exit B: ON HOLD, not registered and not run** until Chris confirms the STP trade management (§1d). The code is built, and the script refuses `--exit B`. When it's released, its rules and comparisons get their own dated amendment here, before its first run. As built: target 3R, time exit at the 20th session, plus the STP trailing exits from docs/STP-SIGNALS.md, evaluated on each completed bar and applied from the next bar. The stop only tightens. `fudge` is the trigger bar's.
  - **mX:** the close, or sma10, crosses below sma20 → stop to low − fudge.
  - **pmX:** trendDirection at t−1 ≥ 1 and the close crosses below sma10 → stop to low − fudge.
  - **Bar stop:** trendDirection ≥ 1 and close > low[t−1] → stop to low[t−1] − fudge.
  - Shorts mirror all three.

**Costs.** 0.10% of price round trip, as `0.001 × fill / R` per trade. Net R is primary; gross is reported too.

**One position per ticker.** A trigger dated before the open trade's exit bar is skipped (counted). A trigger on the exit day itself is allowed. Cancelled and skipped setups don't block.

**Matched control.** For each filled trade, draw a random non-trigger session within ±20 sessions of the trigger, same ticker, same direction.
- Entry is high + fudge (low − fudge for shorts); the stop is the mirror level; both come from that control bar's own `computeStp` fudge.
- The same fill, exit and cost rules apply. Controls don't block positions.
- Up to 5 sessions are tried, without replacement, until one fills; otherwise the trade has no control (counted).
- RNG: mulberry32, base seed **20261125**, hashed with ticker and trigger date, so a control doesn't depend on run order.
- Control expectancy is the mean net R of the controls found. **Edge = trigger net expectancy − control net expectancy.**

**Metrics per group.** Trades, win rate (net R > 0), mean and median net R (mean = expectancy), mean gross R, profit factor, average holding sessions, max drawdown in R (equal-R trades in fill-date order), control count, control expectancy, and edge. The setup, fill, cancel and skip counts are reported for the whole run.

**Split.** Computed once over all trades by trigger date, and applied to every group: the newest 30% of trigger dates are held out, plus 3 expanding walk-forward folds (the same rule code as the harness).

**Verdict, primary groups only:**
- **INSUFFICIENT:** fewer than 100 held-out trades.
- **KEEP:** held-out net expectancy > 0 **and** above its matched control, **and** the same is true in at least 2 of 3 folds. A fold needs at least 30 trades to count.
- **DROP:** anything else.

**Trend criteria (step 1b).** Each pattern's own criteria, as `computeStp` applies them, define the primary population, with no extra gate:
- inside and U-turns: price against both the calendar weekly and monthly opens (`trendDirection`, at t−3 for U-turns);
- Mechanical I and II: the moving averages;
- EGOP: the earnings gap.

**Rolling opens (step 1c).** A second trend definition for inside candles and U-turns.
- The rolling "week" open is the open of bar t−4 and the "month" open that of bar t−19 (5 and 20 sessions, today counted as session 1). Crypto would use 7/30 (t−6, t−29); the helper takes the window as a parameter, but crypto isn't simulated here.
- `stp_htf_opens_rolling` uses the `stp_htf_opens` formula with those opens; U-turns read it at t−3.
- The pattern rules, entry, stop and fudge are otherwise identical to `computeStp`'s, with the same 51-bar minimum.
- Rolling setups are simulated as their own population, under the same trade rules: one position per ticker within that population.
- Their matched controls are drawn from sessions where the **rolling** trigger is 0. Calendar controls are drawn where the calendar trigger is 0.
- **Overlap** is reported at setup level (same ticker, date and direction, inside and U-turn only): both fire, calendar only, rolling only.

**Entry location vs the normal move (§1d, the reviewer's working definition, which Chris may correct before the run).**
- `W`: the mean high−low range of the 10 calendar weeks completed before the fill's week. `M`: the same over the 6 completed calendar months.
- **Long:** `week_used = (fill − lowest low since the week's open) / W` and `month_used` likewise with `M`. The lowest low is taken over bars of the fill's week (or month) dated on or before the trigger day, **plus the fill price itself**, so a fill that opens a new week has `week_used = 0`. Short is mirrored with the highest high.
- `room_w = W × (1 − week_used) / (3 × R)`. A value ≥ 1 means a normal week still has room for 3R.
- Null when fewer than 10 complete weeks or 6 complete months exist before the fill. The oldest period used must have an earlier period before it, so the start of the data can't cut it off.
- No look-ahead: only bars up to the trigger day plus the fill price.
- **Early entry**, a primary test: `week_used < 0.5` **and** `month_used < 0.5`, on calendar triggers, long and short separately (+2 comparisons). KEEP needs the usual rule **and** a net expectancy above all calendar trades of the same direction, in the held-out split and in each passing fold.

**Primary groups, 19, exit A:**
- calendar triggers: all, long, short, inside+, inside−, butn+, brutn−, mech1+, mech1−, mech2+, mech2−, egop+, egop− (13);
- rolling triggers: rolling inside+, rolling inside−, rolling butn+, rolling brutn− (4);
- early entry: early long, early short (2).

"all", "long" and "short" cover calendar triggers only. `butn` is bullish only and `brutn` bearish only. EGOP stays INSUFFICIENT until P3-0i3 adds historical earnings dates. At a nominal 5%, about 1 KEEP could come from chance before the fold rule.

**Descriptive only, no verdict (calendar triggers):**
- by `triggerType`, both directions;
- **step 1b:** mech1, mech2 and egop, each split by `stp_htf_opens` alignment with the trade direction: aligned (htf × direction = +1), against (−1), partial (±0.5 or 0). This shows whether the weekly and monthly opens add anything on top of each pattern's own criteria;
- §1d: net expectancy and 3R-hit rate by `week_used` and `month_used` bucket (< 0.25, 0.25–0.5, 0.5–0.75, 0.75–1, ≥ 1) and by `room_w` (< 1, ≥ 1);
- SPY above or below its SMA20 on the trigger day, from the backfill SPY bars;
- calendar quarter.

**Output.** One report, one trades CSV (with `week_used`, `month_used` and `room_w`) and one experiment-log row, for exit A. A KEEP leads to a Phase 4 paper-trading proposal, not a live rule.

## When to run
Once there are about 6 weeks of post-1-0 scans with 7-day returns (`docs/PHASE3-PREP.md`). Earlier runs will mostly return INSUFFICIENT, but they're still logged.
