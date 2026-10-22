-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "badgesSeeded" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Badge" (
    "id" SERIAL NOT NULL,
    "weeks" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "roleId" TEXT,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBadge" (
    "userId" TEXT NOT NULL,
    "badgeId" INTEGER NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("userId","badgeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Badge_weeks_key" ON "Badge"("weeks");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_name_key" ON "Badge"("name");

-- CreateIndex
CREATE INDEX "UserBadge_awardedAt_idx" ON "UserBadge"("awardedAt");

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
