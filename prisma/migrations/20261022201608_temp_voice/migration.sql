-- CreateTable
CREATE TABLE "TempVoiceChannel" (
    "channelId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emptySince" TIMESTAMP(3),

    CONSTRAINT "TempVoiceChannel_pkey" PRIMARY KEY ("channelId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TempVoiceChannel_ownerId_key" ON "TempVoiceChannel"("ownerId");
