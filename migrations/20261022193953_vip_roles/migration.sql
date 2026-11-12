-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "announceChannelId" TEXT,
ADD COLUMN     "levelRolesTopId" TEXT,
ADD COLUMN     "loungeCategoryId" TEXT,
ADD COLUMN     "loungeTextId" TEXT,
ADD COLUMN     "loungeVoiceId" TEXT,
ADD COLUMN     "modLogChannelId" TEXT,
ADD COLUMN     "timeoutBlockDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "vipBuffer" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "vipColour" TEXT NOT NULL DEFAULT '#F1C40F',
ADD COLUMN     "vipInactivityDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "vipMinHoldDays" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "vipMinScore" DOUBLE PRECISION NOT NULL DEFAULT 20,
ADD COLUMN     "vipRoleId" TEXT,
ADD COLUMN     "vipSlots" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "VipMember" (
    "userId" TEXT NOT NULL,
    "since" TEXT NOT NULL,
    "sinceAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pinned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VipMember_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "VipStint" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VipStint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VipBlock" (
    "userId" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VipBlock_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "StaffRole" (
    "roleId" TEXT NOT NULL,

    CONSTRAINT "StaffRole_pkey" PRIMARY KEY ("roleId")
);

-- CreateTable
CREATE TABLE "Panel" (
    "kind" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Panel_pkey" PRIMARY KEY ("kind")
);

-- CreateIndex
CREATE INDEX "VipStint_userId_idx" ON "VipStint"("userId");

-- CreateIndex
CREATE INDEX "VipStint_endedAt_idx" ON "VipStint"("endedAt");
