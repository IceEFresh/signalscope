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

## STP trigger trades (P3-0i): 49 comparisons on exit B (STP management); exit A is a reference
Fixed before the first run. `scripts/simulate-stp.ts --dataset backfill` simulates STP triggers as trades on the P3-0g backfill bars, the chart cache in `scripts/output/backfill-bars/`. It runs on every cached symbol except SPY, with trigger dates in the backfill's last 2 years of SPY sessions. The survivorship bias is the same as the backfill's: current members only, so results are optimistic.

**Setups.** `computeStp` on each day D's live-window slice, the same slicing as P3-0g: bars dated on or before D, after D minus 3 months. Every `trigger ≠ 0` is one setup, with its own `entry`, `stop`, `fudge`, `triggerType` and `firedRules`. The backfill has no earnings dates, so `egop` never fires, and its groups will be INSUFFICIENT.

**Entry (§1e, Chris 2026-11-25).** A stop-limit day order for session D+1 only.
- Long fills at `entry` only if D+1 opens at or below the entry and trades up through it. **If D+1 opens above the entry, there's no fill** (`gap_skip`, counted). Short mirrored.
- Not reached on D+1 means cancelled (counted). An open at or past the stop skips the setup (counted).
- R = |entry − stop|, the initial 1-unit risk.

**Exits are market orders.** A stop touched intraday exits at the stop; a gap through the stop exits at the open. If the data ends first, the trade exits at the last close (`end_of_data`).

