/**
 * P3-0l descriptive backfill: volume spike → an STP trigger in the spike's direction with R/R ≥ 3
 * within 10 sessions (docs/PHASE3-PREP.md §P3-0l). Not pre-registered: descriptive until P3-0k
 * has run. Only volume spikes have price history; the other watch sources are judged after 6
 * months of live data.
 */
import type { DailyBar } from "@/lib/harvester/universe/bar-metrics";
import { WATCH_SESSIONS } from "@/lib/harvester/watchlist";
import { RR_MIN } from "./funnel";
import type { Dir } from "./stp-sim";
import type { P3kCandidate } from "./aligned-sim";
import type { Candidate, Population } from "./funnel-sim";

/** Same threshold as the live source (volume-spike.ts): volume ≥ 2 × the average. */
export const SPIKE_RATIO = 2;
/** Average over the 10 sessions before the bar (the live source averages a ~15-calendar-day window). */
export const SPIKE_LOOKBACK = 10;

export interface Spike {
  i: number;
  dir: Dir | null;
  ratio: number;
}

/** Volume spikes on completed bars: volume[i] ≥ 2 × mean(volume[i−10 … i−1]); direction from the close vs the prior close. */
export function volumeSpikes(bars: readonly DailyBar[], ratio = SPIKE_RATIO, lookback = SPIKE_LOOKBACK): Spike[] {
  const out: Spike[] = [];
  for (let i = lookback; i < bars.length; i++) {
    const prev = bars.slice(i - lookback, i).map((b) => b.volume ?? 0);
    const avg = prev.reduce((s, v) => s + v, 0) / lookback;
    const v = bars[i].volume ?? 0;
    if (!(avg > 0) || v / avg < ratio) continue;
    const m = bars[i].close - bars[i - 1].close;
    out.push({ i, dir: m > 0 ? 1 : m < 0 ? -1 : null, ratio: v / avg });
  }
  return out;
}

/** The spike a trigger follows: same direction, trigger 0–10 sessions after the spike bar (the latest such spike). */
export function spikeFor(c: { setup: { i: number }; dir: Dir }, spikes: readonly Spike[]): Spike | null {
  let best: Spike | null = null;
  for (const s of spikes) {
    const d = c.setup.i - s.i;
    if (d >= 0 && d <= WATCH_SESSIONS && s.dir === c.dir && (!best || s.i > best.i)) best = s;
  }
  return best;
}

/** Membership for the two descriptive populations (the spike map is set per symbol). */
export function watchMember(population: Extract<Population, `watch_${string}`>, spikes: readonly Spike[]) {
  return (c: Candidate) => {
    if (!spikeFor(c as P3kCandidate, spikes)) return false;
    return population === "watch_volume_any" || (c.rr.rr != null && c.rr.rr >= RR_MIN);
  };
}

const r3 = (v: number | null) => (v == null ? "n/a" : v.toFixed(3));
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);

/** Descriptive report section for the volume-spike watch backfill. */
export function watchVolumeLines(trades: readonly import("./funnel-sim").FunnelTrade[], spikes: number, metrics: typeof import("./stp-sim").groupMetrics): string[] {
  const row = (label: string, ts: readonly import("./funnel-sim").FunnelTrade[]) => {
    const m = metrics(ts);
    return `| ${label} | ${m.trades} | ${r3(m.expectancy)} | ${pct(m.winRate)} | ${pct(m.reached3RRate)} | ${m.controls} | ${r3(m.controlExpectancy)} |`;
  };
  const ready = trades.filter((t) => t.population === "watch_volume" && t.arm === "stop");
  const any = trades.filter((t) => t.population === "watch_volume_any" && t.arm === "stop");
  return [
    `## Watchlist backfill (P3-0l, descriptive): volume spike → STP trigger within ${WATCH_SESSIONS} sessions`,
    "",
    `${spikes} volume spikes (volume ≥ ${SPIKE_RATIO} × the prior ${SPIKE_LOOKBACK}-session average; direction from the day's close). A trigger in the spike's direction 0–${WATCH_SESSIONS} sessions later, any STP type (calendar or rolling); no Finviz, alignment or opens gate; P3-0k layer sizing; exit B with the event and earnings rules; stop entry; after-trigger control. Not pre-registered.`,
    "",
    "| group | trades | net exp R | win | reached 3R | controls | control exp R |",
    "|---|---|---|---|---|---|---|",
    row("entry ready: R/R ≥ 3 (watch_entry_ready)", ready),
    row("any trigger after a spike (no R/R gate)", any),
    ...[1, 0.5, 0.25].map((s) => row(`entry ready, layer size ${s}`, ready.filter((t) => t.p3kLayerSize === s))),
    row("entry ready, long", ready.filter((t) => t.dir === 1)),
    row("entry ready, short", ready.filter((t) => t.dir === -1)),
    "",
  ];
}
