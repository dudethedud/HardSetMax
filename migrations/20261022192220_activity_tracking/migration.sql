-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "messageCooldownSec" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "minMessageLength" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "spamBurstCount" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "spamBurstMuteMinutes" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "spamBurstSeconds" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "spamMinDistinctChars" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "spamRepeatHistory" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "spamRepeatMinutes" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "spamRepeatSimilarity" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
ADD COLUMN     "timeoutAuditCursor" TEXT,
ADD COLUMN     "voiceDailyCapMinutes" INTEGER NOT NULL DEFAULT 240,
ADD COLUMN     "voiceWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
ADD COLUMN     "windowDays" INTEGER NOT NULL DEFAULT 7;

-- CreateTable
CREATE TABLE "ChannelWeight" (
    "channelId" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelWeight_pkey" PRIMARY KEY ("channelId")
);

-- CreateTable
CREATE TABLE "MemberName" (
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberName_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ActivityDay" (
    "userId" TEXT NOT NULL,
    "serverDay" TEXT NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "weightedMessages" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "voiceMinutes" INTEGER NOT NULL DEFAULT 0,
    "filteredMessages" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActivityDay_pkey" PRIMARY KEY ("userId","serverDay")
);

-- CreateTable
CREATE TABLE "ActivityAdjustment" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "serverDay" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceSession" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "VoiceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeoutEvent" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "TimeoutEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityDay_serverDay_idx" ON "ActivityDay"("serverDay");

-- CreateIndex
CREATE INDEX "ActivityAdjustment_serverDay_idx" ON "ActivityAdjustment"("serverDay");

-- CreateIndex
CREATE INDEX "VoiceSession_endedAt_idx" ON "VoiceSession"("endedAt");

-- CreateIndex
CREATE INDEX "TimeoutEvent_userId_endedAt_idx" ON "TimeoutEvent"("userId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TimeoutEvent_userId_until_key" ON "TimeoutEvent"("userId", "until");
