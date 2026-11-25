# Chris's Finviz screens (2026-11-24)

These are Chris's stock-selection screens, recreated from free data. No Finviz API and no scraping. Raw filter strings are in the appendix.

**Base filter (every screen):** 3-month average volume > 2M shares (`sh_avgvol_o2000`) and ATR14 > $1.50 (`ta_averagetruerange_o1.5`, in dollars, not %).

**Definitions on completed bar D:**
- **Change from open (u/d, 1, 2):** (close − open) / open > 0, ≥ 1%, ≥ 2%, mirrored for down.
- **relvol:** volume D / the 3-month average volume.
- **Perf 1 wk / 4 wk:** close D vs the close 5 / 20 sessions earlier.
- **Crossed sma20:** close D vs sma20 differs in side from close D−1 vs sma20 D−1.
- **New 20-day high / low:** high D ≥ max high of D−19..D (lows mirrored).

Finviz screens run intraday. We use the completed bar, so a screen hit on D leads to an STP entry on D+1.

**Dir** (set 2026-11-24, reviewer's proposal accepted by Chris): F14 (up 2% in a downtrend) is short, a U-turn into resistance. F21 (down 2% in an uptrend) is long, a pullback. "both" screens are tested long and short.

| ID | Filters beyond the base | Data | Dir |
|---|---|---|---|
| F01 | earnings in last 5 days | earnings (P3-0i3) | both |
| F02 | earnings yesterday | earnings (P3-0i3) | both |
| F03 | close < open; close crossed below sma20; sma50 > sma20 | OHLCV | short |
| F04 | close > open; close crossed above sma20; sma50 < sma20 | OHLCV | long |
| F05 | relvol > 0.75; close ≤ open −1%; 4-wk perf < 0; close < sma20 | OHLCV | short |
| F06 | relvol > 0.75; close ≥ open +1%; 4-wk perf > 0; close > sma20 | OHLCV | long |
| F07 | relvol > 1.5; short float > 20% | short interest (live only) | both |
| F08 | close ≤ open −2%; new 20-day low | OHLCV | short |
| F09 | close ≤ open −2%; new 20-day low; close < sma20 | OHLCV | short |
| F10 | close ≤ open −2%; close < sma20 | OHLCV | short |
| F11 | close ≤ open −2% | OHLCV | short |
| F12 | close ≤ open −2%; 4-wk perf < 0; 1-wk perf < 0 | OHLCV | short |
| F13 | relvol > 0.75; close < open; new 20-day low | OHLCV | short |
| F14 | close ≥ open +2%; 4-wk perf < 0; close < sma20; close < sma50 | OHLCV | short |
| F15 | close ≤ open −2%; 4-wk perf < 0; close < sma20; close < sma50 | OHLCV | short |
| F16 | short float > 20% | short interest (live only) | both |
| F17 | short float > 20%; 1-wk perf > 0; 4-wk perf > 0 | short interest (live only) | both |
| F18 | short float > 20%; close > sma20; close > sma50 | short interest (live only) | both |
| F19 | short float > 20%; new 20-day high | short interest (live only) | both |
| F20 | close ≥ open +2%; 4-wk perf > 0; close > sma20; close > sma50 | OHLCV | long |
| F21 | close ≤ open −2%; 4-wk perf > 0; close > sma20; close > sma50 | OHLCV | long |
| F22 | relvol > 0.75; close > open; new 20-day high | OHLCV | long |
| F23 | close ≥ open +2%; 4-wk perf > 0; 1-wk perf > 0 | OHLCV | long |
| F24 | close ≥ open +2%; new 20-day high; close > sma20 | OHLCV | long |
| F25 | close > prior close; close ≥ open +2%; new 20-day high | OHLCV | long |
| F26 | close ≥ open +2%; close > sma20 | OHLCV | long |
| F27 | close ≥ open +2% | OHLCV | long |
| F28 | relvol > 2 | OHLCV | both |

## Appendix: raw Finviz filters
```
f=earningsdate_prevdays5,sh_avgvol_o2000,ta_averagetruerange_o1.5&o=sector
f=earningsdate_yesterday,sh_avgvol_o2000,ta_averagetruerange_o1.5&o=sector
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_d,ta_sma20_pcb,ta_sma50_sa20&ft=4&o=-change
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_u,ta_sma20_pca,ta_sma50_sb20&ft=4&o=-change
f=sh_avgvol_o2000,sh_relvol_o0.75,ta_averagetruerange_o1.5,ta_changeopen_d1,ta_perf_4wdown,ta_sma20_pb&ft=4&o=sector
f=sh_avgvol_o2000,sh_relvol_o0.75,ta_averagetruerange_o1.5,ta_changeopen_u1,ta_perf_4wup,ta_sma20_pa&ft=4&o=sector
f=sh_avgvol_o2000,sh_relvol_o1.5,sh_short_high,ta_averagetruerange_o1.5&ft=4&o=sector
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_d2,ta_highlow20d_nl&ft=4&o=-change
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_d2,ta_highlow20d_nl,ta_sma20_pb&ft=4&o=-perf4w
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_d2,ta_sma20_pb&ft=4&o=-change
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_d2&ft=4&o=-change
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_d2,ta_perf_4wdown,ta_perf2_1wdown&ft=4&o=-perf4w
f=sh_avgvol_o2000,sh_relvol_o0.75,ta_averagetruerange_o1.5,ta_changeopen_d,ta_highlow20d_nl&ft=4
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_u2,ta_perf_4wdown,ta_sma20_pb,ta_sma50_pb&ft=4
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_d2,ta_perf_4wdown,ta_sma20_pb,ta_sma50_pb&ft=4
f=sh_avgvol_o2000,sh_short_high,ta_averagetruerange_o1.5&ft=4&o=sector
f=sh_avgvol_o2000,sh_short_high,ta_averagetruerange_o1.5,ta_perf_1wup,ta_perf2_4wup&ft=4&o=sector
f=sh_avgvol_o2000,sh_short_high,ta_averagetruerange_o1.5,ta_sma20_pa,ta_sma50_pa&ft=4&o=sector
f=sh_avgvol_o2000,sh_short_high,ta_averagetruerange_o1.5,ta_highlow20d_nh&ft=4&o=sector
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_u2,ta_perf_4wup,ta_sma20_pa,ta_sma50_pa&ft=4&o=-perf4w
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_d2,ta_perf_4wup,ta_sma20_pa,ta_sma50_pa&ft=4&o=-perf4w
f=sh_avgvol_o2000,sh_relvol_o0.75,ta_averagetruerange_o1.5,ta_changeopen_u,ta_highlow20d_nh&ft=4
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_u2,ta_perf_4wup,ta_perf2_1wup&ft=4&o=-perf4w
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_u2,ta_highlow20d_nh,ta_sma20_pa&ft=4&o=-perf4w
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_change_u,ta_changeopen_u2,ta_highlow20d_nh&ft=4&o=-change
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_u2,ta_sma20_pa&ft=4&o=-change
f=sh_avgvol_o2000,ta_averagetruerange_o1.5,ta_changeopen_u2&ft=4&o=-change
f=sh_avgvol_o2000,sh_relvol_o2,ta_averagetruerange_o1.5&ft=4&o=-change
```
