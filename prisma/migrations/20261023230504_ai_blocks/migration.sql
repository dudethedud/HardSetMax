-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "aiStrikeLimit" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "AiBlock" (
    "userId" TEXT NOT NULL,
    "auto" BOOLEAN NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiBlock_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AiStrike" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiStrike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiStrike_userId_at_idx" ON "AiStrike"("userId", "at");
