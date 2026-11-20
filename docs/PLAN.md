# SignalScope fork: plan and workflows

Status: draft, 2026-11-20. Companion to `docs/BOOK-IMPROVEMENTS.md` (rows #1–17 are referenced below).

## The constraint that shapes everything

[Certain] A fresh fork starts with an empty database. Every threshold in `recommendation.ts` was calibrated on the maintainer's 25,573 performance rows. Your instance will have none, and forward returns only accrue in real time: a 7-day label needs 7 days to resolve.

[Likely] At the maintainer's apparent volume (~280 rows/day from 25,573 over 90 days), six weeks yields ~10k rows overall but only ~40–50 Strong Buy rows. Feature-level tests across all rows become feasible in about 6 weeks. Label-level tests (does Strong Buy beat SPY?) need about 3 months.

Consequence: deploy first, code second. Every week the vanilla fork isn't collecting data is a week added to the end of the project.

## Phase 0: Deploy and collect (week 0, no code changes)

1. Fork `aleibovici/signalscope` to your GitHub account. Deploy `main` unchanged on the DS1815+ using the steps already worked out (`.env`, the database password set in both places, port 5433).
2. Turn on `SNAPSHOT_API_KEY` plus a daily snapshot job, and Alpaca paper trading.
3. Harvest cadence: match upstream, which is one run per weekday at 8:30 AM ET (`scripts/harvest-cron.sh`). This corrects the 30–60 minute interval suggested earlier. Keeping upstream's cadence keeps your data comparable with their calibration.
4. Set up nightly Postgres backups to a second volume or the cloud with Hyper Backup. The scan history is the asset; losing it resets the clock.
5. Ask the maintainer for an anonymised export of their scan, signal and performance tables (`scripts/extract.py` already produces parquet files). [Guessing] They may say no. If they say yes, Phase 3 can start in week 2 instead of week 6.

Exit check: 5 consecutive weekday harvests complete, snapshots recorded, and at least one paper trade logged.

## Phase 1: Universe and shadow logging (weeks 1–2, first code)

### PR 1-0: Liquid, volatile universe (the one exception to log-only)

Scope decision: trade liquid, volatile names only, not thinly traded small caps. This is scope, not a hypothesis, so it changes labels from day one. It ships first because it determines which data accumulates.

[Certain] Upstream works against this today in three places:
- `SCAN_SYMBOLS` (`sources/ticker-utils.ts`) is a fixed list of about 100 mostly large, low-volatility names (KO, PEP, JNJ, VZ). The volume-spike and options-flow sources only scan these names.
- Social sources exclude `MEGA_CAPS` and surface whatever tickers get mentioned, which skews toward microcaps.
- `opportunity-score.ts` adds up to 15 points for market caps under $50M, plus an exchange-penny bonus for NasdaqCM and AMEX listings.

Universe rule, refreshed weekly. [Guessing] The thresholds are starting points to tune:
- price ≥ $5
- 20-day average dollar volume ≥ $25M
- market cap ≥ $500M
- ATR(14) / price ≥ 3%, or 20-day historical volatility ≥ 40%
- listed options available
- ETFs excluded

Changes:
1. Replace the static `SCAN_SYMBOLS` with the generated universe list. Build it with a weekly job: take the Nasdaq Trader symbol directory (free, covers every NYSE and Nasdaq listing), drop ETFs and anything under $5, then apply the filters above using Yahoo daily bars. Store it in a table with the refresh date, so every scan records which universe it used.
2. Tickers found by social or insider sources that fall outside the universe are still stored, but at stage FILTERED with reason `illiquid`. They never get Buy or Strong Buy. Keeping them allows a later comparison against liquid names.
3. Remove every market-cap term from `opportunity-score.ts`: the microcap bonuses and, per Chris (2026-11-20), the large-cap penalties (−12 at ≥$10B, −20 at ≥$50B), which work against the liquidity goal. Also remove the exchange-penny bonus. Within the universe, replace them with a volatility term (ATR%).
4. Record each ticker's dollar volume and ATR% on every scan row.
5. Graduation watch for informed buyers on names outside the universe. One `graduation_watch` table with a `source` column covers every informed-actor type:

   | Source | What triggers a watch row | Evidence it predicts returns | Data |
   |---|---|---|---|
   | Corporate insiders | Open-market purchase (Form 4 code P) ≥ $50K | [Certain] Strong for opportunistic buys (Cohen, Malloy & Pomorski 2012) | openinsider (existing), EDGAR, Financial Datasets |
   | Activists and 5% holders | New Schedule 13D, or a 13G that converts to a 13D | [Likely] Strong: Brav et al. (2008) found positive abnormal returns around activist 13D filings | EDGAR full-text search, Financial Datasets `get_beneficial_ownership` |
   | Politicians | Purchase ≥ $15K (the second STOCK Act disclosure bracket) | [Certain] Weak after 2012 (Belmont et al. 2022). Log it and test it; never promote it to catalyst without Phase 3 evidence. | capitoltrades (existing), Financial Datasets `get_politician_trades` (House only) |
   | New insiders | Form 3 showing a large initial stake by a new director or officer | [Guessing] Untested; log only | Financial Datasets `get_insider_ownership` |
   | Insider sale notices | Form 144 filed by a CEO or CFO | [Guessing] A negative signal: blocks graduation for 30 days rather than creating a watch | Financial Datasets `get_insider_sale_notices` |

   Politician rows also store owner (self or spouse), committee assignments and the reporting gap. [Guessing] Committee-relevant trades are the only subset with a plausible information edge, so that's the first cut to test.

   For every source:
   - Insider rows: any open-market purchase (Form 4 code P; the current source already keeps only purchases ≥ $50K) on a ticker outside the universe goes onto the watch table. Store the filing date, insider name and role, dollar value, and whether several insiders bought (a cluster).
   - Re-check the watch list daily against the universe rule, not weekly. The list is small, so it costs one batch of quote calls.
   - When a watched ticker qualifies, emit a `GRADUATION` signal tagged with its source (insider, activist, politician, new insider) and carrying the original filing's age and value, and record which criterion flipped. A dollar-volume jump is often the breakout itself. The signal then flows through normal staging.
   - Drop tickers from the watch after 90 days. [Guessing] Insider-buy predictive power in Cohen et al. is measured monthly and fades after a few months.
   - Once PR 2a ships, store the routine or opportunistic class on each watch row. Promote only opportunistic buys to a catalyst; log routine ones.
   - Decision (Chris, 2026-11-20): insider buys need a share price of at least $5. Set `pl=5` in `OPENINSIDER_SCREENER_URL`, which replaces `pl=50` (very likely a $50 minimum share price), and also drop parsed rows priced under $5 in code, so the floor holds whatever `pl` turns out to mean. Update the URL test. This changes the source's output, so it ships inside PR 1-0, the exception to the log-only rule.
   - Status after PR 1-0's first cut: insider and politician rows are built from the existing openinsider and Capitol Trades sources, with the $5 insider floor above. Activist (13D), new-insider (Form 3) and Form 144 rows need new EDGAR or Financial Datasets sources and are a follow-up; the table's `source` column already covers them.

6. Decision (Chris, 2026-11-20): remove the $1T market-cap cap on recommendations (`ACTIONABLE_MARKET_CAP_MAX` in `recommendation.ts`, plus the same filter in alerts, report generation, IBKR sync and the broker executor). The liquid universe gates eligibility. Logged as experiment #27; rule version 5.

Consequences:
- Upstream's Buy and Strong Buy thresholds were calibrated on a mixed universe, so they're provisional until Phase 3 recalibrates them on liquid names only.
- [Likely] Backtests on illiquid names overstate returns, because the bid-ask spread and slippage are never modelled. Some of upstream's measured edge may come from exactly the names you're excluding. Expect lower but realizable numbers.
- Options-flow scanning grows from about 100 symbols to the universe size. At the current batching (5 symbols every 2 seconds), 600 names takes about 4 minutes per scan.

### Log-only PRs

The rule for the rest of this phase is that each PR adds data and changes no score or label. That way every new feature starts accruing history immediately, without contaminating the baseline.

| PR | Change | Book ref |
|---|---|---|
| 1a | Bar-feature module: one Yahoo 3-month daily fetch per symbol, replacing the 15-day call. It computes and stores: close vs 20/50-day SMA, 20-day SMA slope, close location in the day's range, consecutive up days, range vs 10-day average, NR4/NR7 flags, ATR, % above the 20–60 day high, 50-day volume ratio, 20-day relative strength vs SPY, 14-day RSI min/max, 20-day historical volatility. Plus Chris's STP order-flow state (from his TradingView "STP Indicators and Trade Triggers"): close vs the current week's open and the current month's open, with a combined flag for both above (bullish order flow) or both below | #1–4, 8, 11–13, 17 |
| 1g | STP daily signals, spec in `docs/STP-SIGNALS.md`: for every universe ticker on every scan, store the STP states (`stp_htf_opens`, `stp_ma_state`, `stp_well_bid`, `stp_size_factor`), the trigger (`stp_trigger`, `stp_trigger_type`) and the trade parameters (entry, stop, 2R and 3R targets, add level). Log only: the trigger doesn't become a signal source or change any label until Phase 3 shows it predicts returns. Depends on 1a's bar module. | Chris's STP method |
| 1b | `days_to_earnings` from the `earningsDate` that is already fetched; ATM implied volatility from the options chain the harvester already pulls | #5, 6 |
| 1c | Market regime fields per scan: SPY vs its 20-day SMA, VIX trend, TLT trend, SPY distribution-day count | #7, 14 |
| 1d | Move AI models to current Claude (Haiku for scoring, Sonnet for reports), add prompt caching, and update the `PRICING` table. **Decision (Chris, 2026-11-20): shadow first.** Production scoring stays on the configured provider (OpenAI on the NAS); Claude Haiku 5.5 scores the same batches and is logged as `shadow_ai_*` in `features`. Phase 3 compares the two before any switch, which would then be a label change with an experiment entry. | — |
| 1f | Sector and industry rotation: keep Yahoo's `industry` field, which `fundamentals.ts` currently discards. Fetch daily bars for the 11 SPDR sector ETFs (XLK, XLF, XLV, XLY, XLP, XLE, XLI, XLB, XLU, XLRE, XLC) plus about 25 industry ETFs, mapped from Yahoo industry through a hand-built table. Store per scan: each sector's 20- and 60-day return vs SPY, its rank out of 11, and the 4-week change in that rank (the rotation signal). Also each sector's week-to-date, month-to-date and day return measured from the period open, matching Chris's "STP Sector Rotation" TradingView indicator, ranked by week-to-date. Store per ticker: return vs its sector and vs its industry ETF, plus the count of same-industry tickers in this scan (theme clustering). | #8 |
| 1h | **Full option chains from Cboe** (Chris: options data is a priority). New harvester fetch of Cboe's free delayed-quote JSON per universe ticker: [Likely] `https://cdn.cboe.com/api/global/delayed_quotes/options/<TICKER>.json`, 15-min delayed, all expiries, with volume, OI, IV, greeks, bid/ask. Verify the URL and response shape first and save a real fixture. Store per ticker in `features`: ATM IV for the nearest and ~30-day expiry (term structure), IV/HV20 ratio (HV from 1a), 25-delta put−call skew, put/call volume and OI ratios across all expiries, total call and put premium (volume × mid × 100), and the count of contracts with volume ≥ 3× OI. Log only: the existing Yahoo OPTIONS_FLOW signal is unchanged; Phase 3 decides whether Cboe replaces it. Supersedes the implied-volatility half of 1b. Pace requests like the other sources and log ok/failed/429 counts. Add `cdn.cboe.com` to the cloud allowlist. | #6, Natenberg |
| 1e | Make the Yahoo fetch resilient: retry with backoff and log failures per source. Alpaca market data stays a fallback for later. | — |

Storage: new nullable columns, or one `features` JSONB column per ticker-scan row, added through a Prisma migration. Prefer JSONB so new features need no further migrations.

## Phase 2: Source quality (weeks 2–4)

| PR | Change | Evidence |
|---|---|---|
| 2a | Classify insiders as routine or opportunistic (same calendar month in 3+ prior years = routine), via EDGAR Form 4 history. Log the class now; gate on it later. | Cohen, Malloy & Pomorski 2012 |
| 2b | Log `CONGRESS` as a separate feature and prepare a test that removes it from `HARD_CATALYST_SOURCES` | Belmont et al. 2022 |
| 2c | Reddit: tag long-form fundamental DD posts separately from hype and price-pressure posts | Bradley et al. 2024 |
| 2e | **Alpaca options trades and chain snapshots** (once Chris's Alpaca key exists). Alpaca's free indicative feed gives derived quotes and 15-minute-delayed derived trades, and its chain endpoint returns the latest trade, quote and greeks per contract. Log per ticker: count and premium of large prints (≥ $100K premium), trade count by expiry bucket. Don't infer buy or sell side from indicative quotes: they're modified. Real OPRA trades need Alpaca Algo Trader Plus ($99/mo); decide on that together with 2d. | — |
| 2d | Decide on paid options flow (Unusual Whales at $125/mo) only after Phase 3 shows whether the options features carry any weight | — |

## Phase 3: Validate (from week 6, or week 2 with maintainer data)

Write the testing rules down before looking at results. With 17+ candidate features, some will "work" by chance.

- Split by time, never randomly: train on older scans, test on the newest 30%.
- Primary metric: 7-day hit rate and mean return vs SPY over the same window. Secondary: 1-day and 3-day returns.
- Keep a feature only if it improves the held-out metric and holds in at least 2 of 3 time folds of a walk-forward test.
- Minimum sample: no rule change for any bucket with fewer than 100 held-out rows.
- Log every run, kept or not, in `scripts/backtesting-experiments.md`. Use the Data plugin for the SQL and statistics, and QuanterLab walk-forward runs for single-rule sanity checks.

Only then: promote winning features into `RECOMMENDATION_RULE_PATHS` or the opportunity score, one PR per rule change.

## Phase 4: Execution (after Phase 3)

Add arms to paper trading, each a separate strategy on the same signals:
- A: market fill at the open after the signal (the current behaviour)
- B: STP execution from `docs/STP-SIGNALS.md`: a buy-stop at high + fudge, stop at low − fudge, 2R or 3R target chosen by the PR 1c regime, exits on the mechanical and profit-maximizer rules
- C: a Williams-style buy-stop at the open plus 50% of the prior day's range, exiting at the first profitable open or after N days (#9)

Compare after at least 50 trades per arm.

## Workflows to confirm before handoff

| Area | Proposal | Status |
|---|---|---|
| Repo | Personal fork; `main` = what runs on the NAS; one feature branch and one PR per row above | to confirm |
| Upstream | Pull upstream `main` monthly; don't send PRs upstream until a change is validated | to confirm |
| CI | Keep the existing `ci.yml` (typecheck, lint, vitest, build). Every PR adds tests; the repo already has 72 test files. | exists |
| Dev environment | Claude Code writes and tests in its own environment against a throwaway Postgres. [Likely] Docker Desktop no longer supports macOS Big Sur, so the Mac isn't a dev box. | to confirm |
| Deploy | On the NAS: `git pull && docker compose up -d --build`. Before any migration, take a manual `pg_dump`. | to confirm |
| Staging | None. Apart from PR 1-0, Phase 1–2 changes are log-only, so a bad deploy can't corrupt labels. Revisit before Phase 3 rule changes. | decision |
| Secrets | `.env` lives only on the NAS, never committed. Separate API keys per service. | to confirm |
| Claude Code instructions | Add a `CLAUDE.md` to the fork covering: the log-only rule for Phases 1–2, the testing rules from Phase 3, "no rule changes without an experiment-log entry", and how to run tests | to write |

## Decided

- **Daily timeframe first, free delayed data only** (Chris, 2026-11-20). All signals and features run on daily bars and 15-minute-delayed or end-of-day data. No intraday work and no paid data feeds (Unusual Whales, Massive, Alpaca Algo Trader Plus) until Phase 3 shows an edge on the daily timeframe.

## Open decisions (defaults assumed)

- Instance stays private, with no public API or x402. Default: private. This also keeps the Unusual Whales personal-use terms intact if you add it.
- Crypto or on-chain pivot using your wallet-watcher data. Default: deferred until the stock version has a baseline.
- Paid options flow. Default: deferred to step 2d.
