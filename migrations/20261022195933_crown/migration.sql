-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "crownColour" TEXT NOT NULL DEFAULT '#FF00C8',
ADD COLUMN     "crownRoleId" TEXT;

-- CreateTable
CREATE TABLE "CrownHolder" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "CrownHolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomRole" (
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hex" TEXT NOT NULL,
    "emoji" TEXT,
    "roleId" TEXT,
    "editsWeek" TEXT,
    "editsCount" INTEGER NOT NULL DEFAULT 0,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomRole_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "BlockedWord" (
    "word" TEXT NOT NULL,

    CONSTRAINT "BlockedWord_pkey" PRIMARY KEY ("word")
);

-- CreateTable
CREATE TABLE "ModalDraft" (
    "userId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModalDraft_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrownHolder_weekStart_key" ON "CrownHolder"("weekStart");
