-- PR 1f (docs/PLAN.md): sector and industry rotation per scan, log only. Additive: one nullable JSONB column.
-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "sectorRotation" JSONB;

