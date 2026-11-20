# SignalScope improvements from the trading library

Source: 16 PDFs uploaded 2026-11-20, mapped against the aleibovici/signalscope code (`src/lib/harvester/*`, `scripts/backtesting-experiments.md`).

## Bottom line

[Certain] SignalScope scores tickers on *who is talking* (social, insider, congress, options) plus market cap and 52-week position. It knows nothing about *what price and volume are doing*. Almost every useful idea in these books is about price and volume. That is the gap.

[Certain] Nearly all of it can be computed from daily OHLCV bars that the harvester already downloads. `volume-spike.ts` fetches a 15-day Yahoo chart for every scanned symbol and throws away everything except volume. Extend that one call to `range=3mo` and compute every bar feature below from it: no new API, no new cost.

[Likely] Add these as LightGBM features first and gate labels on them only after they prove themselves. Strong Buy currently rests on n≈109 rows (mean 7d +2.17%, 65% hit rate, per the header of `recommendation.ts`). Hard-coding new gates on a sample that small will overfit.

## Ranked changes

| # | Change | Book source | Where in code | Confidence it adds signal |
|---|---|---|---|---|
| 1 | Trend state: close vs daily 20SMA, 20SMA vs 50SMA, 20SMA slope | Order Flow Masterclass MOD2 and MOD4 (daily 20SMA = "traded trend", weekly 20SMA = "order flow") | New bar-feature module; feed into `extract.py` and the opportunity score | [Likely] |
| 2 | Volume spike direction and extension: record close location in the day's range and distance from the 20SMA in ATR units. Heavy volume far above the 20SMA is exhaustion, not breakout. | MOD2 volume rules 1–7; Williams ch. 2 | `sources/volume-spike.ts` (currently fires on ratio ≥2x regardless of direction) | [Likely] |
| 3 | Range contraction before the signal: today's range vs the 10-day average range, plus NR4/NR7 flags | Williams ch. 2–3: "small ranges beget large ranges" | Bar-feature module | [Likely] |
| 4 | Don't buy the bulge: count consecutive up closes at signal time; flag ≥3 | Taylor notes ("not buying on top of a three-day rise"); Renzulli (don't chase the first 10 min) | Bar feature, then test as an `avoid` or `watch` demotion | [Likely] |
| 5 | Days to earnings | Natenberg ch. 4 (event volatility); Tactical Income (options price direction, size and speed) | `fundamentals.ts` already fetches `earningsDate` and nothing uses it. Add `days_to_earnings` as a feature and mark OPTIONS_FLOW hits within 5 days of earnings | [Likely]: much "unusual" call volume is routine pre-earnings positioning |
| 6 | Implied vs realized volatility on options signals: ATM implied vol from the chain vs 20-day historical vol from bars | Natenberg ch. 4–5; Tactical Income sec. 2–3 | `sources/options-flow.ts` already has `impliedVolatility` per contract and discards it | [Guessing]: cheap-IV call buying may be more informative than buying into high IV |
| 7 | Market regime from price: SPY above or below its 20SMA, VIX trend, TLT trend | MOD2 (SPY/VIX daily); Williams ch. 7 (bond trend as a stock-index filter) | `regime-filter.ts` currently uses only a count of options-flow titles. Add 3 fetches per scan. | [Likely] |
| 8 | Relative strength: 20-day return minus SPY's (and sector ETF's) 20-day return | MOD2 "relative strength plays"; Tickeron TPE (sector rotation) | Bar-feature module | [Likely] |
| 9 | Paper-trade execution: replace market-on-signal with a buy-stop at open + 50% of the prior day's range; exit at the first profitable open or after N days | Williams ch. 4 (volatility breakout, "bailout" exit); Renzulli (avoid the first 10 minutes) | Broker / paper-trading layer (`simulate-broker.ts`); compare against current fills | [Guessing]: Williams' numbers are 1980s–90s futures |
| 10 | Day of week of signal | Williams ch. 6 (TDW) | One extra group-by in `calibrate-recommendation.ts` | [Guessing]: likely decayed; test it because it costs one query |

