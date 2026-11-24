# Data sources: what we use, what to add, what to pay for later

Chris (2026-11-24): pull in as much useful data as possible. Start with free sources, move to paid ones once they're affordable, and consider anything that could give an edge.

Rule for every new source: it's added **log only** first. It changes scores only after the Phase 3 harness shows it beats the baseline on held-out data (docs/PHASE3-PREREG.md). Data that never earns a KEEP is dropped, however interesting it is.

Confidence tags: [Certain] verified in this repo or on the NAS; [Likely] known to exist and be free, not yet tested from the NAS; [Guessing] needs checking.

## In use now

| Area | Source | Cost | Status |
|---|---|---|---|
| Prices, bars, fundamentals, option chains | Yahoo Finance (yahoo-finance2) | Free | [Certain] working |
| Option snapshots and trades | Alpaca, free plan (indicative feed) | Free | [Certain] working |
| Insider trades | OpenInsider, plus SEC EDGAR Form 4 | Free | [Certain] working; EDGAR had 5/30 failures on day 1 |
| Congress trades | Capitol Trades | Free | [Certain] 429 on day 1; retries added (#36) |
| Social | Reddit (blocked by DNS on day 1), StockTwits via TrendSpider mirror (502 on day 1) | Free | [Certain] fragile |
| Prediction markets | Polymarket | Free | [Certain] working |
| Universe | Nasdaq Trader symbol directory | Free | [Certain] working |
| AI scoring | OpenAI (production), Anthropic Haiku 5.5 (shadow, once a key is added) | Paid per use | [Certain] |

## Queued (free)

| Item | What | Why |
|---|---|---|
| P3-0e | Liquid crypto universe (CoinGecko, plus Yahoo `-USD` bars) | Tests whether STP and price features carry over to a second asset class |
| P3-0f | Macro context: dollar, credit spreads (HYG/LQD), yield curve, copper/gold, BTC | Regime conditioning for stocks and crypto |

## Candidates: free, worth adding next (roughly by expected value)

1. **Price-history backfill of the universe snapshot** [Certain that it's feasible]. The bar and STP features use prices only, so they can be rebuilt for the past 1–2 years from Yahoo history without look-ahead. Phase 3 could then test price features **now** instead of in January. Caveat: survivorship bias, because today's universe leaves out names that were delisted or fell out of it. Report it as a separate `backfill` dataset, flagged.
2. **FINRA daily short-sale volume** (Reg SHO daily files) [Likely]. Short volume as a share of total volume per ticker, daily.
3. **FINRA short interest**, twice a month [Likely]. Short interest as a share of float, and days to cover.
4. **CFTC Commitments of Traders**, weekly [Likely]. Futures positioning for the S&P 500, Treasuries, the dollar, gold, oil and bitcoin futures. A scan-level conditioning field.
5. **FRED API** (free key) [Likely]. Official ICE BofA high-yield spread (OAS), Chicago Fed financial conditions (NFCI), breakevens, real yields. Better than ETF proxies for credit and rates.
6. **Crypto derivatives: public funding rates and open interest** from OKX or Bybit [Likely; check access from the NAS]. Funding and OI shifts often lead crypto moves.
7. **DefiLlama** [Likely]. Stablecoin supply growth (a crypto liquidity proxy) and chain TVL.
8. **SEC EDGAR 8-K item codes** [Likely]. Event flags for material agreements, executive departures and guidance (items 1.01, 5.02, 2.02).
9. **Finnhub free tier** [Guessing about which endpoints are free]. Earnings surprises and recommendation trends, which might replace parts of Yahoo.
10. **Google Trends or Wikipedia page views** [Likely for Wikipedia's free API]. Retail attention, a cross-check for Reddit and StockTwits.

## Paid: when the budget allows, and only if the matching free proxy earns a KEEP

| Need | Candidates (check current pricing first) | Unlocks |
|---|---|---|
| Real options flow | Unusual Whales API, Polygon.io (now Massive) options, ORATS | Sweeps, block trades, OPRA-grade prints (2d) |
| Real-time or SIP options | Alpaca Algo Trader Plus | All contracts' trades, not just the top 10 |
| Fundamentals, estimates, revisions | Financial Datasets (key exists, $0 credits), FMP, Zacks | Estimate revisions, which are often stronger than raw earnings |
| Crypto on-chain | Glassnode, CryptoQuant, Coinglass | Exchange flows, liquidation maps |
| AI | Anthropic key | Shadow scoring (1d), the reports question |

## Tools already available to Claude (no install needed)

- **QuanterLab:** backtests rules on 20 years of point-in-time stock data, including a walk-forward check. Use it to sanity-check STP and bar-feature rules on long history before Phase 3. It's no substitute for our harness, which tests what SignalScope actually logs.
- **TextToQuant:** this account's plan covers crypto pairs (Binance spot) only. Usable for crypto STP backtests.
- **Financial Datasets connector:** filings, insider trades, House trades, prices. Needs credits.
- **TradingView:** Chris's Pine indicators and watchlists (sector list source).
- **Data skills** (analyze, statistical-analysis, validate-data): for reading the Phase 3 harness output.
