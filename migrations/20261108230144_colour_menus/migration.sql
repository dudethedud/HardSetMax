-- Owner-approved rebuild (2026-11-08): the VIP bot was replaced by a colour menu bot.
-- This deliberately drops every table of the old bot. See docs/DECISIONS.md.
/*
  Warnings:

  - You are about to drop the `ActivityAdjustment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ActivityDay` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AiBlock` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AiProvider` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AiStrike` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AiUsage` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AuditLog` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Badge` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `BlockedWord` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `BotStatus` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ChannelWeight` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ColourOption` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ColourRequest` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CrownHolder` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CrownTitle` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CustomRole` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `GuildConfig` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobRun` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `MemberName` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModalDraft` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Panel` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PerkUse` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PollLock` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PollPost` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Shoutout` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SpeechFilter` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SpeechOptOut` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `StaffRole` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TempVoiceChannel` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TimeoutEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Treat` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TreatPost` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserBadge` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserColourChoice` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `VipBlock` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `VipMember` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `VipStint` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `VoiceSession` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WeeklyBaseline` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "UserBadge" DROP CONSTRAINT "UserBadge_badgeId_fkey";

-- DropForeignKey
ALTER TABLE "UserColourChoice" DROP CONSTRAINT "UserColourChoice_optionId_fkey";

-- DropTable
DROP TABLE "ActivityAdjustment";

-- DropTable
DROP TABLE "ActivityDay";

-- DropTable
DROP TABLE "AiBlock";

-- DropTable
DROP TABLE "AiProvider";

-- DropTable
DROP TABLE "AiStrike";

-- DropTable
DROP TABLE "AiUsage";

-- DropTable
DROP TABLE "AuditLog";

-- DropTable
DROP TABLE "Badge";

-- DropTable
DROP TABLE "BlockedWord";

-- DropTable
DROP TABLE "BotStatus";

-- DropTable
DROP TABLE "ChannelWeight";

-- DropTable
DROP TABLE "ColourOption";

-- DropTable
DROP TABLE "ColourRequest";

-- DropTable
DROP TABLE "CrownHolder";

-- DropTable
DROP TABLE "CrownTitle";

-- DropTable
DROP TABLE "CustomRole";

-- DropTable
DROP TABLE "GuildConfig";

-- DropTable
DROP TABLE "JobRun";

-- DropTable
DROP TABLE "MemberName";

-- DropTable
DROP TABLE "ModalDraft";

-- DropTable
DROP TABLE "Panel";

-- DropTable
DROP TABLE "PerkUse";

-- DropTable
DROP TABLE "PollLock";

-- DropTable
DROP TABLE "PollPost";

-- DropTable
DROP TABLE "Shoutout";

-- DropTable
DROP TABLE "SpeechFilter";

-- DropTable
DROP TABLE "SpeechOptOut";

-- DropTable
DROP TABLE "StaffRole";

-- DropTable
DROP TABLE "TempVoiceChannel";

-- DropTable
DROP TABLE "TimeoutEvent";

-- DropTable
DROP TABLE "Treat";

-- DropTable
DROP TABLE "TreatPost";

-- DropTable
DROP TABLE "UserBadge";

-- DropTable
DROP TABLE "UserColourChoice";

-- DropTable
DROP TABLE "VipBlock";

-- DropTable
DROP TABLE "VipMember";

-- DropTable
DROP TABLE "VipStint";

-- DropTable
DROP TABLE "VoiceSession";

-- DropTable
DROP TABLE "WeeklyBaseline";

-- DropEnum
DROP TYPE "JobStatus";

-- CreateTable
CREATE TABLE "Settings" (
    "guildId" TEXT NOT NULL,
    "logChannelId" TEXT,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "UnlockRole" (
    "roleId" TEXT NOT NULL,

    CONSTRAINT "UnlockRole_pkey" PRIMARY KEY ("roleId")
);

-- CreateTable
CREATE TABLE "ColourMenu" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "emoji" TEXT,
    "banner" BYTEA,
    "bannerName" TEXT,
    "position" INTEGER NOT NULL,
    "channelId" TEXT,
    "messageId" TEXT,

    CONSTRAINT "ColourMenu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuColour" (
    "roleId" TEXT NOT NULL,
    "menuId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "MenuColour_pkey" PRIMARY KEY ("roleId")
);

-- CreateIndex
CREATE INDEX "MenuColour_menuId_idx" ON "MenuColour"("menuId");

-- AddForeignKey
ALTER TABLE "MenuColour" ADD CONSTRAINT "MenuColour_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "ColourMenu"("id") ON DELETE CASCADE ON UPDATE CASCADE;
