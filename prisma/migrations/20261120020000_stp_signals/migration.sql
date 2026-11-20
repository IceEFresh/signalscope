-- PR 1g (docs/PLAN.md, docs/STP-SIGNALS.md): STP daily signals, log only. Additive: one new table.
-- CreateTable
CREATE TABLE "StpSignal" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "inUniverse" BOOLEAN,
    "barDate" TEXT,
    "htfOpens" DOUBLE PRECISION,
    "maState" INTEGER,
    "wellBid" INTEGER,
    "sizeFactor" DOUBLE PRECISION,
    "trigger" INTEGER,
    "triggerType" TEXT,
    "firedRules" TEXT[],
    "atr14" DOUBLE PRECISION,
    "fudge" DOUBLE PRECISION,
    "entry" DOUBLE PRECISION,
    "stop" DOUBLE PRECISION,
    "risk" DOUBLE PRECISION,
    "target2R" DOUBLE PRECISION,
    "target3R" DOUBLE PRECISION,
    "addLevel2R" DOUBLE PRECISION,
    "addLevel3R" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StpSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StpSignal_symbol_idx" ON "StpSignal"("symbol");

-- CreateIndex
CREATE INDEX "StpSignal_trigger_idx" ON "StpSignal"("trigger");

-- CreateIndex
CREATE UNIQUE INDEX "StpSignal_scanId_symbol_key" ON "StpSignal"("scanId", "symbol");

-- AddForeignKey
ALTER TABLE "StpSignal" ADD CONSTRAINT "StpSignal_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

