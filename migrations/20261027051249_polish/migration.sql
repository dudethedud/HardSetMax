-- CreateTable
CREATE TABLE "SpeechOptOut" (
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpeechOptOut_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "TreatPost" (
    "serverDay" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,

    CONSTRAINT "TreatPost_pkey" PRIMARY KEY ("serverDay")
);
