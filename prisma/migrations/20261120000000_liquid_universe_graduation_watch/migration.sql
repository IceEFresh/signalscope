-- PR 1-0 (docs/PLAN.md): liquid, volatile universe and graduation watch.
-- Additive only: one enum value, nullable columns, three new tables.
-- AlterEnum
ALTER TYPE "SignalSource" ADD VALUE 'GRADUATION';

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "universeId" TEXT;

-- AlterTable
ALTER TABLE "ValidatedTicker" ADD COLUMN     "atrPct" DOUBLE PRECISION,
ADD COLUMN     "dollarVolume20d" DOUBLE PRECISION,
ADD COLUMN     "filterReason" TEXT,
ADD COLUMN     "inUniverse" BOOLEAN;

-- CreateTable
CREATE TABLE "Universe" (
    "id" TEXT NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rule" JSONB NOT NULL,
    "directoryCount" INTEGER NOT NULL,
    "prefilterCount" INTEGER NOT NULL,
    "memberCount" INTEGER NOT NULL,

    CONSTRAINT "Universe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UniverseMember" (
    "id" TEXT NOT NULL,
    "universeId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "marketCap" DOUBLE PRECISION,
    "dollarVolume20d" DOUBLE PRECISION,
    "atrPct" DOUBLE PRECISION,
    "hv20" DOUBLE PRECISION,
    "hasOptions" BOOLEAN NOT NULL,

    CONSTRAINT "UniverseMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraduationWatch" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "firstFiledAt" TIMESTAMP(3) NOT NULL,
    "lastFiledAt" TIMESTAMP(3) NOT NULL,
    "actorNames" TEXT[],
    "actorRoles" TEXT[],
    "filingKeys" TEXT[],
    "totalValue" DOUBLE PRECISION,
    "filingCount" INTEGER NOT NULL DEFAULT 0,
    "isCluster" BOOLEAN NOT NULL DEFAULT false,
    "reportingGapDays" INTEGER,
    "politicianOwner" TEXT,
    "committees" TEXT[],
    "insiderClass" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "failingCriteria" TEXT[],
    "graduatedAt" TIMESTAMP(3),
    "graduatedScanId" TEXT,
    "flippedCriteria" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraduationWatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Universe_refreshedAt_idx" ON "Universe"("refreshedAt");

-- CreateIndex
CREATE INDEX "UniverseMember_symbol_idx" ON "UniverseMember"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "UniverseMember_universeId_symbol_key" ON "UniverseMember"("universeId", "symbol");

-- CreateIndex
CREATE INDEX "GraduationWatch_symbol_source_idx" ON "GraduationWatch"("symbol", "source");

-- CreateIndex
CREATE INDEX "GraduationWatch_expiresAt_idx" ON "GraduationWatch"("expiresAt");

-- CreateIndex
CREATE INDEX "GraduationWatch_graduatedAt_idx" ON "GraduationWatch"("graduatedAt");

-- AddForeignKey
ALTER TABLE "UniverseMember" ADD CONSTRAINT "UniverseMember_universeId_fkey" FOREIGN KEY ("universeId") REFERENCES "Universe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

