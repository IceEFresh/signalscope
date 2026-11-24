-- CreateTable
CREATE TABLE "UniverseSnapshot" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "sessionDate" TEXT NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "features" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UniverseSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UniverseSnapshot_symbol_sessionDate_idx" ON "UniverseSnapshot"("symbol", "sessionDate");

-- CreateIndex
CREATE UNIQUE INDEX "UniverseSnapshot_scanId_symbol_key" ON "UniverseSnapshot"("scanId", "symbol");

-- AddForeignKey
ALTER TABLE "UniverseSnapshot" ADD CONSTRAINT "UniverseSnapshot_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

