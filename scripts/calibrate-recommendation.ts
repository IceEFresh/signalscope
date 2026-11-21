// One-shot calibration: for each candidate recommendation rule, compute
// hit-rate and mean realized 3d/7d return on the last 90d of TickerPerformance.
// Run: npx tsx scripts/calibrate-recommendation.ts

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import type { TickerStage } from "@/generated/prisma/client";
import {
  HARD_CATALYST_SOURCES,
  RECOMMENDATION_RULE_PATHS,
  type RecommendationInput,
} from "@/lib/harvester/recommendation";
import { politicianAblation } from "@/lib/harvester/politician-features";
import type { Source } from "@/lib/harvester/types";

interface Row {
  symbol: string;
  aiScore: number;
  stage: string;
  sourceCount: number;
  hasCatalystSource: boolean;
  /** Hard-catalyst sources present (PLAN.md 2b ablation). */
  catalystSources: Set<Source>;
  pndFlagged: boolean;
  price: number | null;
  medianSignalAgeHrs: number | null;
  return3d: number | null;
  return7d: number | null;
}

function rowToInput(r: Row): RecommendationInput {
  return {
    aiScore: r.aiScore,
    stage: r.stage as TickerStage,
    sourceCount: r.sourceCount,
    hasCatalystSource: r.hasCatalystSource,
    pndFlagged: r.pndFlagged,
    price: r.price,
    medianSignalAgeHrs: r.medianSignalAgeHrs,
  };
}