**Exit B: STP management, the primary exit and the only one with verdicts (§1e).**
1. 1 unit at `entry`, stop = the trigger bar's `low − fudge` (`high + fudge` short).
2. **Pyramid every 2 × ATR14 (§1j, Chris's Pine `addShares = highPlusFF + atrFactor × ATR`, atrFactor 2 at 3R):** add levels at fill ± n × 2 × ATR14, where ATR14 is taken on the trigger bar D (n = 1, 2, 3, …). Shorts mirrored. Each add is a stop-limit order for **50% of the current shares, rounded down**, with no limit on the count.
   - **Never on the entry day (Chris).** From the next bar on, a level the fill bar already passed follows the gap rule: a bar that opens beyond it skips it.
   - A bar that opens through an add level skips that add (counted). The next level stays live.
   - A bar that touches the stop exits at the stop before any add on that bar.
3. After each add, the stop for the whole position moves to its **size-weighted breakeven** (no allowance for costs), if that's tighter. It takes effect from the next bar.
4. **Before 3R is touched** (a high ≥ entry + 3R; a low for shorts), the stop is the initial stop, or BE after an add. There's no trailing and **no target exit**.
5. **Once 3R has been touched,** each completed bar can tighten the stop, applied from the next bar. The stop never loosens and never goes below BE.
   - **mech1 and mech2: mX only.** The close crosses below sma20, or sma10 crosses below sma20 → that bar's `low − fudge`.
   - **All other types:** if `close − sma10 > 1 × ATR14`, the bar stop → that bar's `low − fudge`. Otherwise **pmX:** trendDirection at t−1 ≥ 1 and the close crosses below sma10 → that bar's `low − fudge`.
   - The trailing levels use **bar t's fudge**, max(0.11 × ATR14[t], 0.02), as Pine computes `fudgeFactor` per bar (stp.pine:231, `mechSL` :724). The entry and the initial stop keep the trigger bar's fudge. ATR14 is Wilder's, over the symbol's full bar history up to t. Shorts mirror all of these.
6. A **60-session cap** exits at that session's close (counted).
7. **R** is the total P&L over all units divided by the initial 1-unit R. The **initial unit's R** is reported separately, to show the pyramid's effect.
8. **Costs:** 0.10% of notional per leg (the entry, each add and the exit), converted into R.
9. Exit reasons are `stop`, `be_stop`, `trail_stop`, `stop_gap`, `time_cap` and `end_of_data`.

**Exit A: a reference only, with no verdicts.** It uses the same entry and the same stop, with no adds. Each bar, in this order:
1. A gap through the stop exits at the open; a gap through the 3R target exits at the open (a limit order).
2. A bar touching both the stop and the target exits at the stop, fill bar included.
3. Otherwise the target.
4. Otherwise the time exit at the 10th session's close.

Costs are 0.10% of each leg's value. Exit A's report shows the same groups without verdicts, and its log row is marked "reference".

**One position per ticker.** A trigger dated before the open trade's exit bar is skipped (counted). A trigger on the exit day itself is allowed. Cancelled and skipped setups don't block.

**Matched control.** For each filled trade, draw a random non-trigger session within ±20 sessions of the trigger, same ticker, same direction.
- Entry is high + fudge (low − fudge for shorts); the stop is the mirror level; both come from that control bar's own `computeStp` fudge.
- The same entry, management (the trade's type decides mX or the bar stop/pmX) and cost rules apply. Controls don't block positions.
- Up to 5 sessions are tried, without replacement, until one fills; otherwise the trade has no control (counted).
- RNG: mulberry32, base seed **20261125**, hashed with ticker and trigger date, so a control doesn't depend on run order.
- Control expectancy is the mean net R of the controls found. **Edge = trigger net expectancy − control net expectancy.**

**Metrics per group.** Trades, win rate (net R > 0), mean and median net R (mean = expectancy), mean gross R, profit factor, average holding sessions, max drawdown in R (equal-R trades in fill-date order), control count, control expectancy, and edge.
- **Exit B and C add:** the add rate, the average and maximum add count, add gap skips, the share reaching 3R, the share exiting at BE, the average R of trades that reached 3R and of those that didn't, 60-session cap exits, and the initial-unit R.
- **Exit A:** the 3R-hit rate.
- The setup, fill, cancel, `gap_skip` and skip counts are reported for the whole run.

**Split.** Computed once over all trades by trigger date, and applied to every group: the newest 30% of trigger dates are held out, plus 3 expanding walk-forward folds (the same rule code as the harness).

**Verdict, primary groups on exit B only:**
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

**Entry location vs the normal move (§1d): descriptive only.** §1f replaced §1d's test, so `week_used`, `month_used` and `room_w` are reported by bucket with no verdict.
- `W` is the mean high−low range of the 10 calendar weeks completed before the fill's week; `M` is the same over 6 completed months.
- Long: `week_used = (fill − lowest low since the week's open) / W`. The lowest low is over bars of the fill's week dated ≤ D, plus the fill. Short mirrored.
- `room_w = W × (1 − week_used) / (3 × R)`.

**Entry location by swing structure (§1f), a primary test.**
- **Swings:** an ATR zigzag. A swing high is confirmed once price falls k × ATR14 from it, a swing low once price rises k × ATR14 from it. ATR14 is Wilder's, at the pivot bar where the next leg starts.
  - Thresholds: k = 1.5, 2 and 3.
  - A pivot counts on day t only if it was confirmed on or before t (no look-ahead). The zigzag is causal, so it's run once over each symbol's history.
- **Profile:** confirmed legs that start within the 250 sessions up to the trigger day. For rallies (up-legs) and pullbacks (down-legs): the median and 75th percentile in ATR units (of the leg's start pivot) and in %, plus the median duration in bars. Fewer than 4 legs of a kind gives null.
- **Entry scores for a long** (shorts mirrored: down-legs are the move and up-legs the pullback; the last swing high replaces the last swing low):
  - `rally_used = ((fill − last swing low) / ATR at that low) / median rally (ATR)`;
  - `rally_age = (fill bar − last swing low bar) / median rally bars`;
  - `room_3r = (median rally × ATR at the low − (fill − low)) / (3 × R)`;
  - `pullback_ratio = (the confirmed pullback that ended at that low, in ATR of its start) / median pullback`.
- **Test, 6 comparisons:** trades with `rally_used < 0.5` and `room_3r ≥ 1`, for each k × direction, on calendar triggers. A KEEP needs the usual rule **and** a net expectancy above all calendar trades of the same direction, held out and in each counted fold.
- **Descriptive per k:** `rally_used` buckets (< 0.25, 0.25–0.5, 0.5–0.75, 0.75–1, ≥ 1); `room_3r` (< 1, ≥ 1); `rally_age` and `pullback_ratio` (< 0.5, 0.5–1, ≥ 1). Also the universe-wide distribution of per-stock profile medians at the last bar.

**Position size by the Stock Market Power Pyramid (§1g).**
- **Layer state** on the trigger day, from that ETF's bars dated ≤ D:
  - opens = `stp_htf_opens`;
  - trend up = close > sma50 and sma20 > sma50; down is the mirror; anything else is neutral.
  - For a long, a layer **agrees** when opens = +1 and the trend is up, **disagrees** when opens = −1 and the trend is down, and is **mixed** otherwise. Mixed isn't a disagreement. Shorts mirrored.
- **Layers:**
  - market: SPY, QQQ and DIA each scored, then a 2-of-3 majority (agree or disagree; otherwise mixed);
  - sector: the stock's SPDR (from today's `UniverseMember.sector`);
  - industry: the 1f-mapped ETF, null when unmapped.
- **Missing data:** a layer with no ETF bar on D, or an unmapped sector, is null and treated as mixed (counted).
- **size_mult** from the market and sector layers: 0 disagreeing → 1, 1 → 0.5, 2 → 0.25. These are the reviewer's assumptions, which Chris may correct.
- **Test, 2 comparisons:** "all agree" (market and sector both agree) vs all calendar trades of the same direction, long and short. Same KEEP rule plus beating that direction.
- **Descriptive:**
  - trades by size_mult;
  - the opens-only and trend-only variants;
  - the industry-included variant (halved per disagreeing layer of three);
  - each layer's state;
  - total size-weighted R, and dollar drawdown under the sizing rule.

**Size and dollar risk (§1h as amended by §1j, Chris's Pine script).**
- **Stock factor:** the Pine `shareSizeFactor` with its abs() fixed. It's 1 only when the trigger bar's `stp_htf_opens` is +1 in the trade's direction **and** the MAs are stacked that way (`stp_ma_state` = direction: close > sma20, close > sma50 and sma20 > sma50 for a long). Otherwise it's 0.5. Shorts mirrored.
- **Size = stock factor × the §1g pyramid factor, floored at 0.25.** Chris never enters at less than 1/4 size.
- Base risk = **$200 × size**. Initial shares = floor(base risk / per-share risk), with **no max-trade-size cap**. **0 shares means no trade** (`size_skip`, counted per pattern; it doesn't block the ticker).
- Each add = floor(50% of current shares). 0 means no add.
- Exit A uses the same initial shares with no adds.
- Dollar P&L = shares × the price move, summed over legs, minus 0.10% of each leg's traded value.
- **R = dollar P&L / base risk**, so unweighted R is the per-trade edge. Dollar P&L already includes the size.
- The control uses the trade's size.
- **Account view,** no cap applied: total dollar P&L, max dollar drawdown (in exit-date order), trades per session, and the peak open positions and peak open risk (shares × per-share risk) on any day.
- **Descriptive:** expectancy by stock factor (1, 0.5) and by combined size (1, 0.5, 0.25); the count where the 0.25 floor applied; and the count where the old Pine abs() rule (1 when |htf| = 1 and the MA state ≠ 0) would have given full size but the fixed rule gives half.

**Exit C: the "choppy" variant (§1j), descriptive only, no verdicts.** It's exit B with adds every **1 × ATR14(D)** and the trail starting once **2R** is touched (Pine `atrFactor = 1` when RR = 2). It runs on all trades and is reported split by the market layer (agree vs mixed or disagree), because Chris sets RR by hand and there's no objective "choppy" flag yet. Its log row is marked "descriptive".

**Chris's Finviz screens as filters (§1i).** The definitions are in docs/FINVIZ-SCREENS.md (F01 to F28), computed from our own bars on day D. Nothing is pulled from Finviz.
- **Base filter:** 3-month average volume > 2M shares (the mean of the 63 sessions before D) and Wilder ATR14 > $1.50. Every screen also requires the base filter.
- **Measures:** change from open = (close − open) / open; relvol = volume D / that average; 1-week and 4-week performance against the close 5 and 20 sessions earlier; "crossed sma20" means the close changes side of sma20 from D−1 to D; a new 20-day high means high D ≥ the max high of D−19..D (lows mirrored).
- **Test, base filter, 2 comparisons:** base-filter trades vs all calendar trades of the same direction, long and short.
- **Test, screens, 22 comparisons:** each OHLCV screen ∩ trades vs all calendar trades of the screen's direction, in the directions set 2026-11-24.
  - Short: F03, F05, F08–F15 (10). Long: F04, F06, F20–F27 (10). F28 long and short (2).
  - Same KEEP rule plus beating that direction. A screen with **fewer than 30 trades in any fold** is reported and marked INSUFFICIENT, never judged.
- **Pending:** F01 and F02 (earnings) are pre-registered now as long and short, +4. They get verdicts only once P3-0i3 supplies earnings dates, so they're not in today's count.
- **Live only:** the short-float screens (F07, F16–F19) are null on the backfill (unknown, never false), with no verdicts.
- **Caveat:** ATR > $1.50 is in dollars, so it favours higher-priced stocks. The report gives the median fill of base-filter trades vs all trades.

**NOT_RUN.** When the run has no stored sector or industry profiles (no DB), the two §1g groups are reported as NOT_RUN instead of being judged on market-only layers. The report header gives the count of calendar trades with a stored sector.

**Primary groups, 49, exit B:**
- calendar triggers: all, long, short, inside+, inside−, butn+, brutn−, mech1+, mech1−, mech2+, mech2−, egop+, egop− (13);
- rolling triggers: rolling inside+, rolling inside−, rolling butn+, rolling brutn− (4);
- swing-structure early entry (§1f): k = 1.5, 2, 3 × long, short (6);
- Power Pyramid all agree (§1g): long, short (2);
- Finviz base filter (§1i): long, short (2);
- Finviz screens (§1i): the 22 above.

§1f replaces §1d's two early-entry comparisons, so they aren't counted. At a nominal 5%, about 2–3 KEEPs could come from chance before the fold rule.

"all", "long" and "short" cover calendar triggers only. `butn` is bullish only and `brutn` bearish only. EGOP stays INSUFFICIENT until P3-0i3 adds historical earnings dates. At a nominal 5%, about 1 KEEP could come from chance before the fold rule.

**Descriptive only, no verdict (calendar triggers):**
- by `triggerType`, both directions;
- **step 1b:** mech1, mech2 and egop, each split by `stp_htf_opens` alignment with the trade direction: aligned (htf × direction = +1), against (−1), partial (±0.5 or 0). This shows whether the weekly and monthly opens add anything on top of each pattern's own criteria;
- §1d: net expectancy and 3R-hit rate by `week_used` and `month_used` bucket (< 0.25, 0.25–0.5, 0.5–0.75, 0.75–1, ≥ 1) and by `room_w` (< 1, ≥ 1);
- §1f and §1g descriptive groups as listed above;
- SPY above or below its SMA20 on the trigger day, from the backfill SPY bars;
- calendar quarter.

**Amendment 2026-11-25 (P3-0i3): EGOP earnings dates.** EGOP's earnings sessions on the backfill come from SEC EDGAR 8-K Item 2.02 acceptance times (`scripts/backfill-earnings.ts`): before 09:30 ET → that day's session, at or after 16:00 ET → the next session, in between → flagged and counted, and **excluded from EGOP** (Chris answered this open question from #74 on 2026-11-25 at 13:51 PT, after the first EGOP backfill run (13:31 PT). It's a definition fix: EGOP trades the opening gap, and a release during the session can't produce one. It wasn't chosen on results.) The P3-0j earnings gate and exit rule still use them. Symbols without an 8-K 2.02 (mostly foreign filers) get no dates and can't produce EGOP trades; the report states the coverage. The groups and rules are unchanged.

**Amendment 2026-11-25 (P3-0i4): max 3 adds.** Exits B and C stop adding after the 3rd add (largest position 1.5³ = 3.375 units); the stop still moves to the size-weighted breakeven after each add. Chris set this cap after the first run's blow-up (ASST, 40 adds, −$11.0B on a gap through its breakeven), not by tuning on results; no other value was tried. The 49 groups, KEEP rule and splits are unchanged. The report adds "add cap reached" per group, the 5 largest dollar losses and gains per exit, and a WARNING line for any trade beyond ±50R.

**Output.** One report, one trades CSV (with adds, shares, base risk, dollar P&L, size_mult and the layer states, the swing scores per k, reached 3R, initial-unit R, `week_used`, `month_used` and `room_w`) and one experiment-log row per exit: exit B with its verdicts, exit A marked as a reference. A KEEP leads to a Phase 4 paper-trading proposal, not a live rule.

## Selection funnel (P3-0j): 10 comparisons, written before any run

Spec: `docs/PHASE3-PREP.md` §P3-0j. Code: `src/lib/eval/funnel.ts`, `src/lib/eval/funnel-sim.ts`, `scripts/simulate-funnel.ts`. Dataset: the backfill (P3-0g bars), calendar STP triggers, exit B management as amended by P3-0i4 (max 3 adds).

**Funnel, fixed before the run:**
- **Gates:** Finviz base (avg vol > 2M, ATR > $1.50); no own EDGAR earnings session on any of the 5 sessions after D (symbols without EDGAR dates aren't blocked; the report counts them); R/R ≥ 3, or ≥ 4 for a counter-trend short (a short while the market layer agrees with a long).
- **R/R:** room to the nearest level beyond the entry over entry − stop. Long levels: zigzag k = 2 swing highs confirmed by D within 250 sessions, sma20/50/200, the weekly and monthly opens, the 20- and 60-session highs; short mirrored. Levels within 0.25 ATR14 of the entry are ignored; none within 10 ATR gives 10 ATR (`open_air`).
- **Ranking:** per day across the universe by R/R, ties by k = 2 `rally_used` (lower first), then symbol. Top 5 (top 3 and all-passing are descriptive).
- **Entry arms:** (a) stop entry as P3-0i; (b) a limit at the trigger bar's midpoint, D+1 only, same stop. A D+1 open at or through the stop isn't filled; an open beyond the limit fills at the open; a bar touching the limit and the stop is filled and stopped (−1R plus costs). Descriptive: a limit at low + fudge.
- **Size:** stock factor × pyramid × 0.5 when an out-of-hours macro event (08:30 ET CPI, PPI, NFP, PCE, GDP advance, retail sales) falls on one of the 5 sessions after D; floored at 0.25; $200 × size.
- **Exits:** exit B plus (i) the event stop rule at the close before every macro event (open profit ≥ 2R → bar stop; ≥ 1 ATR14 → breakeven; else unchanged; never loosens) and (ii) the earnings rule (bar stop on E−2 and E−1, sold at the close of E−1).
- **Calendar:** `src/lib/harvester/macro-calendar.json`, every row with its official source URL.

**Amendment 2026-11-25 (P3-0j2), control definition, made before any P3-0j run:** an EGOP setup's matched control is drawn only from sessions after the gap day (c > i), in P3-0i and P3-0j alike; a control before the gap could hold through the earnings gap itself (a look-ahead that put EGOP's control at +1.25R). Every other pattern keeps ±20 sessions; the reports show control expectancy before vs after the trigger as descriptive.

**Amendments 2026-11-25 (P3-0j3), made AFTER the first P3-0i and P3-0j runs** (the comparisons stay at 10; spec `docs/PHASE3-PREP.md` §P3-0j3):
- **Pullback sizing bug fixed.** Shares and the R unit come from the planned risk, limit − stop, set when the order is placed; a better fill at the open keeps those shares. The first run sized from fill − stop (an open a cent above the stop gave ≈ $200 / $0.01 shares). **Every pullback verdict from the first run is void.**
- **Matched controls only after the trigger, every pattern (P3-0i and P3-0j).** In the first run the ±20 control was +0.38R before the trigger vs −1.08R after for inside bars (n = 569 / 570), and +0.30 vs −0.25 for mech2: a day before a trigger is chosen knowing it comes. This is a validity fix made after seeing results, so **any KEEP that holds only under the after-only control and not under the ±20 control is provisional** and needs live confirmation; the reports mark it and show the ±20 control alongside.
- **Descriptive only:** the event stop rule counterfactual (each top-5 trade rerun with the rule off, per tier), R/R quintiles, the median stop distance in ATR (top 5 vs all), and a ranking with `open_air` left out. The ranking rule itself is unchanged.

**Pre-registered, KEEP rule as P3-0i** (held-out newest 30% by trigger date, ≥ the minimum held-out trades, net expectancy > 0 and above the baseline, and the same in ≥ 2 of 3 walk-forward folds):

| # | comparison | baseline |
|---|---|---|
| 1–2 | stop entry: funnel top-5 vs all trades, long / short | all triggers, same arm, management and sizing, no gates |
| 3–4 | stop entry: funnel top-5 vs its matched random-day control, long / short | P3-0i control, same arm |
| 5–6 | pullback entry: funnel top-5 vs all trades, long / short | as 1–2 with the pullback arm |
| 7–8 | pullback entry: funnel top-5 vs its matched control, long / short | as 3–4 with the pullback arm |
| 9–10 | funnel top-5: pullback vs stop entry, long / short | the stop arm on the same top-5 |

At a nominal 5%, about 0.5 KEEP could come from chance before the fold rule.

**Honesty note.** The funnel rules are Chris's existing method, stated before these results. The pullback entry was proposed after seeing P3-0i's control gap, so comparisons 5–10 are provisional: a KEEP on them only counts once it is confirmed on ≥ 6 months of live universe data. The earnings dates use EDGAR history, a mild look-ahead (dates are usually announced 2–4 weeks ahead); the report counts trades whose next earnings fell < 10 sessions after entry.

**Descriptive only:** top-3 and all-passing populations; the low + fudge limit; event-halved vs not; `open_air` vs a level; counter-trend shorts and their size distribution; trades by event tier and how each exited; earnings exits; account view (peak open positions and open risk, no cap); the 5 largest losses and gains.

## Aligned-trend setups (P3-0k): 4 comparisons, written before any run

Spec: `docs/PHASE3-PREP.md` §P3-0k (Chris, 2026-11-25: "good stocks near an optimal entry with at least 3:1 risk reward"). Code: `src/lib/eval/aligned.ts`, `src/lib/eval/aligned-sim.ts`, `scripts/simulate-aligned.ts`. EGOP isn't a primary entry from here on (descriptive only).

**Fixed before the run:**
- **Alignment (every layer: the stock, its industry ETF, its sector SPDR, the market by a 2-of-3 vote of SPY, QQQ, DIA), completed bars ≤ D:** opens green (close above the monthly, weekly, rolling 20-session and rolling 5-session opens; crypto 30 / 7) **and** MAs stacked and sloped (close > sma10 > sma20 > sma50 > sma200, each above its value 5 sessions earlier). Aligned when both hold, against when both hold the other way, mixed otherwise or when a value is missing.
- **Candidate:** Finviz base; the stock aligned in the trade's direction; no own earnings within 5 sessions.
- **Entry:** a calendar or rolling STP trigger of type inside, U-turn, mech1 or mech2 in that direction (the calendar one kept when both fire); R/R ≥ 3 to the nearest level (P3-0j step 3); **optimal entry**: the stop at most 0.5 ATR beyond the nearest support below the entry (sma10, sma20, sma50, a confirmed k = 2 swing low, the weekly or monthly open; shorts mirrored).
- **Size:** 1.0 when industry, sector and market are all aligned; each mixed, against or missing layer halves it; × 0.5 for an out-of-hours event within 5 sessions; floor 0.25; $200 × size.
- **Management:** exit B (adds every 2 × ATR, max 3, breakeven, trail after 3R) plus the P3-0j event stop and earnings rules. Stop entry for the verdicts.
- **Controls:** the after-trigger matched control (P3-0j3).

**Pre-registered, KEEP rule as P3-0i:**

| # | comparison | baseline |
|---|---|---|
| 1–2 | aligned + optimal entry vs all STP trades of these types, long / short | the same triggers with no gates, same size rule and management |
| 3–4 | aligned + optimal entry vs its after-trigger matched control, long / short | P3-0j3 control |

At a nominal 5%, about 0.2 KEEP could come from chance before the fold rule. **A small sample is expected; INSUFFICIENT means wait for more data, not a rule change.**

**Descriptive only:** results by layer size (1, 0.5, 0.25); without the optimal-entry gate; opens-only and MAs-only alignment; the pullback entry (after the P3-0j3 sizing fix); calendar vs rolling trigger; layer-state counts; candidates left after each gate.

## Aligned trend v2 (P3-0k3): 4 comparisons, provisional, written before any P3-0k3 run

Spec: `docs/PHASE3-PREP.md` §P3-0k3, including the room-to-3R gate and the build-to-layer-size variant (branch `docs/p3-0k3-room-early`). Code: `src/lib/eval/aligned-v2.ts`, `src/lib/eval/aligned-v2-sim.ts`, run inside `scripts/simulate-aligned.ts` beside P3-0k.

**Defined after the first P3-0k run** (INSUFFICIENT; aligned long −0.62R held out), from the criteria alone, before its gate or size breakdowns were seen. **Any KEEP is provisional** until it's confirmed on live data. P3-0k is unchanged.

**Fixed before the run (long; shorts mirrored), completed bars ≤ D:**
- MAs: close > max(sma20, sma50) and min(sma20, sma50) > sma200 (either order; ties fail; no sma10, no slope).
- Opens: close > the weekly open **or** > the rolling 5-session open (crypto 7).
- At least one of Chris's named Finviz screens in the trade direction (long F28, F26, F25, F23, F22, F21, F19, F18, F04; short F28, F10, F08, F12, F13, F14, F03). F18 and F19 need short float: null on the backfill.
- No own earnings within 5 sessions; an STP trigger: **inside, butn and brutn use the rolling 5/20 version only** (calendar inside and U-turn triggers are dropped, Chris, 2026-11-25, before any P3-0k3 run); mech1 and mech2 (trend from the MAs) stay calendar; R/R ≥ 3; optimal entry (stop ≤ 0.5 ATR beyond the nearest support).
- **Room to 3R early in the leg:** the k = 2 swing profile (250 sessions, ≥ 4 legs, pivots confirmed by D); leg so far = |entry − last confirmed swing low| ÷ ATR14(D); room left = median rally (ATR) − leg so far ≥ 3 × (entry − stop) ÷ ATR14(D). No profile → no candidate (counted).
  - **Amendment (Chris, 2026-11-26, after the first P3-0k3 run; a definition correction, provisional):** leg so far = |entry − the lowest low since the last confirmed k = 2 swing high| ÷ ATR14(D) (shorts: the highest high since the last confirmed swing low). It's causal with no confirmation lag: a fresh leg is measured from its own low before that low is a confirmed pivot. No confirmed opposite swing by D → no candidate (counted). The median rally is unchanged. Results from the first run under the old definition are superseded.
- **Size:** 1.0, halved once if the monthly or rolling-20 open isn't green, once each for sector and market not aligned, once for industry not aligned (no industry ETF or no complete data is neutral); × 0.5 for an out-of-hours event; floor 0.25; $200 × size.
- **Management:** exit B (adds 50% at +2/+4/+6 ATR, max 3, breakeven, trail after 3R) plus the event and earnings rules; stop entry; fudge 11%; after-trigger matched control.

**Pre-registered (KEEP rule as P3-0i; every KEEP provisional):**

| # | comparison | baseline |
|---|---|---|
| 1–2 | `p3k3` vs all STP trades of these types, long / short | the same triggers with no gates, the v2 size rule |
| 3–4 | `p3k3` vs its after-trigger matched control, long / short | P3-0j3 control |

**Descriptive only:** gate counts step by step, calendar vs rolling; per named screen and the plain Finviz base instead; by size and by each sizing input; order 20 > 50 vs 50 > 20; the slope variant; without the room gate and its failures; the 75th-percentile rally; `rally_used` quintiles; fudge 23%; stopped within 3 sessions; the dropped calendar inside / U-turn triggers under the same gates (comparison row); "build to layer size" (each add is the larger of the normal 50% add and the top-up to the day's layer size, the top-up capped at full; max 3 adds) vs the primary adds; side by side with P3-0k.

## Moves (P3-0k4) and 5-year window (P3-0k5): provisional amendment, written before any P3-0k4 run

Spec: `docs/PHASE3-PREP.md` §P3-0k4, §P3-0k5. Set by Chris on 2026-11-26 after the second P3-0k3 run (room gate passed 4 trades), so **every KEEP is provisional.**
- The P3-0k3 room-to-3R gate is replaced by: an active move (start: higher confirmed swing low, butn, or close above a ≤ 3 ATR 20-session range passing F25/F22; end: brutn with volume > 20-session average, close below an armed mX/pmX level, lower high then close below the last swing low, or a failed breakout), `pauses_so_far` ∈ {1, 2}, `move_used` ≤ 0.5 of the stock's median completed-move size (completed moves ending ≤ D, last 750 sessions, ≥ 3, moves < 1 ATR excluded).
- The 4 P3-0k3 comparisons are rerun as `p3k4` with that gate. All other P3-0k3 rules unchanged.
- Window: 5 years. A KEEP also needs the primary metric positive in both years 1–3 and years 4–5 (survivorship check).
- Descriptive only: the profile, `pauses_so_far` and `move_used` breakdowns, end-rule variants, range-width variants, the old room gate.

- **Volume amendment (Chris, 2026-11-26, before any P3-0k4 run):** in `p3k4`, a butn/brutn (move start, pause or entry) needs volume > the prior-20-session average, and an inside day needs volume < it. Equal or missing volume doesn't count. P3-0k3 unchanged.
- **Livermore amendment (Chris, 2026-11-26, before any P3-0k4 run), spec §P3-0k4:** `p3k4` adds two gates, RS20 vs the sector ETF ≥ 0 (shorts ≤ 0; no data neutral) and no failing-leaders block (≥ 3 of the sector's 5 RS60 leaders ended a move in the last 10 sessions while the sector ETF is above sma20); saturation (volume > 2× average, high within 0.5 ATR of the move high, close in the lower half) joins the primary end rules.
  - `p3k4:exitD-vs-exitB:long/short`: exit D (hold until the move ends; no 3R trail trigger) vs exit B on the same trades, paired; KEEP needs a positive paired mean held out and in every fold.
  - `p3k4_brk:vs-control:long/short`: confirmed breakouts (breakout start + volume ≥ 1.5× average, close ≥ range edge + 0.25 ATR, close in the top 25% of the bar) under the stock gates and RS20 / leaders gates, vs the after-trigger matched control. Filter thresholds are the reviewer's defaults, fixed here.
- **Wyckoff amendment (Chris, 2026-11-26, before any P3-0k4 run), spec §P3-0k4:** `p3k4_wyk:vs-control:long/short`: a close above an accumulation range (20–60 sessions ≤ 4 ATR wide after a ≥ 4 ATR decline, up/down volume ≥ 1.2, rising A/D line with a flat close) passing the confirmed-breakout filters, RS20, failing-leaders, earnings and R/R gates, size fixed at 0.25, vs the after-trigger matched control. Distribution (the mirror, within 1 ATR of the move high, then a close below its low) joins the primary move end rules.

## When to run
Once there are about 6 weeks of post-1-0 scans with 7-day returns (`docs/PHASE3-PREP.md`). Earlier runs will mostly return INSUFFICIENT, but they're still logged.
