# STP signals on daily bars (spec for plan item 1g)

Source: Chris's TradingView indicator "STP Indicators and Trade Triggers" (`USER;f32cb76e5da14742b3f8774f226e123f`, v1972), written by Chris (ice-e-fresh) from Pete Renzulli's STP method. This spec covers the daily-timeframe logic only. The intraday-only signals (ORB, SMS, VWAP) are out of scope, because SignalScope runs on daily bars.

All values are computed on the last **completed** daily bar before the scan. The harvest runs at 8:30 AM ET, before the open, so "today" in the Pine code means "the most recent completed session" here. Never use the current session's partial bar.

## Inputs

| Name | Definition |
|---|---|
| `sma10`, `sma20`, `sma50` | Simple moving averages of close |
| `atr` | ATR(14), Wilder's smoothing (TradingView's `ta.atr`) |
| `fudge` | `max(0.11 × atr, 0.02)` |
| `weekOpen` | Open of the first session of the current calendar week |
| `monthOpen` | Open of the first session of the current calendar month |

## States (stored as features)

**`stp_htf_opens`**, the higher-timeframe order flow:
- `+1` when close > weekOpen and close > monthOpen
- `-1` when close < weekOpen and close < monthOpen
- `+0.5` when close < weekOpen and close > monthOpen
- `-0.5` when close > weekOpen and close < monthOpen
- `0` otherwise

On daily bars `trendDirection = stp_htf_opens`, because the VWAP term is intraday only. `minTrendStrength = 1`.

**`stp_ma_state`**:
- `+1` when close > sma20, close > sma50 and sma20 > sma50
- `-1` when close < sma20, close < sma50 and sma20 < sma50
- `0` otherwise

**`stp_well_bid`** (recent order flow; t = last bar, t-1 = the bar before):
- `+1` when high > high[t-1], low > low[t-1], close > open, close > close[t-1] and close > high[t-1]
- `-1` when high < high[t-1], low < low[t-1], close < open, close < close[t-1] and close < low[t-1]
- `0` otherwise

**`stp_size_factor`**: `1.0` (full size) when |stp_htf_opens| = 1 and stp_ma_state ≠ 0, otherwise `0.5`.

## Candle patterns

- **Inside candle:** high ≤ high[t-1] and low ≥ low[t-1]. Direction is `+1` when close ≥ open, otherwise `-1`.
- **BUTN (bullish U-turn), `+1`:** high < high[t-1], close[t-1] < open[t-1], close > close[t-1], low < low[t-1], close > low[t-1] and close > open.
- **BRUTN (bearish U-turn), `-1`:** low > low[t-1], close[t-1] > open[t-1], close < close[t-1], high > high[t-1], close < high[t-1] and close < open.
- **Mechanical I:** with sma20 ≥ sma50 and sma10 ≤ sma20, close crosses above sma20 → `+1`. With sma20 ≤ sma50 and sma10 ≥ sma20, close crosses below sma20 → `-1`.
- **Mechanical II:** same moving-average conditions. Bullish when close > sma20 and sma10 crosses above sma20; bearish when close < sma20 and sma10 crosses below sma20.
- **EGOP (earnings gap):** on the first bar after an earnings release, bullish when low > high[t-1] and close > open; bearish when high < low[t-1] and close < open. Use the `earningsDate` already fetched in `fundamentals.ts`.

"Crosses above" means the value was ≤ the level at t-1 and is > the level at t. "Crosses below" is the mirror.

## Trade trigger (`stp_trigger`: +1, -1 or 0)

Bullish (`+1`) when any of these holds:
- inside candle and trendDirection ≥ 1 (that is, stp_htf_opens = +1)
- BUTN and trendDirection 3 bars ago ≥ 1 and stp_well_bid[t-1] ≤ -1
- Mechanical I or II is bullish
- EGOP is bullish

Bearish (`-1`) is the mirror. Store which rule fired as `stp_trigger_type` (`inside`, `butn`, `brutn`, `mech1`, `mech2`, `egop`).

Note: the Pine code flags an inside candle against the trend direction only, not against its own body direction. Keep that behaviour.

## Trade parameters (stored, used by Phase 4)

For a bullish trigger:
- `entry = high + fudge` (a buy-stop order)
- `stop = low − fudge`
- `risk = entry − stop`
- `target = entry + R × risk`, where R = 3 in trending markets and 2 in choppy ones. Store both target values. The regime from PR 1c decides which one Phase 4 uses.
- `add_level = entry + 2 × atr` when R = 3, or `entry + 1 × atr` when R = 2

A bearish trigger mirrors these around the low.

Position size is `floor(account_risk / risk × stp_size_factor)`, capped by the maximum trade size. Account risk and maximum trade size come from Chris's settings: $200 swing risk and a $10,000 maximum trade by default.

## Exits (Phase 4 paper trading)

- **Mechanical exit (mX):** close crosses below sma20, or sma10 crosses below sma20. Stop moves to `low − fudge`.
- **Profit maximizer, trailing (pmX):** with trendDirection at t-1 ≥ 1, close crosses below sma10. Stop moves to `low − fudge`.
- **Profit maximizer, bar stop:** while trendDirection ≥ 1 and close > low[t-1], the stop trails at `low[t-1] − fudge`.

Bearish exits mirror these.

## Why this fits the 8:30 AM harvest

Every STP daily trigger is defined on a completed bar, and every entry is a stop order beyond that bar's high or low. A pre-market harvest can therefore compute triggers and place the next day's orders before the open with no look-ahead risk.