## How to test each one

1. Compute the feature for historical scans from stored prices (forward snapshots already exist).
2. Add it to `extract.py`, run the LightGBM pipeline, and log the run in `scripts/backtesting-experiments.md`.
3. Keep it only if 7d return or hit rate improves on held-out scans versus the current baseline (all rows: 47.9% hit7d).
4. Only then turn a winning feature into a rule in `RECOMMENDATION_RULE_PATHS`.

## Do not express these signals with options

[Certain] Strong Buy averages +2.17% over 7 days. A short-dated OTM call needs direction, magnitude and speed (Tactical Income, sec. 1). A 2% drift over a week loses to time decay and the bid-ask spread on most names. Trade the stock, or skip.

## Books with nothing to map

- *The Little Book of Big Dividends* and *Truth About Investing in Blue Chip Stocks*: multi-year income and quality investing. Nothing applies to a 1–7 day breakout tool.
- Tickeron *Pattern Search Engine* and *Trend Prediction Engine*: product marketing. The pattern statistics are images and the "AI confidence" figures are unaudited. The only usable idea, sector rotation, is in row 8.
- OIC *Options Strategies Quick Guide*: payoff-diagram reference.
- Order Flow MOD1, MOD3 (mostly), MOD5 and Renzulli: course structure, discretionary intraday tactics and trader psychology. They aren't machine-testable, apart from the "don't chase" rule in row 4.
- Natenberg is scanned. It was OCR'd for this review, so expect OCR errors in any quotes taken from it.

## Additions from the Apple Books titles (encrypted, so from general knowledge of the books)

These seven EPUBs are FairPlay-encrypted and could not be read. The rows below come from the books' well-known published methods, not from the uploaded files. Verify the thresholds against your own copies.

| # | Change | Book source | Where in code | Confidence it adds signal |
|---|---|---|---|---|
| 11 | Pivot-extension gate: demote to Watch when price is more than 5% above the breakout pivot (prior base high) | O'Neil, *How to Make Money in Stocks* (CAN SLIM buy rule) | Bar feature: `pct_above_base_high` over a 20–60 day lookback; extends row 4 | [Likely] |
| 12 | Breakout-volume rule: breakout-day volume at least 40–50% above the 50-day average, not just 2x the 10-day | O'Neil | `volume-spike.ts`: switch the baseline to the 50-day average and require a new 20+ day high | [Likely] |
| 13 | Relative-strength rank: percentile of 6–12 month return across the scan universe; O'Neil buys 80+ | O'Neil (RS rating) | Bar feature; extends row 8 | [Likely] |
| 14 | Distribution-day count: SPY down at least 0.2% on higher volume than the prior day; 4–5 in 25 sessions = weak market | O'Neil ("M" in CAN SLIM) | `regime-filter.ts`; extends row 7 | [Likely] |
| 15 | Triple screen: weekly trend direction (13-week EMA slope) must agree with the daily setup | Elder, *The New Trading for a Living* | Bar feature; complements row 1 | [Likely] |
| 16 | Consensus as a contrary signal: test whether CONFIRMED-stage social consensus underperforms EARLY/FORMING once price features are added | Neill, *Tape Reading and Market Tactics* (crowd behaviour) | Already partly encoded: Buy C needs FRESH signals ≤6h. Test stage × social-share interaction in LightGBM | [Guessing] |
| 17 | RSI range shift: RSI holding 40–80 marks a bull regime and 20–60 a bear regime, rather than fixed 30/70 levels | Brown, *Technical Analysis for the Trading Professional* | Bar feature: 14-day RSI min/max over 20 days | [Guessing] |

Nothing to map: *Trading in the Zone* (Douglas), *Thinking in Bets* (Duke) and *Reminiscences of a Stock Operator* (Lefèvre) cover psychology and decision-making. Their shared lesson, judging a process over many trades rather than any single outcome, is already how `recommendation.ts` calibrates its labels.
