-- AlterTable
ALTER TABLE "CrownHolder" ADD COLUMN     "decreeAt" TIMESTAMP(3),
ADD COLUMN     "nickApplied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nickBefore" TEXT;

-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "vipBoardChannelId" TEXT;

-- CreateTable
CREATE TABLE "CrownTitle" (
    "slot" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleId" TEXT,
    "holderId" TEXT,
    "appointedAt" TIMESTAMP(3),

    CONSTRAINT "CrownTitle_pkey" PRIMARY KEY ("slot")
);

-- CreateTable
CREATE TABLE "Shoutout" (
    "userId" TEXT NOT NULL,
    "serverDay" TEXT NOT NULL,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shoutout_pkey" PRIMARY KEY ("userId","serverDay")
);