async function main() {
  const since = new Date(Date.now() - 90 * 86400000);

  const perf = await prisma.tickerPerformance.findMany({
    where: {
      createdAt: { gte: since },
      corporateActionDetected: false,
    },
    select: {
      return3d: true,
      return7d: true,
      validatedTicker: {
        select: {
          symbol: true,
          scanId: true,
          aiScore: true,
          stage: true,
          sourceCount: true,
          pndFlagged: true,
          price: true,
          medianSignalAgeHrs: true,
        },
      },
    },
  });

  const vtPairs = perf
    .map((p) => p.validatedTicker)
    .filter((vt): vt is NonNullable<typeof vt> => vt !== null);
  const scanIds = [...new Set(vtPairs.map((vt) => vt.scanId))];
  const symbols = [...new Set(vtPairs.map((vt) => vt.symbol))];

  console.log(`Joining signals across ${scanIds.length} scans, ${symbols.length} symbols…`);
  const sigs = await prisma.signal.findMany({
    where: {
      scanId: { in: scanIds },
      symbol: { in: symbols },
      source: { in: [...HARD_CATALYST_SOURCES] },
    },
    select: { scanId: true, symbol: true, source: true },
  });
  const catalystKeys = new Set<string>();
  const catalystSources = new Map<string, Set<Source>>();
  for (const s of sigs) {
    if (!HARD_CATALYST_SOURCES.has(s.source)) continue;
    const key = `${s.scanId}|${s.symbol}`;
    catalystKeys.add(key);
    if (!catalystSources.has(key)) catalystSources.set(key, new Set());
    catalystSources.get(key)!.add(s.source);
  }

  const rows: Row[] = perf
    .filter((p) => p.validatedTicker !== null)
    .map((p) => {
      const vt = p.validatedTicker!;
      return {
        symbol: vt.symbol,
        aiScore: vt.aiScore ?? 0,
        stage: vt.stage,
        sourceCount: vt.sourceCount ?? 0,
        hasCatalystSource: catalystKeys.has(`${vt.scanId}|${vt.symbol}`),
        catalystSources: catalystSources.get(`${vt.scanId}|${vt.symbol}`) ?? new Set<Source>(),
        pndFlagged: vt.pndFlagged ?? false,
        price: vt.price,
        medianSignalAgeHrs: vt.medianSignalAgeHrs,
        return3d: p.return3d,
        return7d: p.return7d,
      };
    });

  console.log(`\nLoaded ${rows.length} performance rows (last 90d, no corp actions).\n`);

  function evaluate(label: string, predicate: (r: Row) => boolean) {
    const matched = rows.filter(predicate);
    const with3d = matched.filter((r) => r.return3d !== null);
    const with7d = matched.filter((r) => r.return7d !== null);
    const mean3d = with3d.length ? with3d.reduce((s, r) => s + (r.return3d as number), 0) / with3d.length : 0;
    const mean7d = with7d.length ? with7d.reduce((s, r) => s + (r.return7d as number), 0) / with7d.length : 0;
    const hit3d = with3d.length ? with3d.filter((r) => (r.return3d as number) > 0).length / with3d.length : 0;
    const hit7d = with7d.length ? with7d.filter((r) => (r.return7d as number) > 0).length / with7d.length : 0;
    console.log(
      `${label.padEnd(50)} n=${String(matched.length).padStart(5)}  ` +
        `mean3d=${(mean3d * 100).toFixed(2).padStart(7)}%  hit3d=${(hit3d * 100).toFixed(1).padStart(5)}%  ` +
        `mean7d=${(mean7d * 100).toFixed(2).padStart(7)}%  hit7d=${(hit7d * 100).toFixed(1).padStart(5)}%`
    );
  }

  const isEmerging = (r: Row) => r.stage === "EARLY" || r.stage === "FORMING";
  const signalsFresh = (r: Row) =>
    r.medianSignalAgeHrs === null || r.medianSignalAgeHrs <= 6;

  console.log("== Locked v2 rules (from RECOMMENDATION_RULE_PATHS) ==");
  for (const rule of RECOMMENDATION_RULE_PATHS) {
    evaluate(rule.label, (r) => rule.match(rowToInput(r)));
  }

  console.log("\n== Strong Buy candidates (exploratory — EARLY paths rejected in v2) ==");
  evaluate("EARLY + catalyst + src>=2 + score>=70", (r) =>
    r.stage === "EARLY" && r.hasCatalystSource && r.sourceCount >= 2 && r.aiScore >= 70
  );
  evaluate("EARLY + catalyst + src>=2 + score>=65", (r) =>
    r.stage === "EARLY" && r.hasCatalystSource && r.sourceCount >= 2 && r.aiScore >= 65
  );
  evaluate("EARLY + catalyst + score>=70", (r) =>
    r.stage === "EARLY" && r.hasCatalystSource && r.aiScore >= 70
  );
  evaluate("EARLY + catalyst + score>=65", (r) =>
    r.stage === "EARLY" && r.hasCatalystSource && r.aiScore >= 65
  );
  evaluate("EARLY + score>=75", (r) => r.stage === "EARLY" && r.aiScore >= 75);
  evaluate("EARLY + score>=80", (r) => r.stage === "EARLY" && r.aiScore >= 80);
  evaluate("EARLY + catalyst + src>=2 + score>=70 + FRESH", (r) =>
    r.stage === "EARLY" && r.hasCatalystSource && r.sourceCount >= 2 && r.aiScore >= 70 && signalsFresh(r)
  );

  console.log("\n== Buy candidates (EARLY + FORMING) ==");
  evaluate("EARLY/FORMING + catalyst + src>=2 + score>=55", (r) =>
    isEmerging(r) && r.hasCatalystSource && r.sourceCount >= 2 && r.aiScore >= 55
  );
  evaluate("EARLY/FORMING + catalyst + src>=2 + score>=60", (r) =>
    isEmerging(r) && r.hasCatalystSource && r.sourceCount >= 2 && r.aiScore >= 60
  );
  evaluate("EARLY/FORMING + catalyst + score>=55", (r) =>
    isEmerging(r) && r.hasCatalystSource && r.aiScore >= 55
  );
  evaluate("EARLY/FORMING + catalyst + score>=60", (r) =>
    isEmerging(r) && r.hasCatalystSource && r.aiScore >= 60
  );
  evaluate("EARLY/FORMING + src>=2 + score>=60", (r) =>
    isEmerging(r) && r.sourceCount >= 2 && r.aiScore >= 60
  );
  evaluate("EARLY/FORMING + src>=2 + score>=65", (r) =>
    isEmerging(r) && r.sourceCount >= 2 && r.aiScore >= 65
  );
  evaluate("EARLY/FORMING + score>=65", (r) => isEmerging(r) && r.aiScore >= 65);
  evaluate("EARLY/FORMING + score>=70", (r) => isEmerging(r) && r.aiScore >= 70);
  evaluate("FORMING + src>=2 + score>=60", (r) => r.stage === "FORMING" && r.sourceCount >= 2 && r.aiScore >= 60);
  evaluate("FORMING + score>=60", (r) => r.stage === "FORMING" && r.aiScore >= 60);
  evaluate("EARLY + score>=60", (r) => r.stage === "EARLY" && r.aiScore >= 60);
  evaluate("EARLY + score>=65", (r) => r.stage === "EARLY" && r.aiScore >= 65);

  console.log("\n== Buy (CONFIRMED soft-demotion, freshness-gated) ==");
  evaluate("CONFIRMED + score>=60 + FRESH", (r) =>
    r.stage === "CONFIRMED" && r.aiScore >= 60 && signalsFresh(r)
  );
  evaluate("CONFIRMED + score>=65 + FRESH", (r) =>
    r.stage === "CONFIRMED" && r.aiScore >= 65 && signalsFresh(r)
  );
  evaluate("CONFIRMED + catalyst + src>=2 + score>=60 + FRESH", (r) =>
    r.stage === "CONFIRMED" && r.hasCatalystSource && r.sourceCount >= 2 && r.aiScore >= 60 && signalsFresh(r)
  );
  evaluate("CONFIRMED + score>=60 (no fresh gate)", (r) => r.stage === "CONFIRMED" && r.aiScore >= 60);
  evaluate("CONFIRMED + score>=65 (no fresh gate)", (r) => r.stage === "CONFIRMED" && r.aiScore >= 65);

  console.log("\n== Avoid candidates ==");
  evaluate("pndFlagged=true", (r) => r.pndFlagged);
  evaluate("price < $0.12", (r) => r.price !== null && r.price < 0.12);
  evaluate("score < 20 + no catalyst", (r) => r.aiScore < 20 && !r.hasCatalystSource);
  evaluate("score < 25 + no catalyst", (r) => r.aiScore < 25 && !r.hasCatalystSource);

  console.log("\n== Baseline ==");
  evaluate("ALL rows", () => true);
  evaluate("EARLY stage", (r) => r.stage === "EARLY");
  evaluate("FORMING stage", (r) => r.stage === "FORMING");
  evaluate("CONFIRMED stage", (r) => r.stage === "CONFIRMED");
  evaluate("EARLY/FORMING combined", isEmerging);
  evaluate("EARLY + catalyst", (r) => r.stage === "EARLY" && r.hasCatalystSource);
  evaluate("FORMING + catalyst", (r) => r.stage === "FORMING" && r.hasCatalystSource);

  // PLAN.md 2b: what changes if elected-politician trades (source CONGRESS) stop counting as a hard catalyst.
  // Not applied anywhere; run this, then log the result in scripts/backtesting-experiments.md.
  console.log("\n== 2b ablation: elected politicians (CONGRESS) removed from HARD_CATALYST_SOURCES ==");
  const ablated = rows.map((r) => ({ r, a: politicianAblation({ input: rowToInput(r), sources: r.catalystSources }) }));
  const politicianOnly = (r: Row) => r.catalystSources.has("CONGRESS") && r.catalystSources.size === 1;
  evaluate("Elected politician present", (r) => r.catalystSources.has("CONGRESS"));
  evaluate("Elected politician is the only hard catalyst", politicianOnly);
  evaluate("Other hard catalyst, no politician", (r) => r.hasCatalystSource && !r.catalystSources.has("CONGRESS"));
  for (const variant of ["withoutPoliticianRules", "withoutPoliticianRulesAndCap"] as const) {
    const changed = ablated.filter(({ a }) => a[variant] !== a.current);
    console.log(`\n-- ${variant}: ${changed.length} of ${rows.length} rows change recommendation --`);
    const transitions = new Map<string, number>();
    for (const { a } of changed) {
      const k = `${a.current} -> ${a[variant]}`;
      transitions.set(k, (transitions.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...transitions.entries()].sort((x, y) => y[1] - x[1])) console.log(`   ${k.padEnd(24)} n=${n}`);
    for (const rec of ["Strong Buy", "Buy"] as const) {
      const set = new Set(ablated.filter(({ a }) => a[variant] === rec).map(({ r }) => r));
      const before = new Set(ablated.filter(({ a }) => a.current === rec).map(({ r }) => r));
      evaluate(`${rec} today`, (r) => before.has(r));
      evaluate(`${rec} after ${variant}`, (r) => set.has(r));
      evaluate(`${rec} today, lost after ${variant}`, (r) => before.has(r) && !set.has(r));
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
