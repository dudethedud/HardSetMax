-- CreateTable
CREATE TABLE "InviteEventState" (
    "guildId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "frozenAt" TIMESTAMP(3),
    "frozenPostedAt" TIMESTAMP(3),
    "finalPostedAt" TIMESTAMP(3),
    "weeklyPosts" INTEGER NOT NULL DEFAULT 0,
    "lastWeeklyDay" TEXT,
    "lastEvaluatedAt" TIMESTAMP(3),
    "snapshotDone" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "InviteEventState_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "InviteJoin" (
    "id" SERIAL NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "inviteeName" TEXT NOT NULL,
    "inviterId" TEXT,
    "inviteCode" TEXT,
    "source" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "leftAt" TIMESTAMP(3),
    "accountCreatedAt" TIMESTAMP(3) NOT NULL,
    "defaultAvatar" BOOLEAN NOT NULL DEFAULT false,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "rejoin" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invalidReason" TEXT,
    "validatedAt" TIMESTAMP(3),
    "overrideStatus" TEXT,
    "overrideReason" TEXT,
    "overrideBy" TEXT,

    CONSTRAINT "InviteJoin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalInvite" (
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalInvite_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "KnownMember" (
    "userId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "KnownMember_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "DisqualifiedInviter" (
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisqualifiedInviter_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "InviteFlag" (
    "key" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "inviteeIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteFlag_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "InviteJoin_inviteeId_key" ON "InviteJoin"("inviteeId");

-- CreateIndex
CREATE INDEX "InviteJoin_inviterId_idx" ON "InviteJoin"("inviterId");

-- CreateIndex
CREATE INDEX "InviteJoin_joinedAt_idx" ON "InviteJoin"("joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalInvite_userId_key" ON "PersonalInvite"("userId");
