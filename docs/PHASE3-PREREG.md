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

## When to run
Once there are about 6 weeks of post-1-0 scans with 7-day returns (`docs/PHASE3-PREP.md`). Earlier runs will mostly return INSUFFICIENT, but they're still logged.
