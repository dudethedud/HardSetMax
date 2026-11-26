-- CreateTable
CREATE TABLE "PerkUse" (
    "userId" TEXT NOT NULL,
    "perk" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerkUse_pkey" PRIMARY KEY ("userId","perk","period")
);

-- CreateTable
CREATE TABLE "BotStatus" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "setById" TEXT NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotStatus_pkey" PRIMARY KEY ("id")
);
