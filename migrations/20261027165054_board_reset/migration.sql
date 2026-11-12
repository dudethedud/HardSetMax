-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "weeklyFrom" TEXT;

-- CreateTable
CREATE TABLE "WeeklyBaseline" (
    "userId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "WeeklyBaseline_pkey" PRIMARY KEY ("userId")
);
