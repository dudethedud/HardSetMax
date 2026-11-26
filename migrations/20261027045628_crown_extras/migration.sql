-- AlterTable
ALTER TABLE "CrownHolder" ADD COLUMN     "mood" TEXT,
ADD COLUMN     "pardonAt" TIMESTAMP(3),
ADD COLUMN     "pardonUsed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pardonUserId" TEXT,
ADD COLUMN     "rainbowAt" TIMESTAMP(3),
ADD COLUMN     "spotlightAt" TIMESTAMP(3),
ADD COLUMN     "spotlightId" TEXT,
ADD COLUMN     "spotlightReason" TEXT,
ADD COLUMN     "theme" TEXT;

-- CreateTable
CREATE TABLE "SpeechFilter" (
    "targetId" TEXT NOT NULL,
    "byId" TEXT NOT NULL,
    "byCrown" BOOLEAN NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpeechFilter_pkey" PRIMARY KEY ("targetId")
);
