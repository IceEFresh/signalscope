/**
 * Diagnostic: what does `pl` do in the OpenInsider screener URL?
 *
 * Fetches the production screener URL (pl=5 since PR 1-0), the same URL with
 * pl=50 (upstream's value) and with `pl` blank, and prints purchase counts and
 * share-price ranges for each. If the pl=50 run has no purchases under $50
 * while the blank run does, `pl` is a minimum share price. The harvester also
 * drops sub-$5 rows in code, so the floor holds either way.
 *
 * Read-only: no database access, no writes. Needs plain-HTTP access to
 * openinsider.com, so run it on the NAS, not in a cloud sandbox:
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/check-openinsider-pl.ts
 */
import {
  OPENINSIDER_SCREENER_URL,
  parseOpenInsiderHtml,
} from "../src/lib/harvester/sources/sec-insider";

const VARIANTS: Record<string, string> = {
  "pl=5 (production)": OPENINSIDER_SCREENER_URL,
  "pl=50 (upstream)": OPENINSIDER_SCREENER_URL.replace("&pl=5&", "&pl=50&"),
  "pl blank": OPENINSIDER_SCREENER_URL.replace("&pl=5&", "&pl=&"),
};

async function summarize(label: string, url: string): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    console.log(`${label}: HTTP ${res.status}`);
    return;
  }
  const rows = parseOpenInsiderHtml(await res.text());
  const prices = rows.map((r) => r.price);
  const under50 = rows.filter((r) => r.price < 50);
  console.log(
    `${label}: ${rows.length} purchases, price min $${prices.length ? Math.min(...prices) : "-"}, ` +
      `max $${prices.length ? Math.max(...prices) : "-"}, under $50: ${under50.length}`,
  );
  for (const r of under50.slice(0, 5)) {
    console.log(`  ${r.ticker} $${r.price} ${r.insiderTitle} $${r.value.toLocaleString()}`);
  }
}

async function main(): Promise<void> {
  for (const [label, url] of Object.entries(VARIANTS)) {
    try {
      await summarize(label, url);
    } catch (err) {
      console.log(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main();
