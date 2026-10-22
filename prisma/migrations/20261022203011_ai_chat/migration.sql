-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "aiPerUserLimit" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "mainChatChannelId" TEXT;

-- CreateTable
CREATE TABLE "AiProvider" (
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "keyEnvVar" TEXT NOT NULL,
    "dailyCap" INTEGER NOT NULL,
    "resetTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "order" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cooldownUntil" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "AiProvider_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "provider" TEXT NOT NULL,
    "providerDay" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("provider","providerDay")
);
