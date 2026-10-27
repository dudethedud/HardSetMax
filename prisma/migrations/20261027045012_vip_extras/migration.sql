-- CreateTable
CREATE TABLE "Treat" (
    "giverId" TEXT NOT NULL,
    "serverDay" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Treat_pkey" PRIMARY KEY ("giverId","serverDay")
);

-- CreateTable
CREATE TABLE "ColourRequest" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hex" TEXT NOT NULL,
    "hex2" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageId" TEXT,
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ColourRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Treat_receiverId_createdAt_idx" ON "Treat"("receiverId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ColourRequest_messageId_key" ON "ColourRequest"("messageId");

-- CreateIndex
CREATE INDEX "ColourRequest_userId_createdAt_idx" ON "ColourRequest"("userId", "createdAt");
