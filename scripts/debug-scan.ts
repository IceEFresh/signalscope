import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

async function main() {
  const scan = await prisma.scan.findFirst({ orderBy: { startedAt: "desc" } });
  if (!scan) { console.log("No scans found"); return; }
  console.log("Scan:", scan.id, scan.startedAt);

  const validated = await prisma.validatedTicker.findMany({ where: { scanId: scan.id } });
  console.log("\n=== Validated Tickers ===");
  console.log("Total:", validated.length);

  const byRecommendation: Record<string, number> = {};
  for (const t of validated) {
    const s = t.recommendation || "unknown";
    byRecommendation[s] = (byRecommendation[s] || 0) + 1;
  }
  console.log("By recommendation:", byRecommendation);

  const byStage: Record<string, number> = {};
  for (const t of validated) {
    const s = t.stage || "unknown";
    byStage[s] = (byStage[s] || 0) + 1;
  }
  console.log("By stage:", byStage);

  // Show avoid tickers with scores
  const avoids = validated.filter((t) => t.recommendation === "Avoid");
  console.log("\n=== Avoid Tickers (" + avoids.length + ") ===");
  for (const t of avoids.sort((a, b) => b.aiScore - a.aiScore)) {
    console.log(
      t.symbol, "| score:", t.aiScore, "| stage:", t.stage,
      "| sources:", t.sourceCount, "| pndFlagged:", t.pndFlagged,
      "| marketCap:", t.marketCap?.toString()
    );
  }

  // Show non-avoid for comparison
  const nonAvoids = validated.filter((t) => t.recommendation !== "Avoid");
  console.log("\n=== Non-Avoid Tickers (" + nonAvoids.length + ") ===");
  for (const t of nonAvoids.sort((a, b) => b.aiScore - a.aiScore)) {
    console.log(
      t.symbol, "| score:", t.aiScore, "| recommendation:", t.recommendation, "| avgSentiment:", t.avgSentiment,
      "| stage:", t.stage, "| sources:", t.sourceCount, "| pndFlagged:", t.pndFlagged
    );
  }

  // Check signal-level details for a few avoid tickers
  if (avoids.length > 0) {
    const sampleSymbols = avoids.slice(0, 3).map((t) => t.symbol);
    console.log("\n=== Sample Avoid Ticker Signals ===");
    for (const sym of sampleSymbols) {
      const signals = await prisma.signal.findMany({
        where: { scanId: scan.id, symbol: sym },
      });
      console.log(`\n${sym} (${signals.length} signals):`);
      for (const s of signals) {
        console.log(
          "  source:", s.source, "| sortType:", s.sortType,
          "| velocity:", s.velocityScore, "| upvotes:", s.upvotes,
          "| comments:", s.commentCount, "| sentiment:", s.sentiment,
          "| pndFlagged:", s.pndFlagged
        );
        if (s.pndFlagged && s.pndFlags) {
          console.log("  pndFlags:", s.pndFlags);
        }
      }
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
