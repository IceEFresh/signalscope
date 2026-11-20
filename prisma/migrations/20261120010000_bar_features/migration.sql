-- PR 1a (docs/PLAN.md): bar features, log only. Additive: one nullable JSONB column.
-- AlterTable
ALTER TABLE "ValidatedTicker" ADD COLUMN     "features" JSONB;
