-- CreateTable
CREATE TABLE "Donation" (
    "id" SERIAL NOT NULL,
    "kofiId" TEXT,
    "userId" TEXT,
    "displayName" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DonationCode" (
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DonationCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "DonationSettings" (
    "guildId" TEXT NOT NULL,
    "channelId" TEXT,
    "messageId" TEXT,
    "kofiUrl" TEXT,
    "fundName" TEXT NOT NULL DEFAULT 'Giveaway fund',
    "goalCents" INTEGER,
    "donorRoleId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DonationSettings_pkey" PRIMARY KEY ("guildId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Donation_kofiId_key" ON "Donation"("kofiId");

-- CreateIndex
CREATE INDEX "Donation_createdAt_idx" ON "Donation"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DonationCode_userId_key" ON "DonationCode"("userId");
