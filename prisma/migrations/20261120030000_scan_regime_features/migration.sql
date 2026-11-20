-- PR 1c (docs/PLAN.md): market regime fields per scan, log only. Additive: one nullable JSONB column.
-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "regimeFeatures" JSONB;

