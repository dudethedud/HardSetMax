-- CreateTable
CREATE TABLE "MemberActivity" (
    "userId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "lastCheckinAt" TIMESTAMP(3),
    "checkinOptOut" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MemberActivity_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CheckinState" (
    "guildId" TEXT NOT NULL,
    "trackingStartedAt" TIMESTAMP(3) NOT NULL,
    "lastRunDay" TEXT,

    CONSTRAINT "CheckinState_pkey" PRIMARY KEY ("guildId")
);
