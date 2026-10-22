-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "coloursSeeded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pollsChannelId" TEXT,
ADD COLUMN     "pollsDailyCap" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "pollsRoleId" TEXT;

-- CreateTable
CREATE TABLE "ColourOption" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "hex" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "roleId" TEXT,

    CONSTRAINT "ColourOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserColourChoice" (
    "userId" TEXT NOT NULL,
    "optionId" INTEGER NOT NULL,

    CONSTRAINT "UserColourChoice_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PollPost" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "serverDay" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PollLock" (
    "id" SERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "serverDay" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ColourOption_name_key" ON "ColourOption"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PollPost_messageId_key" ON "PollPost"("messageId");

-- CreateIndex
CREATE INDEX "PollPost_serverDay_idx" ON "PollPost"("serverDay");

-- CreateIndex
CREATE UNIQUE INDEX "PollLock_scope_targetId_key" ON "PollLock"("scope", "targetId");

-- AddForeignKey
ALTER TABLE "UserColourChoice" ADD CONSTRAINT "UserColourChoice_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ColourOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
