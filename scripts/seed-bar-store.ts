// P3-0i2b: seed the persistent bar store from the P3-0g backfill chart cache. Copies
// scripts/output/backfill-bars/*.json into data/bar-store/ (or BAR_STORE_DIR), skipping symbols
// already present, so it's safe to rerun. Run once on the NAS:
//   docker compose --profile harvest run --rm -v "$PWD/scripts/output:/app/scripts/output" \
//     harvester npx tsx scripts/seed-bar-store.ts

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BAR_STORE_DIR } from "@/lib/harvester/universe/bar-store-fs";

const SRC = "scripts/output/backfill-bars";

export function seedBarStore(src = SRC, dest = process.env.BAR_STORE_DIR || DEFAULT_BAR_STORE_DIR): { copied: number; skipped: number } {
  if (!existsSync(src)) throw new Error(`${src} not found: run scripts/backfill-snapshot.ts first`);
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const f of readdirSync(src).filter((x) => x.endsWith(".json"))) {
    if (existsSync(join(dest, f))) {
      skipped++;
      continue;
    }
    copyFileSync(join(src, f), join(dest, f));
    copied++;
  }
  return { copied, skipped };
}

if (process.argv[1]?.endsWith("seed-bar-store.ts")) {
  try {
    const r = seedBarStore();
    console.log(`[bar-store] seeded ${r.copied} symbols, ${r.skipped} already present`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
