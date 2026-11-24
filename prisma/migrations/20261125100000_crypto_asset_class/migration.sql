-- P3-0e: liquid crypto universe, log only. Additive: nullable columns, no default.
-- Null means a stock (rows written before P3-0e); new rows write "stock" or "crypto".
ALTER TABLE "UniverseMember" ADD COLUMN "assetClass" TEXT;
ALTER TABLE "UniverseMember" ADD COLUMN "coingeckoId" TEXT;
ALTER TABLE "UniverseSnapshot" ADD COLUMN "assetClass" TEXT;
